import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PaymentKind, PaymentMethod } from '@prisma/client';
import {
  CheckInDto,
  ErrorCode,
  LedgerEntryType,
  ReservationStatus,
  applyBps,
  formatAed,
  sumFils,
} from '@berelax/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { AuditAction, AuditService, pickAuditFields } from '../common/audit.service';
import type { AuthUser, RequestContext } from '../common/request-context';
import {
  ReservationView,
  apiError,
  businessDayColumn,
  isManagerOrAbove,
  lockReservation,
  presentReservation,
} from './reservations.service';

/**
 * A guest who books for 19:00 does not arrive at 07:00 the next day. Anything
 * outside this window is a typo — most often yesterday's date on a late shift —
 * and a wrong arrival time lands in the wrong trading day's revenue. §8.2.
 */
export const ARRIVAL_WINDOW_MS = 12 * 60 * 60 * 1000;

export interface CheckInView extends ReservationView {
  basePaidFils: number;
  payments: Array<{ id: string; kind: PaymentKind; method: PaymentMethod; amountFils: number }>;
}

/**
 * Step 1 of the two-step financial workflow: the guest arrives, the base service
 * cost is collected UP FRONT, and the treatment starts. The tip is not decided
 * for another 60 or 90 minutes — that is checkout's job. §8.1, §8.2.
 */
@Injectable()
export class CheckInHandler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async checkIn(
    id: string,
    dto: CheckInDto,
    actor: AuthUser,
    ctx: RequestContext,
  ): Promise<CheckInView> {
    return this.prisma.$transaction(async (tx) => {
      // Lock first: two receptionists must not be able to check the same guest
      // in twice and collect the base cost twice.
      const reservation = await lockReservation(tx, id, actor.branchId);

      if (reservation.status !== ReservationStatus.SCHEDULED) {
        throw new ConflictException(
          apiError(
            ErrorCode.RESERVATION_NOT_SCHEDULED,
            'That booking is not waiting to be checked in.',
            { status: reservation.status },
          ),
        );
      }

      // Every line is checked for a positive whole amount BEFORE the total is
      // compared. A negative line would let a short payment reconcile, and a
      // short payment is a discount taken quietly at the desk.
      const badLine = dto.basePayments.findIndex(
        (p) => !Number.isInteger(p.amountFils) || p.amountFils <= 0,
      );
      if (badLine >= 0) {
        throw new UnprocessableEntityException(
          apiError(
            ErrorCode.INVALID_AMOUNT,
            'Every payment line must be a positive whole number of fils.',
            { line: badLine },
          ),
        );
      }

      if (dto.basePayments.some((p) => p.method === PaymentMethod.COMPLIMENTARY)) {
        if (!isManagerOrAbove(actor.role)) {
          throw new ForbiddenException(
            apiError(
              ErrorCode.INSUFFICIENT_ROLE,
              'Only a manager can comp a treatment.',
            ),
          );
        }
        // A comp is the whole bill or it is not a comp. Part-comping is a
        // discount, and a discount is an ADJUSTMENT a manager signs for.
        if (dto.basePayments.length > 1) {
          throw new UnprocessableEntityException(
            apiError(
              ErrorCode.VALIDATION_FAILED,
              'A complimentary treatment cannot be part-paid: the comp must be the only line.',
            ),
          );
        }
      }

      // Split payment is supported because guests genuinely pay part cash, part
      // card. The sum must reconcile EXACTLY — reception does not get to round.
      const receivedFils = sumFils(dto.basePayments.map((p) => p.amountFils));
      if (receivedFils !== reservation.baseCostFils) {
        throw new UnprocessableEntityException(
          apiError(
            ErrorCode.BASE_PAYMENT_MISMATCH,
            `Collected ${formatAed(receivedFils)} but the service costs ${formatAed(reservation.baseCostFils)}.`,
            { expectedFils: reservation.baseCostFils, receivedFils },
          ),
        );
      }

      const arrivedAt = dto.actualArrivalAt ? new Date(dto.actualArrivalAt) : new Date();
      if (Math.abs(arrivedAt.getTime() - reservation.startsAt.getTime()) > ARRIVAL_WINDOW_MS) {
        throw new UnprocessableEntityException(
          apiError(
            ErrorCode.ARRIVAL_TIME_IMPLAUSIBLE,
            'That arrival time is more than twelve hours from the booking. Check the date.',
            {
              startsAt: reservation.startsAt.toISOString(),
              actualArrivalAt: arrivedAt.toISOString(),
              windowHours: ARRIVAL_WINDOW_MS / 3_600_000,
            },
          ),
        );
      }

      // The trading day of the ARRIVAL, not of the booking: a guest who turns up
      // at 01:20 for a midnight slot is still on the previous day's till. §3.3.
      const day = businessDayColumn(arrivedAt);
      const key = ctx.idempotencyKey;

      const payments = await tx.payment.createManyAndReturn({
        data: dto.basePayments.map((p, i) => ({
          branchId: actor.branchId,
          reservationId: reservation.id,
          kind: PaymentKind.BASE,
          method: p.method,
          amountFils: p.amountFils,
          businessDay: day,
          collectedByUserId: actor.id,
          collectedAt: arrivedAt,
          externalRef: p.externalRef ?? null,
          note: dto.note ?? null,
          // A per-line key, so a replay that slips past the interceptor is
          // stopped by the unique index instead of charging the guest twice.
          // Null rather than a literal "undefined:base:0" if the key is missing:
          // a colliding key across unrelated requests is worse than none.
          idempotencyKey: key ? `${key}:base:${i}` : null,
        })),
      });

      const updated = await tx.reservation.update({
        where: { id: reservation.id },
        data: { status: ReservationStatus.IN_PROGRESS, actualArrivalAt: arrivedAt },
      });

      // Commission accrues on the base service, if this therapist is on
      // commission. It accrues on a comped treatment too — the guest paid
      // nothing, but the therapist still did the hour.
      const employee = await tx.employee.findUniqueOrThrow({
        where: { id: reservation.employeeId },
      });
      if (employee.commissionBps > 0) {
        await tx.therapistPayoutLedger.create({
          data: {
            branchId: actor.branchId,
            employeeId: employee.id,
            entryType: LedgerEntryType.COMMISSION_ACCRUAL,
            amountFils: applyBps(reservation.baseCostFils, employee.commissionBps),
            businessDay: day,
            reservationId: reservation.id,
            createdByUserId: actor.id,
            note: `Commission ${employee.commissionBps / 100}% on ${reservation.ref}`,
          },
        });
      }

      // Same `tx` as the money it records: if the payments roll back, so does
      // the entry that claims they happened.
      await this.audit.write(tx, ctx, {
        action: AuditAction.RESERVATION_CHECK_IN,
        entityType: 'Reservation',
        entityId: reservation.id,
        beforeState: pickAuditFields(reservation),
        afterState: pickAuditFields(updated),
        amountFils: receivedFils,
      });

      return {
        ...presentReservation(updated),
        basePaidFils: receivedFils,
        payments: payments.map((p) => ({
          id: p.id,
          kind: p.kind,
          method: p.method,
          amountFils: p.amountFils,
        })),
      };
    });
  }
}

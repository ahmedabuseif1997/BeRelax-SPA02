import { ConflictException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { PaymentKind, Tip } from '@prisma/client';
import {
  CheckoutDto,
  ErrorCode,
  LedgerEntryType,
  ReservationStatus,
  TipType,
  formatAed,
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
 * A tip above three times the treatment price is almost always a decimal slip —
 * AED 500 typed where AED 50 was meant. A manager can confirm it deliberately;
 * reception cannot wave it through. §8.3.
 */
export const TIP_SANITY_MULTIPLE = 3;

/** Payment kinds that settle the bill. The tip is not one of them — it is separate money. */
const SETTLEMENT_KINDS = [PaymentKind.BASE, PaymentKind.ADJUSTMENT, PaymentKind.REFUND];

export interface CheckoutView extends ReservationView {
  totals: {
    baseCollectedFils: number;
    tipFils: number;
    tipType: TipType | null;
    businessReceivedFils: number;
    therapistOwedFromThisVisitFils: number;
  };
}

/**
 * Step 2 of the two-step financial workflow: the treatment is over, the guest
 * knows whether they liked it, and the tip — if there is one — is recorded now.
 *
 * `tip` is nullable, and null is a perfectly valid, fully recorded outcome: most
 * checkouts have no tip. §8.1, §8.3.
 */
@Injectable()
export class CheckoutHandler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async checkout(
    id: string,
    dto: CheckoutDto,
    actor: AuthUser,
    ctx: RequestContext,
  ): Promise<CheckoutView> {
    return this.prisma.$transaction(async (tx) => {
      const reservation = await lockReservation(tx, id, actor.branchId);

      if (reservation.status !== ReservationStatus.IN_PROGRESS) {
        throw new ConflictException(
          apiError(
            ErrorCode.RESERVATION_NOT_IN_PROGRESS,
            'That booking is not in progress, so there is nothing to check out.',
            { status: reservation.status },
          ),
        );
      }

      // What the till actually holds against this booking: the base lines plus
      // any manager ADJUSTMENT or REFUND raised against them. No tip exists yet,
      // so nothing in this sum can be tip money. §13.3 invariant 4.
      const settled = await tx.payment.aggregate({
        _sum: { amountFils: true },
        where: { reservationId: reservation.id, kind: { in: SETTLEMENT_KINDS } },
      });
      const baseCollectedFils = settled._sum.amountFils ?? 0;
      if (baseCollectedFils < reservation.baseCostFils) {
        throw new ConflictException(
          apiError(
            ErrorCode.BASE_PAYMENT_OUTSTANDING,
            `${formatAed(reservation.baseCostFils - baseCollectedFils)} of the treatment is still unpaid.`,
            {
              expectedFils: reservation.baseCostFils,
              settledFils: baseCollectedFils,
              outstandingFils: reservation.baseCostFils - baseCollectedFils,
            },
          ),
        );
      }

      const completedAt = dto.completedAt ? new Date(dto.completedAt) : new Date();
      if (reservation.actualArrivalAt && completedAt < reservation.actualArrivalAt) {
        throw new UnprocessableEntityException(
          apiError(
            ErrorCode.COMPLETION_BEFORE_ARRIVAL,
            'A treatment cannot finish before the guest arrived.',
            {
              actualArrivalAt: reservation.actualArrivalAt.toISOString(),
              completedAt: completedAt.toISOString(),
            },
          ),
        );
      }

      const day = businessDayColumn(completedAt);
      let tipRecord: Tip | null = null;

      if (dto.tip) {
        const tip = dto.tip;
        assertTipIsSane(tip, dto.confirmLargeTip, reservation.baseCostFils, actor);

        if (tip.type === TipType.COLLECTED_BY_BUSINESS) {
          // ── Mode A: the money enters the till. The business now OWES it. ──
          const payment = await tx.payment.create({
            data: {
              branchId: actor.branchId,
              reservationId: reservation.id,
              kind: PaymentKind.TIP,
              // Guaranteed present: assertTipIsSane rejects this mode without one.
              method: tip.method!,
              amountFils: tip.amountFils,
              businessDay: day,
              collectedByUserId: actor.id,
              collectedAt: completedAt,
              externalRef: tip.externalRef ?? null,
              note: dto.note ?? null,
              idempotencyKey: ctx.idempotencyKey ? `${ctx.idempotencyKey}:tip` : null,
            },
          });

          tipRecord = await tx.tip.create({
            data: {
              branchId: actor.branchId,
              reservationId: reservation.id,
              employeeId: reservation.employeeId,
              type: TipType.COLLECTED_BY_BUSINESS,
              amountFils: tip.amountFils,
              method: tip.method,
              paymentId: payment.id,
              businessDay: day,
              recordedByUserId: actor.id,
              recordedAt: completedAt,
              note: dto.note ?? null,
            },
          });

          // The liability. This is the ONLY place a tip becomes payable. §9.1.
          await tx.therapistPayoutLedger.create({
            data: {
              branchId: actor.branchId,
              employeeId: reservation.employeeId,
              entryType: LedgerEntryType.TIP_ACCRUAL,
              amountFils: tip.amountFils, // positive: owed to the therapist
              businessDay: day,
              reservationId: reservation.id,
              tipId: tipRecord.id,
              createdByUserId: actor.id,
              note: `Tip collected by business on ${reservation.ref}`,
            },
          });
        } else {
          // ── Mode B: cash straight to the therapist. Recorded, not owed. ──
          tipRecord = await tx.tip.create({
            data: {
              branchId: actor.branchId,
              reservationId: reservation.id,
              employeeId: reservation.employeeId,
              type: TipType.DIRECT_CASH,
              amountFils: tip.amountFils,
              method: null, // never touched the till
              paymentId: null, // no payment row: no money entered the business
              businessDay: day,
              recordedByUserId: actor.id,
              recordedAt: completedAt,
              note: dto.note ?? null,
            },
          });

          // Deliberately NO ledger entry. §9.2.
          //
          // The ledger answers exactly one question: how much does the business
          // owe this person? The guest handed the cash straight over, so the
          // business never held it and owes nothing. Writing a +50 accrual and
          // an immediate -50 settlement "to keep it symmetrical" would be an
          // accounting fiction — the settlement never happened, because there
          // was nothing to settle — and it would turn the ledger's SUM() into a
          // number you have to interpret rather than trust. The tip still shows
          // in the therapist's EARNINGS, which is read from `tips`, not here.
        }
      }

      const updated = await tx.reservation.update({
        where: { id: reservation.id },
        data: { status: ReservationStatus.COMPLETED, completedAt },
      });

      await this.audit.write(tx, ctx, {
        action: AuditAction.RESERVATION_CHECKOUT,
        entityType: 'Reservation',
        entityId: reservation.id,
        beforeState: pickAuditFields(reservation),
        afterState: {
          ...pickAuditFields(updated),
          tip: tipRecord ? pickAuditFields(tipRecord) : null,
        },
        amountFils: dto.tip?.amountFils ?? 0,
      });

      // Read what this visit owes straight back off the ledger rather than
      // adding it up here: the ledger is the only arbiter of a balance, and
      // there is no stored balance anywhere to disagree with it. §9.3.
      const owed = await tx.therapistPayoutLedger.aggregate({
        _sum: { amountFils: true },
        where: { reservationId: reservation.id },
      });

      const tipFils = tipRecord?.amountFils ?? 0;
      const heldByBusiness = tipRecord?.type === TipType.COLLECTED_BY_BUSINESS;

      return {
        ...presentReservation(updated),
        totals: {
          baseCollectedFils,
          tipFils,
          tipType: (tipRecord?.type as TipType | undefined) ?? null,
          // A DIRECT_CASH tip never entered the till, so it is not money the
          // business received — and a collected tip is a pass-through, not
          // revenue. §9.1.
          businessReceivedFils: baseCollectedFils + (heldByBusiness ? tipFils : 0),
          therapistOwedFromThisVisitFils: owed._sum.amountFils ?? 0,
        },
      };
    });
  }
}

/**
 * Everything that can be wrong about a tip, in the order a receptionist would
 * hit it. Kept out of the transaction body so the two modes below read as the
 * two modes, and nothing else.
 */
function assertTipIsSane(
  tip: NonNullable<CheckoutDto['tip']>,
  confirmLargeTip: boolean,
  baseCostFils: number,
  actor: AuthUser,
): void {
  if (!Number.isInteger(tip.amountFils) || tip.amountFils <= 0) {
    throw new UnprocessableEntityException(
      apiError(ErrorCode.INVALID_AMOUNT, 'A tip must be a positive whole number of fils.'),
    );
  }

  // The method is the whole distinction: it records WHO ends up holding the money.
  if (tip.type === TipType.COLLECTED_BY_BUSINESS && !tip.method) {
    throw new UnprocessableEntityException(
      apiError(
        ErrorCode.TIP_METHOD_REQUIRED,
        'A tip added to the bill needs the method it was paid by.',
      ),
    );
  }
  if (tip.type === TipType.DIRECT_CASH && tip.method) {
    throw new UnprocessableEntityException(
      apiError(
        ErrorCode.TIP_METHOD_NOT_ALLOWED,
        'Cash handed straight to the therapist never entered the till, so it carries no payment method.',
      ),
    );
  }

  const limitFils = baseCostFils * TIP_SANITY_MULTIPLE;
  if (tip.amountFils > limitFils && !(confirmLargeTip && isManagerOrAbove(actor.role))) {
    throw new UnprocessableEntityException(
      apiError(
        ErrorCode.TIP_EXCEEDS_SANITY_LIMIT,
        `${formatAed(tip.amountFils)} is more than three times the treatment price. A manager must confirm it.`,
        { amountFils: tip.amountFils, limitFils, baseCostFils },
      ),
    );
  }
}

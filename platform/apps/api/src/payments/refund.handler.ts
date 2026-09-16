import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PaymentKind, PaymentMethod, Payment, Prisma, Reservation } from '@prisma/client';
import {
  CreateAdjustmentDto,
  ErrorCode,
  RefundPaymentDto,
  formatAed,
} from '@berelax/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { AuditAction, AuditService, pickAuditFields } from '../common/audit.service';
import type { AuthUser, RequestContext } from '../common/request-context';
import { lockReservation } from '../reservations/reservations.service';
import { apiError, businessDayColumn, tradingDayOf } from './money.support';

/**
 * What the till holds against a booking: the base lines plus every manager
 * correction raised against them. The same set checkout uses to decide whether
 * the bill is settled — a tip is separate money and is not in it. §8.3, §13.3.
 */
const SETTLEMENT_KINDS = [PaymentKind.BASE, PaymentKind.ADJUSTMENT, PaymentKind.REFUND];

export interface PaymentRowView {
  id: string;
  reservationId: string;
  kind: PaymentKind;
  method: PaymentMethod;
  /** Signed, as stored: negative on a REFUND, either sign on an ADJUSTMENT. §3.1. */
  amountFils: number;
  businessDay: string;
  collectedAt: string;
  externalRef: string | null;
  reversesPaymentId: string | null;
  note: string | null;
}

export interface ReservationMoneyView {
  id: string;
  ref: string;
  baseCostFils: number;
  /** BASE + ADJUSTMENT + REFUND. What the business actually ended up holding. */
  netCollectedFils: number;
}

export interface RefundView {
  refund: PaymentRowView;
  original: {
    id: string;
    kind: PaymentKind;
    amountFils: number;
    /** Everything already returned against it, as a positive magnitude. */
    refundedFils: number;
    /** What is still refundable after this refund. Zero means fully returned. */
    refundableFils: number;
  };
  reservation: ReservationMoneyView;
}

export interface AdjustmentView {
  adjustment: PaymentRowView;
  reservation: ReservationMoneyView;
}

/**
 * Corrections to money that has already been collected.
 *
 * Neither method edits anything. `payments` is append-only and the database
 * enforces it — `trg_payments_no_update` and `trg_payments_no_delete` make
 * Prisma's `update`, `upsert` and `delete` on this model throw by design (§5.4),
 * so the only shape a correction can take here is a NEW signed row pointing back
 * at what it corrects. That is not a limitation to work around; it is the reason
 * anyone can still trust the numbers six months later. §9.4.
 *
 * The two are different instruments and the difference matters:
 *
 *   REFUND     — money physically going back to the guest, against one specific
 *                payment, capped at what that payment still has left in it.
 *   ADJUSTMENT — a discount, a goodwill write-down or a correction to what was
 *                collected. It hangs off the reservation, not off one payment,
 *                carries a mandatory reason, and is how §8.2's "a short payment
 *                is a discount, and a discount is a manager decision" is recorded.
 */
@Injectable()
export class RefundHandler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async refund(
    paymentId: string,
    dto: RefundPaymentDto,
    actor: AuthUser,
    ctx: RequestContext,
  ): Promise<RefundView> {
    return this.prisma.$transaction(async (tx) => {
      // Lock the ORIGINAL row, not the refunds against it. Two managers
      // refunding the same payment at once must serialise here: both would
      // otherwise read "nothing refunded yet" and each write a full refund,
      // handing the guest twice their money. Locking the row they both must
      // read is what makes the second one see the first one's work.
      const original = await lockPayment(tx, paymentId, actor.branchId);

      // A REFUND row is itself a correction and has nothing left to give back.
      // Refunding one would create a POSITIVE refund — money appearing out of a
      // correction, which is the one direction this table must never move in.
      if (original.amountFils <= 0) {
        throw new UnprocessableEntityException(
          apiError(
            ErrorCode.PAYMENT_NOT_REFUNDABLE,
            'That row is itself a correction, so there is nothing to refund. Raise an adjustment instead.',
            { paymentId: original.id, kind: original.kind, amountFils: original.amountFils },
          ),
        );
      }

      // Everything already returned against this payment. The rows are negative,
      // so the magnitude is the negated sum.
      const returned = await tx.payment.aggregate({
        _sum: { amountFils: true },
        where: { reversesPaymentId: original.id },
      });
      const refundedFils = -(returned._sum.amountFils ?? 0);
      const refundableFils = original.amountFils - refundedFils;

      if (refundableFils <= 0) {
        throw new ConflictException(
          apiError(
            ErrorCode.PAYMENT_ALREADY_REFUNDED,
            `${formatAed(original.amountFils)} has already been refunded in full.`,
            { paymentId: original.id, amountFils: original.amountFils, refundedFils },
          ),
        );
      }

      // Omitting the amount refunds whatever is left, which is what a manager
      // means nine times out of ten.
      const amountFils = dto.amountFils ?? refundableFils;
      if (amountFils > refundableFils) {
        throw new UnprocessableEntityException(
          apiError(
            ErrorCode.REFUND_EXCEEDS_PAYMENT,
            `Only ${formatAed(refundableFils)} of that payment can still be refunded.`,
            {
              paymentId: original.id,
              requestedFils: amountFils,
              originalFils: original.amountFils,
              refundedFils,
              refundableFils,
            },
          ),
        );
      }

      const reservation = await tx.reservation.findUniqueOrThrow({
        where: { id: original.reservationId },
      });
      const refundedAt = new Date();

      const refund = await tx.payment.create({
        data: {
          branchId: actor.branchId,
          reservationId: original.reservationId,
          kind: PaymentKind.REFUND,
          // Money goes back the way it came in unless the manager says otherwise
          // — a card refund to a card, cash from the till for cash.
          method: dto.method ?? original.method,
          amountFils: -amountFils, // negative: signed so SUM() is the net position
          businessDay: businessDayColumn(refundedAt),
          collectedByUserId: actor.id,
          collectedAt: refundedAt,
          externalRef: dto.externalRef ?? null,
          reversesPaymentId: original.id,
          note: dto.reason,
          idempotencyKey: ctx.idempotencyKey ? `${ctx.idempotencyKey}:refund` : null,
        },
      });

      await this.writeCorrectionAudit(tx, ctx, {
        action: AuditAction.PAYMENT_REFUNDED,
        reservation,
        beforeState: pickAuditFields(original),
        afterState: { ...pickAuditFields(refund), reason: dto.reason, reversesPaymentId: original.id },
        amountFils: refund.amountFils,
      });

      return {
        refund: presentPayment(refund),
        original: {
          id: original.id,
          kind: original.kind,
          amountFils: original.amountFils,
          refundedFils: refundedFils + amountFils,
          refundableFils: refundableFils - amountFils,
        },
        reservation: await presentReservationMoney(tx, reservation),
      };
    });
  }

  async adjust(
    dto: CreateAdjustmentDto,
    actor: AuthUser,
    ctx: RequestContext,
  ): Promise<AdjustmentView> {
    return this.prisma.$transaction(async (tx) => {
      // The reservation is what an adjustment hangs off, and locking it keeps
      // two managers from discounting the same booking twice over.
      const reservation = await lockReservation(tx, dto.reservationId, actor.branchId);

      // Zero is checked here rather than in the schema so the answer names the
      // problem: an adjustment of nothing is a mis-keyed amount, not a malformed
      // request. The sign is deliberately unconstrained — a correction goes
      // whichever way the mistake went.
      if (dto.amountFils === 0) {
        throw new UnprocessableEntityException(
          apiError(
            ErrorCode.INVALID_AMOUNT,
            'An adjustment of zero records nothing. Enter the amount to add or take off.',
          ),
        );
      }

      const adjustedAt = new Date();
      const adjustment = await tx.payment.create({
        data: {
          branchId: actor.branchId,
          reservationId: reservation.id,
          kind: PaymentKind.ADJUSTMENT,
          method: dto.method,
          amountFils: dto.amountFils, // signed: negative discounts, positive collects more
          businessDay: businessDayColumn(adjustedAt),
          collectedByUserId: actor.id,
          collectedAt: adjustedAt,
          externalRef: dto.externalRef ?? null,
          note: dto.reason,
          idempotencyKey: ctx.idempotencyKey ? `${ctx.idempotencyKey}:adjustment` : null,
        },
      });

      await this.writeCorrectionAudit(tx, ctx, {
        action: AuditAction.PAYMENT_ADJUSTED,
        reservation,
        beforeState: pickAuditFields(reservation),
        afterState: { ...pickAuditFields(adjustment), reason: dto.reason },
        amountFils: adjustment.amountFils,
      });

      return {
        adjustment: presentPayment(adjustment),
        reservation: await presentReservationMoney(tx, reservation),
      };
    });
  }

  /**
   * On the SAME transaction as the write it records, so a rolled-back correction
   * takes its audit row with it — an audit log describing transactions that
   * never happened is worse than none, because you would believe it. §9.6.
   *
   * The entity is the RESERVATION, not the payment row. Every payment, tip and
   * accrual in this system is audited against the booking the money hangs off
   * (§13.3 invariant 7 asserts exactly that, and answers a dispute from the
   * booking reference the guest and the therapist both know). The payment ids
   * are in `beforeState`/`afterState`, where nothing can drift away from them.
   */
  private async writeCorrectionAudit(
    tx: Prisma.TransactionClient,
    ctx: RequestContext,
    entry: {
      action: AuditAction;
      reservation: Reservation;
      beforeState: Record<string, unknown>;
      afterState: Record<string, unknown>;
      amountFils: number;
    },
  ): Promise<void> {
    await this.audit.write(tx, ctx, {
      action: entry.action,
      entityType: 'Reservation',
      entityId: entry.reservation.id,
      beforeState: entry.beforeState,
      afterState: { ...entry.afterState, reservationRef: entry.reservation.ref },
      amountFils: entry.amountFils,
    });
  }
}

/**
 * Take the row lock FIRST, then read through Prisma — the same discipline as
 * `lockReservation`, and for the same reason: `$queryRaw` hands back the
 * database's own column names, so a `SELECT *` mapped onto Payment would leave
 * `amountFils` undefined and turn a money comparison into a silent zero.
 */
async function lockPayment(
  tx: Prisma.TransactionClient,
  id: string,
  branchId: string,
): Promise<Payment> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM payments
     WHERE id = ${id}::uuid AND branch_id = ${branchId}::uuid
     FOR UPDATE`;

  if (locked.length === 0) {
    throw new NotFoundException(
      apiError(ErrorCode.PAYMENT_NOT_FOUND, 'No payment with that id in this branch.'),
    );
  }
  return tx.payment.findUniqueOrThrow({ where: { id } });
}

function presentPayment(row: Payment): PaymentRowView {
  return {
    id: row.id,
    reservationId: row.reservationId,
    kind: row.kind,
    method: row.method,
    amountFils: row.amountFils,
    businessDay: tradingDayOf(row.businessDay),
    collectedAt: row.collectedAt.toISOString(),
    externalRef: row.externalRef,
    reversesPaymentId: row.reversesPaymentId,
    note: row.note,
  };
}

/** Read the booking's position back off the table rather than adding it up here. */
async function presentReservationMoney(
  tx: Prisma.TransactionClient,
  reservation: Reservation,
): Promise<ReservationMoneyView> {
  const settled = await tx.payment.aggregate({
    _sum: { amountFils: true },
    where: { reservationId: reservation.id, kind: { in: SETTLEMENT_KINDS } },
  });
  return {
    id: reservation.id,
    ref: reservation.ref,
    baseCostFils: reservation.baseCostFils,
    netCollectedFils: settled._sum.amountFils ?? 0,
  };
}

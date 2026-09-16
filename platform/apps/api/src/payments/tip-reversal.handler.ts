import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PaymentKind, PaymentMethod, Prisma, TherapistPayoutLedger, Tip } from '@prisma/client';
import { ErrorCode, LedgerEntryType, ReverseTipDto, TipType } from '@berelax/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { AuditAction, AuditService, pickAuditFields } from '../common/audit.service';
import type { AuthUser, RequestContext } from '../common/request-context';
import { apiError, businessDayColumn, ledgerSumFils, tradingDayOf } from './money.support';

export interface TipRowView {
  id: string;
  reservationId: string;
  employeeId: string;
  type: TipType;
  /** Negative on the reversal row. The pair sums to zero, and both rows stay. §9.4. */
  amountFils: number;
  method: PaymentMethod | null;
  businessDay: string;
  recordedAt: string;
  reversedByTipId: string | null;
  note: string | null;
}

export interface TipReversalView {
  original: TipRowView;
  reversal: TipRowView;
  /** Set only when the money had entered the business and is going back out. */
  refundPaymentId: string | null;
  /** The ledger entry cancelling the liability. Null for a DIRECT_CASH tip: there was none. */
  reversalEntryId: string | null;
  /** SUM(amount_fils) over the whole ledger after this correction. Never a stored number. §9.3. */
  balanceAfterFils: number;
}

/**
 * Reception records a 500 AED tip when the guest gave 50. The fix is not an
 * update — it is a reversal. §9.4.
 *
 * What comes out of this is a pair of rows that sum to zero and two names
 * against two timestamps: the mistake AND the correction, both readable six
 * months later. The original row is never touched except to point at the row
 * that cancels it, which is the one mutation `tips` allows.
 *
 * If the accrual has already gone out in a payout batch, this refuses. Taking
 * money back off somebody who has already been paid is a conversation with a
 * person, not a silent write, and the manual adjustment that follows carries a
 * reason and a name. That refusal is the most important line in this file.
 */
@Injectable()
export class TipReversalHandler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async reverse(
    tipId: string,
    dto: ReverseTipDto,
    actor: AuthUser,
    ctx: RequestContext,
  ): Promise<TipReversalView> {
    return this.prisma.$transaction(async (tx) => {
      const original = await lockTip(tx, tipId, actor.branchId);

      // Already reversed — including the case where this id IS a reversal row,
      // since both halves of a reversed pair carry the link (see below).
      if (original.reversedByTipId) {
        throw new ConflictException(
          apiError(
            ErrorCode.TIP_ALREADY_REVERSED,
            'That tip has already been reversed.',
            { tipId: original.id, reversedByTipId: original.reversedByTipId },
          ),
        );
      }

      // ── The refusal comes first, before anything is written. ──
      //
      // §9.4 reaches the accrual after creating the rows and lets the rollback
      // clean up; checking first is the same outcome with nothing written on the
      // way to a refusal, and it puts the one branch that matters at the top of
      // the method where it gets read.
      //
      // The accrual is locked, not merely read: a payout batch running in the
      // next connection stamps exactly this row, and a reversal that read it a
      // moment too early would cancel a liability that has already been paid.
      let accrual: TherapistPayoutLedger | null = null;
      if (original.paymentId) {
        accrual = await lockTipAccrual(tx, original.id);
        if (accrual.payoutBatchId) {
          throw new ConflictException(
            apiError(
              ErrorCode.TIP_ALREADY_PAID_OUT,
              'This tip was already included in a payout. Raise a manual adjustment instead.',
              { payoutBatchId: accrual.payoutBatchId, tipId: original.id, ledgerEntryId: accrual.id },
            ),
          );
        }
      }

      const reversedAt = new Date();
      const day = businessDayColumn(reversedAt);

      // ── 1. A mirror tip row with a negative amount. ──
      //
      // It carries `reversedByTipId` pointing back at the original, which makes
      // the link mutual. That is not decoration: every earnings query in this
      // system filters `reversed_by_tip_id IS NULL` (§9.2), and §13.3's first
      // invariant reconciles the ledger against exactly that filter. Leave the
      // mirror unmarked and the original drops out of earnings while the −50
      // mirror stays in, so a reversed 50 AED tip reads as −50 AED earned and
      // the ledger identity breaks by twice the tip. Marked, both halves of the
      // pair leave the earnings line together and the ledger's REVERSAL entry
      // is the only trace either side needs.
      const reversal = await tx.tip.create({
        data: {
          branchId: original.branchId,
          reservationId: original.reservationId,
          employeeId: original.employeeId,
          type: original.type,
          amountFils: -original.amountFils,
          method: original.method,
          businessDay: day,
          recordedByUserId: actor.id,
          recordedAt: reversedAt,
          reversedByTipId: original.id,
          note: `Reversal of ${original.id}: ${dto.reason}`,
        },
      });

      // The one permitted mutation on a tip: pointing the original at the row
      // that cancels it. The amount, the type and the timestamps are untouched.
      const linked = await tx.tip.update({
        where: { id: original.id },
        data: { reversedByTipId: reversal.id },
      });

      let refundPaymentId: string | null = null;
      let reversalEntryId: string | null = null;

      // ── 2. Money that actually entered the business has to leave it again. ──
      //
      // A DIRECT_CASH tip never did: the guest handed it straight to the
      // therapist, so there is no payment row to reverse and no liability to
      // cancel. The mirror tip row above is the whole correction. §9.2.
      if (original.paymentId) {
        const refund = await tx.payment.create({
          data: {
            branchId: original.branchId,
            reservationId: original.reservationId,
            kind: PaymentKind.REFUND,
            // Non-null for a COLLECTED_BY_BUSINESS tip: the `tips_direct_cash_has_no_payment`
            // check constraint makes a collected tip without a method unstorable.
            method: original.method!,
            amountFils: -original.amountFils,
            businessDay: day,
            collectedByUserId: actor.id,
            collectedAt: reversedAt,
            reversesPaymentId: original.paymentId,
            note: dto.reason,
            idempotencyKey: ctx.idempotencyKey ? `${ctx.idempotencyKey}:refund` : null,
          },
        });
        refundPaymentId = refund.id;

        // ── 3. And a REVERSAL entry cancelling the liability. ──
        const entry = await tx.therapistPayoutLedger.create({
          data: {
            branchId: original.branchId,
            employeeId: original.employeeId,
            entryType: LedgerEntryType.REVERSAL,
            amountFils: -original.amountFils,
            businessDay: day,
            reservationId: original.reservationId,
            tipId: reversal.id,
            // Non-null inside this branch: the accrual was located and locked above.
            reversesEntryId: accrual!.id,
            createdByUserId: actor.id,
            note: dto.reason,
          },
        });
        reversalEntryId = entry.id;
      }

      // Same transaction as the writes: a rolled-back reversal takes its audit
      // row with it. The entity is the RESERVATION, because that is the anchor
      // every payment, tip and accrual in this system is audited against — the
      // booking reference the guest, the therapist and the manager all already
      // have (§9.7), and the one §13.3 invariant 7 checks. The tip ids are in
      // the states below, where a dispute can read them off the same row.
      await this.audit.write(tx, ctx, {
        action: AuditAction.TIP_REVERSED,
        entityType: 'Reservation',
        entityId: original.reservationId,
        beforeState: pickAuditFields(original),
        afterState: {
          ...pickAuditFields(reversal),
          reversedTipId: original.id,
          reason: dto.reason,
          refundPaymentId,
          reversalEntryId,
        },
        amountFils: -original.amountFils,
      });

      return {
        original: presentTip(linked),
        reversal: presentTip(reversal),
        refundPaymentId,
        reversalEntryId,
        balanceAfterFils: await ledgerSumFils(tx, {
          employeeId: original.employeeId,
          branchId: original.branchId,
        }),
      };
    });
  }
}

/** Lock raw, read typed — see the note on `lockReservation`. */
async function lockTip(tx: Prisma.TransactionClient, id: string, branchId: string): Promise<Tip> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM tips
     WHERE id = ${id}::uuid AND branch_id = ${branchId}::uuid
     FOR UPDATE`;

  if (locked.length === 0) {
    throw new NotFoundException(
      apiError(ErrorCode.TIP_NOT_FOUND, 'No tip with that id in this branch.'),
    );
  }
  return tx.tip.findUniqueOrThrow({ where: { id } });
}

/**
 * The accrual a collected tip created at checkout. §13.3 invariant 3 guarantees
 * there is exactly one, which is what makes `findFirstOrThrow` the honest call
 * here: if it is missing, the ledger disagrees with the tips table and this
 * request must fail rather than guess which of the two is right.
 */
async function lockTipAccrual(
  tx: Prisma.TransactionClient,
  tipId: string,
): Promise<TherapistPayoutLedger> {
  await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM therapist_payout_ledger
     WHERE tip_id = ${tipId}::uuid AND entry_type = 'TIP_ACCRUAL'
     FOR UPDATE`;

  return tx.therapistPayoutLedger.findFirstOrThrow({
    where: { tipId, entryType: LedgerEntryType.TIP_ACCRUAL },
  });
}

function presentTip(row: Tip): TipRowView {
  return {
    id: row.id,
    reservationId: row.reservationId,
    employeeId: row.employeeId,
    type: row.type as TipType,
    amountFils: row.amountFils,
    method: row.method,
    businessDay: tradingDayOf(row.businessDay),
    recordedAt: row.recordedAt.toISOString(),
    reversedByTipId: row.reversedByTipId,
    note: row.note,
  };
}

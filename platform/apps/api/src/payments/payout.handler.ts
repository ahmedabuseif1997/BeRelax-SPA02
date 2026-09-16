import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PaymentMethod, PayoutBatch, Prisma } from '@prisma/client';
import { CreatePayoutDto, ErrorCode, LedgerEntryType, formatAed } from '@berelax/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { AuditAction, AuditService, pickAuditFields } from '../common/audit.service';
import type { AuthUser, RequestContext } from '../common/request-context';
import { apiError, businessDayColumn, ledgerSumFils, tradingDayOf } from './money.support';

export interface PayoutBatchView {
  id: string;
  employeeId: string;
  periodStart: string;
  periodEnd: string;
  totalFils: number;
  method: PaymentMethod;
  paidAt: string;
  approvedByUserId: string;
  /** The therapist signed for it. The strongest evidence in a dispute. §9.5. */
  acknowledgedAt: string | null;
  note: string | null;
  /** Exactly which accruals this batch settled — what the therapist is signing for. */
  entryIds: string[];
  /** SUM over the whole ledger after the payout. Computed, never stored. §9.3. */
  balanceAfterFils: number;
  /** What is still owed and not yet in any batch — accruals outside the period. */
  unbatchedFils: number;
}

/**
 * Settling up. §9.5.
 *
 * The batch is not a calculation somebody types in: it is the sum of ledger rows
 * that already existed, each one traceable to a booking, a named person and a
 * timestamp. The batch settles them by stamping `payout_batch_id` onto each —
 * the single mutation `ledger_guard` permits, and only ever from NULL — and then
 * inserts the negative PAYOUT entry that brings the balance to zero.
 *
 * Nothing is recomputed on read afterwards. The balance stays SUM(amount_fils)
 * forever, and this batch is simply some of the rows in that sum.
 */
@Injectable()
export class PayoutHandler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(
    dto: CreatePayoutDto,
    actor: AuthUser,
    ctx: RequestContext,
  ): Promise<PayoutBatchView> {
    return this.prisma.$transaction(async (tx) => {
      if (dto.periodEnd < dto.periodStart) {
        throw new UnprocessableEntityException(
          apiError(ErrorCode.VALIDATION_FAILED, 'The payout period ends before it starts.', {
            periodStart: dto.periodStart,
            periodEnd: dto.periodEnd,
          }),
        );
      }

      const employee = await tx.employee.findFirst({
        where: { id: dto.employeeId, branchId: actor.branchId, deletedAt: null },
      });
      if (!employee) {
        throw new NotFoundException(
          apiError(ErrorCode.NOT_FOUND, 'No such therapist in this branch.'),
        );
      }

      // ── 1. Lock every unbatched entry in the period. ──
      //
      // FOR UPDATE, not a plain read: two managers settling the same therapist
      // at the same moment must not both see the same accruals and pay them
      // twice. The second transaction blocks here, and when it resumes the rows
      // it was about to batch carry a `payout_batch_id`, so they no longer match
      // `IS NULL` and it correctly finds nothing left to pay.
      //
      // Ordered by id so concurrent batches always take their locks in the same
      // sequence, and by TRADING day so a 01:30 tip settles with the night it
      // belongs to rather than the calendar date after it. §3.3.
      const unbatched = await tx.$queryRaw<{ id: string; amountFils: number }[]>`
        SELECT id, amount_fils AS "amountFils"
          FROM therapist_payout_ledger
         WHERE employee_id = ${dto.employeeId}::uuid
           AND branch_id = ${actor.branchId}::uuid
           AND payout_batch_id IS NULL
           AND business_day BETWEEN ${dto.periodStart}::date AND ${dto.periodEnd}::date
         ORDER BY id
         FOR UPDATE`;

      // ── 2. Sum them. ──
      const totalFils = unbatched.reduce((sum, entry) => sum + entry.amountFils, 0);
      if (totalFils <= 0) {
        // Zero means there is nothing outstanding; negative means the therapist
        // owes the business — a reversal after a payout, say — and paying a
        // negative amount is not a thing that can happen at a cash desk. Either
        // way this is a conversation, not a transfer.
        throw new UnprocessableEntityException(
          apiError(
            ErrorCode.PAYOUT_NOT_POSITIVE,
            unbatched.length === 0
              ? 'There is nothing outstanding for that therapist in this period.'
              : `That period nets to ${formatAed(totalFils)}, so there is nothing to pay out.`,
            {
              employeeId: dto.employeeId,
              periodStart: dto.periodStart,
              periodEnd: dto.periodEnd,
              entryCount: unbatched.length,
              totalFils,
            },
          ),
        );
      }

      const paidAt = new Date();

      // ── 3. The batch. ──
      const batch = await tx.payoutBatch.create({
        data: {
          branchId: actor.branchId,
          employeeId: employee.id,
          periodStart: businessDayColumn(dto.periodStart),
          periodEnd: businessDayColumn(dto.periodEnd),
          totalFils,
          method: dto.method,
          paidAt,
          approvedByUserId: actor.id,
          note: dto.note ?? null,
        },
      });

      // ── 4. Stamp each entry. The ONE mutation the ledger guard permits. ──
      //
      // `payoutBatchId: null` stays in the WHERE clause so this can only ever
      // move a row from unbatched to batched, never re-point one that is already
      // settled. The database enforces the same rule from underneath
      // (`trg_ledger_guard`, §5.4); this is the application agreeing with it in
      // writing rather than relying on being caught.
      const entryIds = unbatched.map((entry) => entry.id);
      const stamped = await tx.therapistPayoutLedger.updateMany({
        where: { id: { in: entryIds }, payoutBatchId: null },
        data: { payoutBatchId: batch.id },
      });
      if (stamped.count !== entryIds.length) {
        // Unreachable while the locks above hold, which is exactly why it is
        // worth asserting: if it ever fires, the batch total no longer describes
        // the rows it settled, and the whole transaction must go.
        throw new Error(
          `payout ${batch.id}: expected to settle ${entryIds.length} ledger entries, settled ${stamped.count}`,
        );
      }

      // ── 5. The negative PAYOUT entry, bringing the balance to zero. ──
      const payoutEntry = await tx.therapistPayoutLedger.create({
        data: {
          branchId: actor.branchId,
          employeeId: employee.id,
          entryType: LedgerEntryType.PAYOUT,
          amountFils: -totalFils, // signed: negative pays the balance down
          businessDay: businessDayColumn(paidAt),
          payoutBatchId: batch.id,
          createdByUserId: actor.id,
          note: dto.note ?? `Payout batch ${dto.periodStart} to ${dto.periodEnd}`,
        },
      });

      // ── 6. The audit row, carrying every settled entry id. ──
      //
      // This is what makes the batch answerable months later: not "AED 385 was
      // paid" but "these nineteen accruals, by id, were paid — check them
      // against the ledger yourself". §9.5, §9.7.
      await this.audit.write(tx, ctx, {
        action: AuditAction.PAYOUT_CREATED,
        entityType: 'PayoutBatch',
        entityId: batch.id,
        afterState: {
          ...pickAuditFields(batch),
          employeeId: employee.id,
          periodStart: dto.periodStart,
          periodEnd: dto.periodEnd,
          entryCount: entryIds.length,
          entryIds,
          payoutEntryId: payoutEntry.id,
        },
        amountFils: totalFils,
      });

      return this.present(tx, batch, entryIds);
    });
  }

  /**
   * The therapist confirms receipt from their own login. Only they can: a
   * payout a manager acknowledged on the recipient's behalf would be worth
   * nothing as evidence, which is the entire point of the field. §9.5.
   */
  async acknowledge(
    batchId: string,
    actor: AuthUser,
    ctx: RequestContext,
  ): Promise<PayoutBatchView> {
    return this.prisma.$transaction(async (tx) => {
      const batch = await lockPayoutBatch(tx, batchId, actor.branchId);

      // A therapist login with no linked employee row acknowledges nothing;
      // `actor.employeeId` is null there and cannot match any batch.
      if (batch.employeeId !== actor.employeeId) {
        throw new ForbiddenException(
          apiError(
            ErrorCode.INSUFFICIENT_ROLE,
            'Only the therapist who was paid can confirm receipt of a payout.',
          ),
        );
      }

      if (batch.acknowledgedAt) {
        throw new ConflictException(
          apiError(
            ErrorCode.PAYOUT_ALREADY_ACKNOWLEDGED,
            'You have already confirmed receipt of this payout.',
            { payoutBatchId: batch.id, acknowledgedAt: batch.acknowledgedAt.toISOString() },
          ),
        );
      }

      // `payout_batches` is the one money table that is not append-only, and
      // this single nullable column is why: the batch total itself is immutable,
      // and all the therapist is adding is a signature with a timestamp.
      const acknowledged = await tx.payoutBatch.update({
        where: { id: batch.id },
        data: { acknowledgedAt: new Date() },
      });

      await this.audit.write(tx, ctx, {
        action: AuditAction.PAYOUT_ACKNOWLEDGED,
        entityType: 'PayoutBatch',
        entityId: batch.id,
        beforeState: pickAuditFields(batch),
        afterState: pickAuditFields(acknowledged),
        amountFils: batch.totalFils,
      });

      const entries = await tx.therapistPayoutLedger.findMany({
        where: { payoutBatchId: batch.id, entryType: { not: LedgerEntryType.PAYOUT } },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      return this.present(
        tx,
        acknowledged,
        entries.map((entry) => entry.id),
      );
    });
  }

  private async present(
    tx: Prisma.TransactionClient,
    batch: PayoutBatch,
    entryIds: string[],
  ): Promise<PayoutBatchView> {
    const scope = { employeeId: batch.employeeId, branchId: batch.branchId };
    return {
      id: batch.id,
      employeeId: batch.employeeId,
      periodStart: tradingDayOf(batch.periodStart),
      periodEnd: tradingDayOf(batch.periodEnd),
      totalFils: batch.totalFils,
      method: batch.method,
      paidAt: batch.paidAt.toISOString(),
      approvedByUserId: batch.approvedByUserId,
      acknowledgedAt: batch.acknowledgedAt?.toISOString() ?? null,
      note: batch.note,
      entryIds,
      balanceAfterFils: await ledgerSumFils(tx, scope),
      unbatchedFils: await ledgerSumFils(tx, { ...scope, payoutBatchId: null }),
    };
  }
}

/** Lock raw, read typed — two taps on Confirm receipt must not write twice. */
async function lockPayoutBatch(
  tx: Prisma.TransactionClient,
  id: string,
  branchId: string,
): Promise<PayoutBatch> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM payout_batches
     WHERE id = ${id}::uuid AND branch_id = ${branchId}::uuid
     FOR UPDATE`;

  if (locked.length === 0) {
    throw new NotFoundException(
      apiError(ErrorCode.PAYOUT_BATCH_NOT_FOUND, 'No payout batch with that id in this branch.'),
    );
  }
  return tx.payoutBatch.findUniqueOrThrow({ where: { id } });
}

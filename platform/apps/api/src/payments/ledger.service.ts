import { Injectable, NotFoundException } from '@nestjs/common';
import { LedgerEntryType as PrismaLedgerEntryType } from '@prisma/client';
import {
  EarningsQuery,
  ErrorCode,
  LedgerEntryType,
  LedgerQuery,
  TipType,
} from '@berelax/contracts';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../common/request-context';
import {
  apiError,
  assertMayReadEmployeeRecord,
  businessDayColumn,
  ledgerSumFils,
  monthStart,
  resolveTradingWindow,
  shiftTradingDay,
  tradingDayOf,
} from './money.support';

/** A dispute is usually about last month, so the ledger opens on a quarter by default. */
export const LEDGER_DEFAULT_SPAN_DAYS = 90;

export interface LedgerEntryView {
  id: string;
  createdAt: string;
  businessDay: string;
  entryType: LedgerEntryType;
  /** Signed: positive accrues, negative pays down. §3.1. */
  amountFils: number;
  /** The booking this line came from — what reception reads over the phone. */
  reservationRef: string | null;
  tipType: TipType | null;
  /** The named person who entered it. Half of what settles an argument. §9.7. */
  recordedBy: string | null;
  payoutBatchId: string | null;
  paidInBatchAt: string | null;
  acknowledgedAt: string | null;
  note: string | null;
}

export interface LedgerView {
  employeeId: string;
  from: string;
  to: string;
  /** The whole ledger, not the window: a balance is a balance. §9.3. */
  balanceFils: number;
  /** Of that balance, what no payout batch has settled yet. */
  unbatchedFils: number;
  /** The signed sum of the rows below, so the window reconciles against itself. */
  windowTotalFils: number;
  entryCount: number;
  entries: LedgerEntryView[];
}

export interface BalanceView {
  employeeId: string;
  asOf: string;
  /** SUM(amount_fils). There is no stored balance column and there will not be one. §9.3. */
  balanceFils: number;
  unbatchedFils: number;
  entryCount: number;
}

export interface EarningsView {
  employeeId: string;
  period: { from: string; to: string };
  /**
   * §9.2, line one. The guest handed this straight to the therapist; the
   * business never held it and owes nothing on it.
   */
  cashReceivedDirectly: {
    label: string;
    tipCount: number;
    totalFils: number;
  };
  /** §9.2, line two. This is the debt, and it is the only figure a payout pays. */
  heldByBusinessAndPayable: {
    label: string;
    tipsCollected: { tipCount: number; totalFils: number };
    commissionAccruedFils: number;
    adjustmentsFils: number;
    reversalsFils: number;
    /** Everything the ledger gained in the window, before anything was paid out. */
    accruedInPeriodFils: number;
    paidOutInPeriodFils: number;
    /** What the business owes RIGHT NOW, over all time. Not window-scoped. */
    balanceNowFils: number;
    unbatchedFils: number;
  };
  /** Both lines together: what the therapist earned, however the money reached them. */
  totalEarnedInPeriodFils: number;
  explanation: string;
}

const CASH_LABEL = 'Cash received directly from guests — the therapist is already holding this money';
const PAYABLE_LABEL = 'Held by BE RELAX and payable to the therapist';
const EXPLANATION =
  'These two figures are kept apart on purpose. A DIRECT_CASH tip is earnings but not a debt: ' +
  'the business never held it, so it is not payable and a payout must never include it. ' +
  'Adding the two lines together is how a spa pays a tip twice.';

/**
 * Everything read-only about what a therapist is owed. §9.2, §9.3, §9.7.
 *
 * Every figure here is computed at read time from rows that already exist. There
 * is no cache, no stored balance and no nightly rollup, because a second source
 * of truth drifts and the drift is always discovered mid-argument.
 */
@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The dispute artefact of §9.7: every line with its booking reference, the
   * person who entered it, the batch it was paid in and the moment the therapist
   * signed for it.
   *
   * Raw SQL because four of those columns live in four different tables that the
   * ledger has no Prisma relation to (`created_by_user_id` and `tip_id` are
   * plain columns). Every column is aliased explicitly — a `SELECT *` here would
   * hand back `amount_fils` and leave `amountFils` undefined, which in a money
   * report is a silent zero rather than an error.
   */
  async entries(employeeId: string, query: LedgerQuery, actor: AuthUser): Promise<LedgerView> {
    assertMayReadEmployeeRecord(employeeId, actor);
    await this.assertEmployeeExists(employeeId, actor.branchId);

    const { from, to } = resolveTradingWindow(query, (end) =>
      shiftTradingDay(end, -LEDGER_DEFAULT_SPAN_DAYS),
    );

    const rows = await this.prisma.$queryRaw<LedgerEntryRow[]>`
      SELECT l.id                AS "id",
             l.created_at        AS "createdAt",
             l.business_day      AS "businessDay",
             l.entry_type        AS "entryType",
             l.amount_fils       AS "amountFils",
             r.ref               AS "reservationRef",
             t.type              AS "tipType",
             u.full_name         AS "recordedBy",
             l.payout_batch_id   AS "payoutBatchId",
             b.paid_at           AS "paidInBatchAt",
             b.acknowledged_at   AS "acknowledgedAt",
             l.note              AS "note"
        FROM therapist_payout_ledger l
        LEFT JOIN reservations   r ON r.id = l.reservation_id
        LEFT JOIN tips           t ON t.id = l.tip_id
        LEFT JOIN users          u ON u.id = l.created_by_user_id
        LEFT JOIN payout_batches b ON b.id = l.payout_batch_id
       WHERE l.employee_id = ${employeeId}::uuid
         AND l.branch_id   = ${actor.branchId}::uuid
         AND l.business_day BETWEEN ${from}::date AND ${to}::date
       ORDER BY l.created_at, l.id
       LIMIT ${query.limit}`;

    const scope = { employeeId, branchId: actor.branchId };
    return {
      employeeId,
      from,
      to,
      balanceFils: await ledgerSumFils(this.prisma, scope),
      unbatchedFils: await ledgerSumFils(this.prisma, { ...scope, payoutBatchId: null }),
      windowTotalFils: rows.reduce((sum, row) => sum + row.amountFils, 0),
      entryCount: rows.length,
      entries: rows.map(presentEntry),
    };
  }

  /** One number, and it is always the same number: SUM(amount_fils). §9.3. */
  async balance(employeeId: string, actor: AuthUser): Promise<BalanceView> {
    assertMayReadEmployeeRecord(employeeId, actor);
    await this.assertEmployeeExists(employeeId, actor.branchId);

    const scope = { employeeId, branchId: actor.branchId };
    return {
      employeeId,
      asOf: new Date().toISOString(),
      balanceFils: await ledgerSumFils(this.prisma, scope),
      unbatchedFils: await ledgerSumFils(this.prisma, { ...scope, payoutBatchId: null }),
      entryCount: await this.prisma.therapistPayoutLedger.count({ where: scope }),
    };
  }

  /**
   * The therapist's statement, and the reason the whole design works: earnings
   * and payable are two different reports read from two different tables, and
   * they are never added together. §9.1, §9.2.
   *
   * Tips come from `tips` — both modes, because the therapist earned both —
   * with reversed rows excluded on both sides of a reversal pair. What the
   * business OWES comes from the ledger, where a DIRECT_CASH tip deliberately
   * has no row at all.
   */
  async earnings(
    employeeId: string,
    query: EarningsQuery,
    actor: AuthUser,
  ): Promise<EarningsView> {
    assertMayReadEmployeeRecord(employeeId, actor);
    await this.assertEmployeeExists(employeeId, actor.branchId);

    // A therapist checking their earnings means "this month" unless they say
    // otherwise, which is also the period a payout is usually cut on.
    const { from, to } = resolveTradingWindow(query, monthStart);
    const window = { gte: businessDayColumn(from), lte: businessDayColumn(to) };
    const scope = { employeeId, branchId: actor.branchId };

    const tips = await this.prisma.tip.groupBy({
      by: ['type'],
      where: { ...scope, businessDay: window, reversedByTipId: null },
      _sum: { amountFils: true },
      _count: { _all: true },
    });
    const ledger = await this.prisma.therapistPayoutLedger.groupBy({
      by: ['entryType'],
      where: { ...scope, businessDay: window },
      _sum: { amountFils: true },
    });

    const tipLine = (type: TipType) => {
      const row = tips.find((t) => t.type === type);
      return { tipCount: row?._count._all ?? 0, totalFils: row?._sum.amountFils ?? 0 };
    };
    const entrySum = (entryType: PrismaLedgerEntryType) =>
      ledger.find((l) => l.entryType === entryType)?._sum.amountFils ?? 0;

    const directCash = tipLine(TipType.DIRECT_CASH);
    const collected = tipLine(TipType.COLLECTED_BY_BUSINESS);
    const commissionAccruedFils = entrySum(PrismaLedgerEntryType.COMMISSION_ACCRUAL);
    const adjustmentsFils = entrySum(PrismaLedgerEntryType.ADJUSTMENT);
    const reversalsFils = entrySum(PrismaLedgerEntryType.REVERSAL);
    const tipAccrualsFils = entrySum(PrismaLedgerEntryType.TIP_ACCRUAL);
    // Stored negative; a statement reads better with the magnitude. Written as
    // a subtraction rather than a negation so a quiet month reads 0 and not -0.
    const paidOutInPeriodFils = 0 - entrySum(PrismaLedgerEntryType.PAYOUT);

    const accruedInPeriodFils =
      tipAccrualsFils + commissionAccruedFils + adjustmentsFils + reversalsFils;

    return {
      employeeId,
      period: { from, to },
      cashReceivedDirectly: { label: CASH_LABEL, ...directCash },
      heldByBusinessAndPayable: {
        label: PAYABLE_LABEL,
        tipsCollected: collected,
        commissionAccruedFils,
        adjustmentsFils,
        reversalsFils,
        accruedInPeriodFils,
        paidOutInPeriodFils,
        balanceNowFils: await ledgerSumFils(this.prisma, scope),
        unbatchedFils: await ledgerSumFils(this.prisma, { ...scope, payoutBatchId: null }),
      },
      totalEarnedInPeriodFils: directCash.totalFils + accruedInPeriodFils,
      explanation: EXPLANATION,
    };
  }

  /**
   * Without this an unknown id answers with an empty ledger and a zero balance,
   * which reads exactly like "this therapist is owed nothing" — the single most
   * expensive way to be wrong on this endpoint.
   */
  private async assertEmployeeExists(employeeId: string, branchId: string): Promise<void> {
    const employee = await this.prisma.employee.findFirst({
      where: { id: employeeId, branchId, deletedAt: null },
      select: { id: true },
    });
    if (!employee) {
      throw new NotFoundException(
        apiError(ErrorCode.NOT_FOUND, 'No such therapist in this branch.'),
      );
    }
  }
}

/** The raw row shape, aliased to camelCase in the SELECT above. */
interface LedgerEntryRow {
  id: string;
  createdAt: Date;
  businessDay: Date;
  entryType: LedgerEntryType;
  amountFils: number;
  reservationRef: string | null;
  tipType: TipType | null;
  recordedBy: string | null;
  payoutBatchId: string | null;
  paidInBatchAt: Date | null;
  acknowledgedAt: Date | null;
  note: string | null;
}

function presentEntry(row: LedgerEntryRow): LedgerEntryView {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    businessDay: tradingDayOf(row.businessDay),
    entryType: row.entryType,
    amountFils: row.amountFils,
    reservationRef: row.reservationRef,
    tipType: row.tipType,
    recordedBy: row.recordedBy,
    payoutBatchId: row.payoutBatchId,
    paidInBatchAt: row.paidInBatchAt?.toISOString() ?? null,
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    note: row.note,
  };
}

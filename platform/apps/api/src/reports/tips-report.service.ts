import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TipsReportQuery } from '@berelax/contracts';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../common/request-context';
import {
  MONEY_LINE_LABELS,
  resolveReportWindow,
  tradingDayOf,
  type TipLine,
} from './reports.support';

export interface TipsByModeView {
  directCash: TipLine;
  collectedByBusiness: TipLine;
  /** Both modes. What the therapists earned; not what the business owes. §9.2. */
  totalFils: number;
  labels: { directCash: string; collectedByBusiness: string };
}

export interface TipsByTherapistView {
  employeeId: string;
  displayName: string;
  directCash: TipLine;
  collectedByBusiness: TipLine;
  totalEarnedFils: number;
  /**
   * SUM(amount_fils) over the WHOLE ledger, not the window — a balance is a
   * balance (§9.3). It includes commission accruals and is reduced by every
   * payout already made, so it will not equal this window's tips and is not
   * meant to.
   */
  outstandingPayableFils: number;
  /** Of that balance, what no payout batch has stamped yet. */
  unbatchedPayableFils: number;
}

export interface TipsByDayView {
  businessDay: string;
  directCash: TipLine;
  collectedByBusiness: TipLine;
  totalFils: number;
}

export interface TipsReportView {
  from: string;
  to: string;
  generatedAt: string;
  byMode: TipsByModeView;
  byTherapist: TipsByTherapistView[];
  byDay: TipsByDayView[];
  payable: {
    totalOutstandingFils: number;
    totalUnbatchedFils: number;
    basis: string;
  };
}

const PAYABLE_BASIS =
  'Outstanding payable is SUM(amount_fils) over the whole payout ledger, all time — not the ' +
  'window above. It is what BE RELAX owes right now: collected tips plus commission, less every ' +
  'payout already made. DIRECT_CASH tips are not in it and must never be added to it, because ' +
  'the business never held that money. Adding the two is how a spa pays a tip twice. §9.2, §9.3.';

/**
 * Where the tips went, and what is still owed. §7.4, MANAGER+ (§6.4).
 *
 * The report is in two halves that are computed from two different tables and
 * are never added together, which is the distinction the whole design rests on
 * (§9.1): `tips` says what the therapist EARNED in each mode; the ledger says
 * what the business OWES. A `DIRECT_CASH` tip appears in the first and is
 * absent from the second by design, and there is no row anywhere that bridges
 * them.
 *
 * Reversed pairs drop out of the earnings side entirely — both the original and
 * its negative mirror carry `reversed_by_tip_id`, so `IS NULL` removes the pair
 * rather than leaving the mirror behind as a negative tip. The ledger side keeps
 * its REVERSAL entry, which is how the liability comes off. §9.4.
 */
@Injectable()
export class TipsReportService {
  constructor(private readonly prisma: PrismaService) {}

  async tips(query: TipsReportQuery, actor: AuthUser): Promise<TipsReportView> {
    const { from, to } = resolveReportWindow(query);
    const branchId = actor.branchId;

    const [therapistRows, dayRows] = await this.prisma.$transaction(
      [
        // Per therapist: earned in the window from `tips`, owed over all time
        // from the ledger. The two subqueries are deliberately unbounded by
        // date — narrowing a balance to a window is how a therapist is told
        // they are owed less than they are.
        this.prisma.$queryRaw<TherapistRow[]>`
          WITH earned AS (
            SELECT t.employee_id                                                              AS "employeeId",
                   count(*) FILTER (WHERE t.type = 'DIRECT_CASH')::int                        AS "directCashCount",
                   COALESCE(SUM(t.amount_fils) FILTER (WHERE t.type = 'DIRECT_CASH'), 0)::int AS "directCashFils",
                   count(*) FILTER (WHERE t.type = 'COLLECTED_BY_BUSINESS')::int              AS "collectedCount",
                   COALESCE(SUM(t.amount_fils) FILTER (WHERE t.type = 'COLLECTED_BY_BUSINESS'), 0)::int
                                                                                              AS "collectedFils"
              FROM tips t
             WHERE t.branch_id = ${branchId}::uuid
               AND t.business_day BETWEEN ${from}::date AND ${to}::date
               AND t.reversed_by_tip_id IS NULL
             GROUP BY t.employee_id
          )
          SELECT e.id                                  AS "employeeId",
                 e.display_name                        AS "displayName",
                 COALESCE(en."directCashCount", 0)     AS "directCashCount",
                 COALESCE(en."directCashFils", 0)      AS "directCashFils",
                 COALESCE(en."collectedCount", 0)      AS "collectedCount",
                 COALESCE(en."collectedFils", 0)       AS "collectedFils",
                 (SELECT COALESCE(SUM(l.amount_fils), 0)::int
                    FROM therapist_payout_ledger l
                   WHERE l.employee_id = e.id
                     AND l.branch_id = ${branchId}::uuid)                     AS "outstandingPayableFils",
                 (SELECT COALESCE(SUM(l.amount_fils), 0)::int
                    FROM therapist_payout_ledger l
                   WHERE l.employee_id = e.id
                     AND l.branch_id = ${branchId}::uuid
                     AND l.payout_batch_id IS NULL)                           AS "unbatchedPayableFils"
            FROM employees e
            LEFT JOIN earned en ON en."employeeId" = e.id
           WHERE e.branch_id = ${branchId}::uuid
             AND e.deleted_at IS NULL
             AND (en."employeeId" IS NOT NULL
                  OR EXISTS (SELECT 1 FROM therapist_payout_ledger l
                              WHERE l.employee_id = e.id AND l.branch_id = ${branchId}::uuid))
           ORDER BY COALESCE(en."directCashFils", 0) + COALESCE(en."collectedFils", 0) DESC,
                    e.display_name`,

        // Per trading day. `business_day` is the stored trading day, so the
        // 01:30 tip is counted against the night it was given on. §3.3.
        this.prisma.$queryRaw<DayRow[]>`
          SELECT t.business_day                                                             AS "businessDay",
                 count(*) FILTER (WHERE t.type = 'DIRECT_CASH')::int                        AS "directCashCount",
                 COALESCE(SUM(t.amount_fils) FILTER (WHERE t.type = 'DIRECT_CASH'), 0)::int AS "directCashFils",
                 count(*) FILTER (WHERE t.type = 'COLLECTED_BY_BUSINESS')::int              AS "collectedCount",
                 COALESCE(SUM(t.amount_fils) FILTER (WHERE t.type = 'COLLECTED_BY_BUSINESS'), 0)::int
                                                                                            AS "collectedFils"
            FROM tips t
           WHERE t.branch_id = ${branchId}::uuid
             AND t.business_day BETWEEN ${from}::date AND ${to}::date
             AND t.reversed_by_tip_id IS NULL
           GROUP BY t.business_day
           ORDER BY t.business_day`,
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    const byTherapist = therapistRows.map(presentTherapist);
    const byDay = dayRows.map(presentDay);

    return {
      from,
      to,
      generatedAt: new Date().toISOString(),
      byMode: presentByMode(byDay),
      byTherapist,
      byDay,
      payable: {
        totalOutstandingFils: byTherapist.reduce((sum, row) => sum + row.outstandingPayableFils, 0),
        totalUnbatchedFils: byTherapist.reduce((sum, row) => sum + row.unbatchedPayableFils, 0),
        basis: PAYABLE_BASIS,
      },
    };
  }
}

interface TipRowBase {
  directCashCount: number;
  directCashFils: number;
  collectedCount: number;
  collectedFils: number;
}

interface TherapistRow extends TipRowBase {
  employeeId: string;
  displayName: string;
  outstandingPayableFils: number;
  unbatchedPayableFils: number;
}

interface DayRow extends TipRowBase {
  businessDay: Date;
}

function directCashOf(row: TipRowBase): TipLine {
  return { tipCount: row.directCashCount, totalFils: row.directCashFils };
}

function collectedOf(row: TipRowBase): TipLine {
  return { tipCount: row.collectedCount, totalFils: row.collectedFils };
}

function presentTherapist(row: TherapistRow): TipsByTherapistView {
  return {
    employeeId: row.employeeId,
    displayName: row.displayName,
    directCash: directCashOf(row),
    collectedByBusiness: collectedOf(row),
    totalEarnedFils: row.directCashFils + row.collectedFils,
    outstandingPayableFils: row.outstandingPayableFils,
    unbatchedPayableFils: row.unbatchedPayableFils,
  };
}

function presentDay(row: DayRow): TipsByDayView {
  return {
    businessDay: tradingDayOf(row.businessDay),
    directCash: directCashOf(row),
    collectedByBusiness: collectedOf(row),
    totalFils: row.directCashFils + row.collectedFils,
  };
}

/**
 * Rolled up from the per-day rows rather than asked for a fourth time. The day
 * rows and the therapist rows are two cuts of the same filtered set, so a
 * separate total query would be a third chance to disagree with itself.
 */
function presentByMode(days: TipsByDayView[]): TipsByModeView {
  const directCash: TipLine = { tipCount: 0, totalFils: 0 };
  const collectedByBusiness: TipLine = { tipCount: 0, totalFils: 0 };

  for (const day of days) {
    directCash.tipCount += day.directCash.tipCount;
    directCash.totalFils += day.directCash.totalFils;
    collectedByBusiness.tipCount += day.collectedByBusiness.tipCount;
    collectedByBusiness.totalFils += day.collectedByBusiness.totalFils;
  }

  return {
    directCash,
    collectedByBusiness,
    totalFils: directCash.totalFils + collectedByBusiness.totalFils,
    labels: {
      directCash: MONEY_LINE_LABELS.tipsDirectCash,
      collectedByBusiness: MONEY_LINE_LABELS.tipsCollectedByBusiness,
    },
  };
}

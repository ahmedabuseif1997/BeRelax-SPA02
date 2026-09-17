import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ReportGroupBy, RevenueReportQuery } from '@berelax/contracts';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../common/request-context';
import {
  MONEY_LINE_LABELS,
  resolveReportWindow,
  tradingDayOf,
} from './reports.support';

export interface RevenuePeriodView {
  /** The first TRADING day this row covers, clipped to the window asked for. */
  periodStart: string;
  /** The last, inclusive. A part-week at either end says so instead of pretending. */
  periodEnd: string;
  label: string;
  completedVisits: number;
  noShows: number;
  cancellations: number;
  /** BASE payments taken at the desk. */
  baseCollectedFils: number;
  /** Negative. Refunds of BASE payments, filed on the day the money went back. */
  baseRefundedFils: number;
  /** Signed. Discounts, goodwill, late corrections. */
  adjustmentsFils: number;
  /** base + refunds + adjustments. THIS is the revenue line, and the only one. */
  netRevenueFils: number;
  /** A pass-through the business owes out. NOT revenue. §9.1. */
  tipsCollectedByBusinessFils: number;
  /** Never entered the business at all. NOT revenue. §9.2. */
  tipsDirectCashFils: number;
}

export type RevenueTotalsView = Omit<RevenuePeriodView, 'periodStart' | 'periodEnd' | 'label'>;

export interface RevenueReportView {
  from: string;
  to: string;
  groupBy: ReportGroupBy;
  generatedAt: string;
  periods: RevenuePeriodView[];
  totals: RevenueTotalsView;
  /**
   * The three series, named. Tips are reported beside revenue and never inside
   * it, and the label travels with the number so a figure lifted into a slide
   * carries its own caption. §9.1.
   */
  legend: typeof MONEY_LINE_LABELS;
}

/**
 * Base revenue over time, with both tip modes alongside it and neither inside
 * it. §7.4.
 *
 * Three things decide whether this report is right:
 *
 *  1. **The bucket is a trading day.** Every table read here carries a stored
 *     `business_day`, so the 01:30 takings land on the night that earned them.
 *     `date_trunc('week'|'month', business_day)` rolls trading days up into
 *     bigger trading periods; `date_trunc('day', collected_at)` would be the
 *     reporting bug §3.3 names, and it is not used anywhere in this file.
 *  2. **A tip is not revenue.** `COLLECTED_BY_BUSINESS` is money the business is
 *     holding for somebody else and `DIRECT_CASH` never reached it. Both are
 *     reported, both are labelled, neither is added to `netRevenueFils`.
 *  3. **A refund is filed against what it reverses.** Sending a tip back does
 *     not reduce base revenue — the same distinction §13.3's invariant 4b
 *     exists to protect.
 *
 * The spine is generated rather than derived from the rows, so a night with no
 * trading is a zero in the series instead of a gap that reads as missing data.
 */
@Injectable()
export class RevenueReportService {
  constructor(private readonly prisma: PrismaService) {}

  async revenue(query: RevenueReportQuery, actor: AuthUser): Promise<RevenueReportView> {
    const { from, to } = resolveReportWindow(query);
    const branchId = actor.branchId;
    const groupBy = query.groupBy;

    const rows = await this.prisma.$queryRaw<RevenueRow[]>`
      WITH spine AS (
        SELECT DISTINCT ${bucketOf(Prisma.sql`d.day::date`, groupBy)} AS bucket
          FROM generate_series(${from}::date, ${to}::date, interval '1 day') AS d(day)
      ),
      money AS (
        SELECT ${bucketOf(Prisma.sql`p.business_day`, groupBy)}                         AS bucket,
               COALESCE(SUM(p.amount_fils) FILTER (WHERE p.kind = 'BASE'), 0)::int      AS "baseCollectedFils",
               COALESCE(SUM(p.amount_fils) FILTER (
                 WHERE p.kind = 'REFUND' AND orig.kind IS DISTINCT FROM 'TIP'), 0)::int AS "baseRefundedFils",
               COALESCE(SUM(p.amount_fils) FILTER (WHERE p.kind = 'ADJUSTMENT'), 0)::int AS "adjustmentsFils",
               COALESCE(SUM(p.amount_fils) FILTER (
                 WHERE p.kind = 'TIP' OR (p.kind = 'REFUND' AND orig.kind = 'TIP')), 0)::int
                                                                                        AS "tipsCollectedByBusinessFils"
          FROM payments p
          LEFT JOIN payments orig ON orig.id = p.reverses_payment_id
         WHERE p.branch_id = ${branchId}::uuid
           AND p.business_day BETWEEN ${from}::date AND ${to}::date
         GROUP BY 1
      ),
      visits AS (
        SELECT ${bucketOf(Prisma.sql`r.business_day`, groupBy)}          AS bucket,
               count(*) FILTER (WHERE r.status = 'COMPLETED')::int       AS "completedVisits",
               count(*) FILTER (WHERE r.status = 'NO_SHOW')::int         AS "noShows",
               count(*) FILTER (WHERE r.status = 'CANCELLED')::int       AS "cancellations"
          FROM reservations r
         WHERE r.branch_id = ${branchId}::uuid
           AND r.business_day BETWEEN ${from}::date AND ${to}::date
         GROUP BY 1
      ),
      cash_tips AS (
        SELECT ${bucketOf(Prisma.sql`t.business_day`, groupBy)}                             AS bucket,
               COALESCE(SUM(t.amount_fils) FILTER (WHERE t.type = 'DIRECT_CASH'), 0)::int   AS "tipsDirectCashFils"
          FROM tips t
         WHERE t.branch_id = ${branchId}::uuid
           AND t.business_day BETWEEN ${from}::date AND ${to}::date
           AND t.reversed_by_tip_id IS NULL
         GROUP BY 1
      )
      SELECT GREATEST(s.bucket, ${from}::date)                          AS "periodStart",
             LEAST(${bucketEnd(groupBy)}, ${to}::date)                  AS "periodEnd",
             COALESCE(v."completedVisits", 0)                           AS "completedVisits",
             COALESCE(v."noShows", 0)                                   AS "noShows",
             COALESCE(v."cancellations", 0)                             AS "cancellations",
             COALESCE(m."baseCollectedFils", 0)                         AS "baseCollectedFils",
             COALESCE(m."baseRefundedFils", 0)                          AS "baseRefundedFils",
             COALESCE(m."adjustmentsFils", 0)                           AS "adjustmentsFils",
             COALESCE(m."tipsCollectedByBusinessFils", 0)               AS "tipsCollectedByBusinessFils",
             COALESCE(c."tipsDirectCashFils", 0)                        AS "tipsDirectCashFils"
        FROM spine s
        LEFT JOIN money     m ON m.bucket = s.bucket
        LEFT JOIN visits    v ON v.bucket = s.bucket
        LEFT JOIN cash_tips c ON c.bucket = s.bucket
       ORDER BY s.bucket`;

    const periods = rows.map((row) => presentPeriod(row, groupBy));

    return {
      from,
      to,
      groupBy,
      generatedAt: new Date().toISOString(),
      periods,
      totals: totalOf(periods),
      legend: MONEY_LINE_LABELS,
    };
  }
}

/**
 * The bucket expression, built from the zod-validated `groupBy` and nothing
 * else. `Prisma.sql` composes the fragment rather than concatenating a string,
 * and the three branches are a closed set — there is no path by which a caller's
 * text reaches the statement.
 *
 * `date_trunc` is applied to `business_day`, a `date` column that is already the
 * trading day. That is the opposite of the §3.3 mistake: this rolls trading days
 * up into weeks and months; it never re-derives a day from a timestamp.
 */
function bucketOf(column: Prisma.Sql, groupBy: ReportGroupBy): Prisma.Sql {
  switch (groupBy) {
    case ReportGroupBy.MONTH:
      return Prisma.sql`date_trunc('month', ${column})::date`;
    case ReportGroupBy.WEEK:
      // ISO weeks, so a week always starts on a Monday and two reports of the
      // same range never disagree about where a week began.
      return Prisma.sql`date_trunc('week', ${column})::date`;
    default:
      return column;
  }
}

/** The last day the bucket covers, before it is clipped to the window. */
function bucketEnd(groupBy: ReportGroupBy): Prisma.Sql {
  switch (groupBy) {
    case ReportGroupBy.MONTH:
      return Prisma.sql`(s.bucket + interval '1 month' - interval '1 day')::date`;
    case ReportGroupBy.WEEK:
      return Prisma.sql`(s.bucket + 6)`;
    default:
      return Prisma.sql`s.bucket`;
  }
}

interface RevenueRow {
  periodStart: Date;
  periodEnd: Date;
  completedVisits: number;
  noShows: number;
  cancellations: number;
  baseCollectedFils: number;
  baseRefundedFils: number;
  adjustmentsFils: number;
  tipsCollectedByBusinessFils: number;
  tipsDirectCashFils: number;
}

const MONTH_LABEL = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  month: 'long',
  year: 'numeric',
});

function presentPeriod(row: RevenueRow, groupBy: ReportGroupBy): RevenuePeriodView {
  const periodStart = tradingDayOf(row.periodStart);
  const periodEnd = tradingDayOf(row.periodEnd);

  return {
    periodStart,
    periodEnd,
    label: labelFor(periodStart, periodEnd, groupBy),
    completedVisits: row.completedVisits,
    noShows: row.noShows,
    cancellations: row.cancellations,
    baseCollectedFils: row.baseCollectedFils,
    baseRefundedFils: row.baseRefundedFils,
    adjustmentsFils: row.adjustmentsFils,
    // Tips are deliberately absent from this sum, in both modes. §9.1.
    netRevenueFils: row.baseCollectedFils + row.baseRefundedFils + row.adjustmentsFils,
    tipsCollectedByBusinessFils: row.tipsCollectedByBusinessFils,
    tipsDirectCashFils: row.tipsDirectCashFils,
  };
}

function labelFor(periodStart: string, periodEnd: string, groupBy: ReportGroupBy): string {
  if (groupBy === ReportGroupBy.DAY) return periodStart;
  if (groupBy === ReportGroupBy.MONTH) {
    return MONTH_LABEL.format(new Date(`${periodStart}T12:00:00Z`));
  }
  return `${periodStart} – ${periodEnd}`;
}

function totalOf(periods: RevenuePeriodView[]): RevenueTotalsView {
  const zero: RevenueTotalsView = {
    completedVisits: 0,
    noShows: 0,
    cancellations: 0,
    baseCollectedFils: 0,
    baseRefundedFils: 0,
    adjustmentsFils: 0,
    netRevenueFils: 0,
    tipsCollectedByBusinessFils: 0,
    tipsDirectCashFils: 0,
  };

  return periods.reduce<RevenueTotalsView>(
    (total, period) => ({
      completedVisits: total.completedVisits + period.completedVisits,
      noShows: total.noShows + period.noShows,
      cancellations: total.cancellations + period.cancellations,
      baseCollectedFils: total.baseCollectedFils + period.baseCollectedFils,
      baseRefundedFils: total.baseRefundedFils + period.baseRefundedFils,
      adjustmentsFils: total.adjustmentsFils + period.adjustmentsFils,
      netRevenueFils: total.netRevenueFils + period.netRevenueFils,
      tipsCollectedByBusinessFils:
        total.tipsCollectedByBusinessFils + period.tipsCollectedByBusinessFils,
      tipsDirectCashFils: total.tipsDirectCashFils + period.tipsDirectCashFils,
    }),
    zero,
  );
}

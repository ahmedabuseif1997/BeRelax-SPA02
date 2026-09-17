import { Injectable } from '@nestjs/common';
import { UtilisationReportQuery } from '@berelax/contracts';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../common/request-context';
import {
  MONEY_LINE_LABELS,
  percentOrNull,
  resolveReportWindow,
  type TipLine,
} from './reports.support';

export interface TherapistUtilisationView {
  employeeId: string;
  displayName: string;
  sessions: number;
  /** Treatment minutes actually delivered — COMPLETED bookings only. */
  minutesBooked: number;
  /** From `shifts`: planned_end − planned_start, ABSENT shifts excluded. */
  minutesRostered: number;
  /** From the clock, where both ends were pressed. Reported, never divided by. */
  minutesClocked: number;
  shifts: number;
  daysWorked: number;
  /** booked ÷ rostered, one decimal. NULL when nothing was rostered. */
  utilisationPct: number | null;
  noShows: number;
  /** Minutes held for a guest who never arrived. Idle, but not the therapist's idle. */
  minutesLostToNoShows: number;
  /**
   * What the business took for this therapist's hours: base payments, net of
   * base refunds and adjustments. The same definition `/reports/revenue` calls
   * `netRevenueFils`, so the two reports reconcile. Tips are in neither.
   */
  revenueGeneratedFils: number;
  tips: {
    directCash: TipLine;
    collectedByBusiness: TipLine;
  };
}

export interface UtilisationReportView {
  from: string;
  to: string;
  generatedAt: string;
  therapists: TherapistUtilisationView[];
  totals: {
    sessions: number;
    minutesBooked: number;
    minutesRostered: number;
    utilisationPct: number | null;
    revenueGeneratedFils: number;
    tipsDirectCashFils: number;
    tipsCollectedByBusinessFils: number;
  };
  basis: string;
}

const BASIS =
  'Utilisation is treatment minutes delivered over minutes ROSTERED on `shifts` — not over the ' +
  '11:00–02:00 trading window. A therapist who worked a four-hour shift is not idle for the ' +
  'other eleven hours, and a report that says they are will be argued with, correctly. Shifts ' +
  'marked ABSENT are excluded from the divisor: nobody was there to be utilised.';

/**
 * Per therapist, over a range of trading days. §7.4, MANAGER+ (§6.4).
 *
 * One statement. Four aggregates — worked, rostered, earned, tipped — are each
 * rolled up to one row per employee inside their own CTE and then joined onto
 * `employees` once. Doing it the obvious way, a query per therapist inside a
 * loop, is the N+1 this deliberately avoids; doing it as one flat join would
 * multiply payments by tips by shifts and inflate every total on the page.
 *
 * Employees with no activity at all in the window are left out rather than
 * listed as rows of zeros: a twenty-strong roster where five people worked
 * should read as five people, and "0 %" against somebody who was on leave is a
 * number that starts an argument about nothing.
 */
@Injectable()
export class UtilisationReportService {
  constructor(private readonly prisma: PrismaService) {}

  async utilisation(
    query: UtilisationReportQuery,
    actor: AuthUser,
  ): Promise<UtilisationReportView> {
    const { from, to } = resolveReportWindow(query);
    const branchId = actor.branchId;

    const rows = await this.prisma.$queryRaw<UtilisationRow[]>`
      WITH worked AS (
        SELECT r.employee_id                                                              AS "employeeId",
               count(*) FILTER (WHERE r.status = 'COMPLETED')::int                        AS "sessions",
               COALESCE(SUM(r.duration_minutes) FILTER (WHERE r.status = 'COMPLETED'), 0)::int
                                                                                          AS "minutesBooked",
               count(DISTINCT r.business_day) FILTER (WHERE r.status = 'COMPLETED')::int  AS "daysWorked",
               count(*) FILTER (WHERE r.status = 'NO_SHOW')::int                          AS "noShows",
               COALESCE(SUM(r.duration_minutes) FILTER (WHERE r.status = 'NO_SHOW'), 0)::int
                                                                                          AS "minutesLostToNoShows"
          FROM reservations r
         WHERE r.branch_id = ${branchId}::uuid
           AND r.business_day BETWEEN ${from}::date AND ${to}::date
         GROUP BY r.employee_id
      ),
      rostered AS (
        SELECT s.employee_id                                                              AS "employeeId",
               count(*)::int                                                              AS "shifts",
               COALESCE(SUM(EXTRACT(EPOCH FROM (s.planned_end - s.planned_start)) / 60), 0)::int
                                                                                          AS "minutesRostered",
               COALESCE(SUM(EXTRACT(EPOCH FROM (s.clock_out_at - s.clock_in_at)) / 60)
                        FILTER (WHERE s.clock_in_at IS NOT NULL AND s.clock_out_at IS NOT NULL), 0)::int
                                                                                          AS "minutesClocked"
          FROM shifts s
         WHERE s.branch_id = ${branchId}::uuid
           AND s.business_day BETWEEN ${from}::date AND ${to}::date
           AND s.status <> 'ABSENT'
         GROUP BY s.employee_id
      ),
      earned AS (
        -- Base, plus the corrections that belong to it: a base refund and a
        -- discount both reduce what the business took for this therapist's
        -- hours. The three kinds together are exactly netRevenueFils on
        -- /reports/revenue, so the per-therapist column and the revenue report
        -- reconcile by construction rather than by coincidence. A refunded TIP
        -- is excluded: it was never revenue to give back.
        SELECT r.employee_id                                                              AS "employeeId",
               COALESCE(SUM(p.amount_fils) FILTER (
                 WHERE p.kind IN ('BASE', 'ADJUSTMENT')
                    OR (p.kind = 'REFUND' AND orig.kind IS DISTINCT FROM 'TIP')), 0)::int AS "revenueGeneratedFils"
          FROM payments p
          JOIN reservations r ON r.id = p.reservation_id
          LEFT JOIN payments orig ON orig.id = p.reverses_payment_id
         WHERE p.branch_id = ${branchId}::uuid
           AND p.business_day BETWEEN ${from}::date AND ${to}::date
         GROUP BY r.employee_id
      ),
      tipped AS (
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
      SELECT e.id                                          AS "employeeId",
             e.display_name                                AS "displayName",
             COALESCE(w."sessions", 0)                     AS "sessions",
             COALESCE(w."minutesBooked", 0)                AS "minutesBooked",
             COALESCE(w."daysWorked", 0)                   AS "daysWorked",
             COALESCE(w."noShows", 0)                      AS "noShows",
             COALESCE(w."minutesLostToNoShows", 0)         AS "minutesLostToNoShows",
             COALESCE(ro."shifts", 0)                      AS "shifts",
             COALESCE(ro."minutesRostered", 0)             AS "minutesRostered",
             COALESCE(ro."minutesClocked", 0)              AS "minutesClocked",
             COALESCE(ea."revenueGeneratedFils", 0)        AS "revenueGeneratedFils",
             COALESCE(ti."directCashCount", 0)             AS "directCashCount",
             COALESCE(ti."directCashFils", 0)              AS "directCashFils",
             COALESCE(ti."collectedCount", 0)              AS "collectedCount",
             COALESCE(ti."collectedFils", 0)               AS "collectedFils"
        FROM employees e
        LEFT JOIN worked   w  ON w."employeeId"  = e.id
        LEFT JOIN rostered ro ON ro."employeeId" = e.id
        LEFT JOIN earned   ea ON ea."employeeId" = e.id
        LEFT JOIN tipped   ti ON ti."employeeId" = e.id
       WHERE e.branch_id = ${branchId}::uuid
         AND e.deleted_at IS NULL
         AND (w."employeeId" IS NOT NULL OR ro."employeeId" IS NOT NULL)
       ORDER BY COALESCE(w."minutesBooked", 0) DESC, e.display_name`;

    const therapists = rows.map(present);

    return {
      from,
      to,
      generatedAt: new Date().toISOString(),
      therapists,
      totals: totalOf(therapists),
      basis: `${BASIS} ${MONEY_LINE_LABELS.revenue}.`,
    };
  }
}

interface UtilisationRow {
  employeeId: string;
  displayName: string;
  sessions: number;
  minutesBooked: number;
  daysWorked: number;
  noShows: number;
  minutesLostToNoShows: number;
  shifts: number;
  minutesRostered: number;
  minutesClocked: number;
  revenueGeneratedFils: number;
  directCashCount: number;
  directCashFils: number;
  collectedCount: number;
  collectedFils: number;
}

function present(row: UtilisationRow): TherapistUtilisationView {
  return {
    employeeId: row.employeeId,
    displayName: row.displayName,
    sessions: row.sessions,
    minutesBooked: row.minutesBooked,
    minutesRostered: row.minutesRostered,
    minutesClocked: row.minutesClocked,
    shifts: row.shifts,
    daysWorked: row.daysWorked,
    utilisationPct: percentOrNull(row.minutesBooked, row.minutesRostered),
    noShows: row.noShows,
    minutesLostToNoShows: row.minutesLostToNoShows,
    revenueGeneratedFils: row.revenueGeneratedFils,
    tips: {
      directCash: { tipCount: row.directCashCount, totalFils: row.directCashFils },
      collectedByBusiness: { tipCount: row.collectedCount, totalFils: row.collectedFils },
    },
  };
}

function totalOf(rows: TherapistUtilisationView[]): UtilisationReportView['totals'] {
  const minutesBooked = rows.reduce((sum, row) => sum + row.minutesBooked, 0);
  const minutesRostered = rows.reduce((sum, row) => sum + row.minutesRostered, 0);

  return {
    sessions: rows.reduce((sum, row) => sum + row.sessions, 0),
    minutesBooked,
    minutesRostered,
    // Recomputed from the totals, not averaged from the rows: a therapist who
    // worked one shift and a therapist who worked twenty do not each get an
    // equal vote in the floor's utilisation.
    utilisationPct: percentOrNull(minutesBooked, minutesRostered),
    revenueGeneratedFils: rows.reduce((sum, row) => sum + row.revenueGeneratedFils, 0),
    tipsDirectCashFils: rows.reduce((sum, row) => sum + row.tips.directCash.totalFils, 0),
    tipsCollectedByBusinessFils: rows.reduce(
      (sum, row) => sum + row.tips.collectedByBusiness.totalFils,
      0,
    ),
  };
}

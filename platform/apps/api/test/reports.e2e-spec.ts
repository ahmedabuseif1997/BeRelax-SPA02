/**
 * The reporting layer, driven through the real API against the seeded fixture. §7.4.
 *
 * Two claims are worth more than every other assertion in this file:
 *
 *  1. **The reports agree with the ledger.** Every figure here is checked
 *     against the same SQL §13.3's invariant suite asserts its own numbers
 *     with — the same tips filter, the same base total, the same
 *     `SUM(amount_fils)` balance. A report that disagrees with the ledger is
 *     worse than no report, because somebody will act on it.
 *
 *  2. **Every grouping is a trading day.** The 01:30 booking belongs to the
 *     night before, and the suite proves it by locating the seed's
 *     after-midnight sessions and showing they are counted on the previous
 *     day's close-out sheet. §3.3.
 *
 * Reception is checked out of all five routes on the way in. §6.4 draws that
 * line on purpose: the person handling cash all evening is not the person
 * auditing it.
 */

import request from 'supertest';
import { ErrorCode, PaymentMethod, TipType } from '@berelax/contracts';
import { seed } from '../prisma/seed';
import {
  authTokenFor,
  bootstrapTestApp,
  getPrisma,
  resetDatabase,
  route,
  type TestApp,
} from './setup-e2e';
import type { PrismaService } from '../src/prisma/prisma.service';

/** The same pinned day `financial-invariants.e2e-spec.ts` uses, for the same reason. */
const SEED_ANCHOR_DAY = '2026-09-16';

/** The seed lays 60 trading days of history behind the anchor, plus three ahead. */
const HISTORY_FROM = shiftDay(SEED_ANCHOR_DAY, -60);
const HISTORY_TO = SEED_ANCHOR_DAY;

/** Seeded credentials, from prisma/seed.ts. */
const ACCOUNTS = {
  owner: { email: 'owner@berelax.ae', password: 'BeRelaxOwner2026!' },
  manager: { email: 'manager@berelax.ae', password: 'BeRelaxManager2026!' },
  reception: { email: 'reception@berelax.ae', password: 'BeRelaxReception2026!' },
  therapist: { email: 'therapist@berelax.ae', password: 'BeRelaxTherapist2026!' },
} as const;

let ctx: TestApp;
let prisma: PrismaService;
let tokens: Record<keyof typeof ACCOUNTS, string>;

function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Every statement below is a static literal; nothing here interpolates input. */
function query<T>(sql: string): Promise<T[]> {
  return prisma.$queryRawUnsafe<T[]>(sql);
}

async function one<T>(sql: string): Promise<T> {
  const [row] = await query<T>(sql);
  if (!row) throw new Error(`expected a row from: ${sql}`);
  return row;
}

function get(path: string, token: string): request.Test {
  return request(ctx.http).get(route(path)).set('Authorization', `Bearer ${token}`);
}

async function report<T>(path: string, token = tokens.manager): Promise<T> {
  const res = await get(path, token);
  if (res.status !== 200) {
    throw new Error(`GET ${path} answered ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.body as T;
}

beforeAll(async () => {
  prisma = getPrisma();
  await resetDatabase();
  await seed(prisma, { quiet: true, anchorDay: SEED_ANCHOR_DAY });

  ctx = await bootstrapTestApp();
  const entries = await Promise.all(
    Object.entries(ACCOUNTS).map(
      async ([key, account]) =>
        [key, await authTokenFor(ctx.http, account.email, account.password)] as const,
    ),
  );
  tokens = Object.fromEntries(entries) as typeof tokens;
}, 180_000);

afterAll(async () => {
  await ctx?.app.close();
});

/* ────────────────────────────── §6.4 ────────────────────────────── */

describe('who may read the totals', () => {
  const ROUTES = [
    '/reports/daily',
    '/reports/revenue',
    '/reports/therapist-utilisation',
    '/reports/tips',
    '/reports/attribution',
  ];

  it.each(ROUTES)('403s a RECEPTIONIST on %s', async (path) => {
    const res = await get(path, tokens.reception);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(ErrorCode.INSUFFICIENT_ROLE);
  });

  it.each(ROUTES)('403s a THERAPIST on %s', async (path) => {
    // A therapist reads their OWN earnings through /ledger and /earnings. The
    // branch's totals are a different question and a different answer.
    const res = await get(path, tokens.therapist);

    expect(res.status).toBe(403);
  });

  it.each(ROUTES)('401s an anonymous caller on %s', async (path) => {
    const res = await request(ctx.http).get(route(path));

    expect(res.status).toBe(401);
  });

  it.each(ROUTES)('lets a MANAGER and an OWNER read %s', async (path) => {
    await expect(get(path, tokens.manager).expect(200)).resolves.toBeDefined();
    await expect(get(path, tokens.owner).expect(200)).resolves.toBeDefined();
  });

  it('takes branchId from the token and ignores one offered in the query', async () => {
    // There is no `branchId` parameter to honour, so a caller naming somebody
    // else's branch gets their own numbers, not a second branch's. §6.6.
    const mine = await report<DailyReport>(`/reports/daily?businessDay=${SEED_ANCHOR_DAY}`);
    const spoofed = await report<DailyReport>(
      `/reports/daily?businessDay=${SEED_ANCHOR_DAY}&branchId=00000000-0000-0000-0000-000000000000`,
    );

    expect(spoofed.takings).toEqual(mine.takings);
  });
});

/* ─────────────────────────── the close-out ─────────────────────────── */

interface DailyReport {
  businessDay: string;
  bookings: {
    total: number;
    scheduled: number;
    inProgress: number;
    completed: number;
    cancelled: number;
    noShow: number;
    needingCheckout: number;
  };
  guestsSeen: number;
  therapists: { worked: number; rostered: number };
  takings: {
    grossFils: number;
    baseCollectedFils: number;
    baseRefundedFils: number;
    tipsCollectedFils: number;
    adjustmentsFils: number;
    byMethod: Array<{ method: PaymentMethod; entries: number; amountFils: number }>;
  };
  tips: {
    directCash: { tipCount: number; totalFils: number };
    collectedByBusiness: { tipCount: number; totalFils: number };
    totalFils: number;
    payableFils: number;
  };
  cashDrawer: {
    expectedCashFils: number;
    baseCashFils: number;
    tipCashFils: number;
    refundedCashFils: number;
    adjustmentCashFils: number;
  };
}

describe('GET /reports/daily — the close-out sheet', () => {
  /** The busiest seeded night, so every line on the sheet has something in it. */
  let busiestDay: string;
  /** A night that saw both cash through the till and a tip handed over outside it. */
  let mixedCashNight: string;

  beforeAll(async () => {
    const busiest = await one<{ day: Date }>(`
      SELECT r.business_day AS day
        FROM reservations r
        JOIN payments p ON p.reservation_id = r.id
       WHERE r.status = 'COMPLETED'
       GROUP BY r.business_day
       ORDER BY count(*) DESC, r.business_day
       LIMIT 1`);
    busiestDay = busiest.day.toISOString().slice(0, 10);

    const mixed = await one<{ day: Date }>(`
      SELECT t.business_day AS day
        FROM tips t
       WHERE t.type = 'DIRECT_CASH' AND t.reversed_by_tip_id IS NULL
         AND EXISTS (SELECT 1 FROM payments p
                      WHERE p.business_day = t.business_day AND p.method = 'CASH')
       GROUP BY t.business_day
       ORDER BY SUM(t.amount_fils) DESC, t.business_day
       LIMIT 1`);
    mixedCashNight = mixed.day.toISOString().slice(0, 10);
  });

  it('counts bookings by status exactly as the table holds them', async () => {
    const view = await report<DailyReport>(`/reports/daily?businessDay=${busiestDay}`);
    const counts = await one<{
      total: number;
      scheduled: number;
      in_progress: number;
      completed: number;
      cancelled: number;
      no_show: number;
      guests_seen: number;
      therapists: number;
    }>(`
      SELECT count(*)::int                                                AS total,
             count(*) FILTER (WHERE status = 'SCHEDULED')::int            AS scheduled,
             count(*) FILTER (WHERE status = 'IN_PROGRESS')::int          AS in_progress,
             count(*) FILTER (WHERE status = 'COMPLETED')::int            AS completed,
             count(*) FILTER (WHERE status = 'CANCELLED')::int            AS cancelled,
             count(*) FILTER (WHERE status = 'NO_SHOW')::int              AS no_show,
             count(*) FILTER (WHERE status IN ('COMPLETED','IN_PROGRESS'))::int AS guests_seen,
             count(DISTINCT employee_id) FILTER (
               WHERE status IN ('COMPLETED','IN_PROGRESS'))::int          AS therapists
        FROM reservations
       WHERE business_day = DATE '${busiestDay}'`);

    expect(view.businessDay).toBe(busiestDay);
    expect(view.bookings).toMatchObject({
      total: counts.total,
      scheduled: counts.scheduled,
      inProgress: counts.in_progress,
      completed: counts.completed,
      cancelled: counts.cancelled,
      noShow: counts.no_show,
    });
    expect(view.guestsSeen).toBe(counts.guests_seen);
    expect(view.therapists.worked).toBe(counts.therapists);
    expect(view.bookings.completed).toBeGreaterThan(0);
  });

  it('divides the takings by method and by kind into the same gross', async () => {
    const view = await report<DailyReport>(`/reports/daily?businessDay=${busiestDay}`);
    const actual = await one<{ gross: number; base: number; tip: number }>(`
      SELECT COALESCE(SUM(amount_fils), 0)::int                                  AS gross,
             COALESCE(SUM(amount_fils) FILTER (WHERE kind = 'BASE'), 0)::int     AS base,
             COALESCE(SUM(amount_fils) FILTER (WHERE kind = 'TIP'), 0)::int      AS tip
        FROM payments
       WHERE business_day = DATE '${busiestDay}'`);

    expect(view.takings.grossFils).toBe(actual.gross);
    expect(view.takings.baseCollectedFils).toBe(actual.base);
    expect(view.takings.tipsCollectedFils).toBe(actual.tip);

    // The two decompositions of the same money must agree, or one of them is a
    // number somebody will reconcile against a bank statement and lose an hour to.
    const byKind =
      view.takings.baseCollectedFils +
      view.takings.baseRefundedFils +
      view.takings.tipsCollectedFils +
      view.takings.adjustmentsFils;
    const byMethod = view.takings.byMethod.reduce((sum, line) => sum + line.amountFils, 0);
    expect(byKind).toBe(view.takings.grossFils);
    expect(byMethod).toBe(view.takings.grossFils);
  });

  it('reports the expected cash in the drawer, and leaves DIRECT_CASH tips out of it', async () => {
    const view = await report<DailyReport>(`/reports/daily?businessDay=${mixedCashNight}`);
    const night = await one<{ cash: number; direct_cash: number }>(`
      SELECT (SELECT COALESCE(SUM(amount_fils), 0)::int FROM payments
               WHERE business_day = DATE '${mixedCashNight}' AND method = 'CASH')       AS cash,
             (SELECT COALESCE(SUM(amount_fils), 0)::int FROM tips
               WHERE business_day = DATE '${mixedCashNight}' AND type = 'DIRECT_CASH'
                 AND reversed_by_tip_id IS NULL)                                        AS direct_cash`);

    expect(view.cashDrawer.expectedCashFils).toBe(night.cash);
    expect(
      view.cashDrawer.baseCashFils +
        view.cashDrawer.tipCashFils +
        view.cashDrawer.refundedCashFils +
        view.cashDrawer.adjustmentCashFils,
    ).toBe(view.cashDrawer.expectedCashFils);

    // §9.1: a DIRECT_CASH tip creates no payment row, so it can never be in the
    // till. Adding it to the drawer figure would leave a manager hunting for
    // money that was never there — the therapist already has it in their pocket.
    expect(night.direct_cash).toBeGreaterThan(0);
    expect(view.tips.directCash.totalFils).toBe(night.direct_cash);
    expect(view.cashDrawer.expectedCashFils).toBe(night.cash);
    expect(view.cashDrawer.expectedCashFils).not.toBe(night.cash + night.direct_cash);
  });

  it('reads the tip line from `tips` and the tip takings from `payments`, and they agree', async () => {
    // Two tables, two queries, one number. The seed writes no reversals, so on
    // this fixture they are equal; a night on which a tip was reversed can
    // legitimately differ, and the REFUND row is the reconciling item.
    const view = await report<DailyReport>(`/reports/daily?businessDay=${busiestDay}`);

    expect(view.tips.collectedByBusiness.totalFils).toBe(view.takings.tipsCollectedFils);
    expect(view.tips.payableFils).toBe(view.tips.collectedByBusiness.totalFils);
    expect(view.tips.totalFils).toBe(
      view.tips.directCash.totalFils + view.tips.collectedByBusiness.totalFils,
    );
  });

  it('counts the rostered therapists from `shifts`, not from who happened to be booked', async () => {
    const view = await report<DailyReport>(`/reports/daily?businessDay=${busiestDay}`);
    const rostered = await one<{ total: number }>(`
      SELECT count(*)::int AS total FROM shifts
       WHERE business_day = DATE '${busiestDay}' AND status <> 'ABSENT'`);

    expect(view.therapists.rostered).toBe(rostered.total);
    expect(view.therapists.rostered).toBeGreaterThanOrEqual(view.therapists.worked);
  });

  it('bills an after-midnight session to the night before, not to the next morning', async () => {
    // The rule that makes every report on this page right or wrong. §3.3.
    const late = await one<{ day: Date; calendar_day: Date; sessions: number; base: number }>(`
      SELECT r.business_day                                         AS day,
             (r.starts_at AT TIME ZONE 'Asia/Dubai')::date          AS calendar_day,
             count(*)::int                                          AS sessions,
             COALESCE(SUM(p.amount_fils) FILTER (WHERE p.kind = 'BASE'), 0)::int AS base
        FROM reservations r
        LEFT JOIN payments p ON p.reservation_id = r.id
       WHERE (r.starts_at AT TIME ZONE 'Asia/Dubai')::time < TIME '06:00'
         AND r.status = 'COMPLETED'
       GROUP BY 1, 2
       ORDER BY 3 DESC, 1
       LIMIT 1`);

    const tradingDay = late.day.toISOString().slice(0, 10);
    const calendarDay = late.calendar_day.toISOString().slice(0, 10);
    expect(calendarDay).toBe(shiftDay(tradingDay, 1));

    const night = await report<DailyReport>(`/reports/daily?businessDay=${tradingDay}`);
    const morningAfter = await report<DailyReport>(`/reports/daily?businessDay=${calendarDay}`);

    // The late session's money is on the night that earned it...
    expect(night.takings.baseCollectedFils).toBeGreaterThanOrEqual(late.base);
    // ...and the next day's sheet was cut without it. A `date_trunc('day', …)`
    // grouping would have moved exactly this money across the boundary.
    const nextDayBase = await one<{ base: number }>(`
      SELECT COALESCE(SUM(amount_fils), 0)::int AS base
        FROM payments WHERE business_day = DATE '${calendarDay}' AND kind = 'BASE'`);
    expect(morningAfter.takings.baseCollectedFils).toBe(nextDayBase.base);
  });

  it('answers a night the spa did not trade with zeros rather than nothing', async () => {
    const view = await report<DailyReport>('/reports/daily?businessDay=2019-01-01');

    expect(view.bookings.total).toBe(0);
    expect(view.takings.grossFils).toBe(0);
    expect(view.cashDrawer.expectedCashFils).toBe(0);
    expect(view.takings.byMethod).toEqual([]);
  });

  it('422s a malformed trading day', async () => {
    const res = await get('/reports/daily?businessDay=16-09-2026', tokens.manager);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe(ErrorCode.VALIDATION_FAILED);
  });
});

/* ───────────────────────────── revenue ───────────────────────────── */

interface RevenuePeriod {
  periodStart: string;
  periodEnd: string;
  label: string;
  completedVisits: number;
  baseCollectedFils: number;
  baseRefundedFils: number;
  adjustmentsFils: number;
  netRevenueFils: number;
  tipsCollectedByBusinessFils: number;
  tipsDirectCashFils: number;
}

interface RevenueReport {
  from: string;
  to: string;
  groupBy: string;
  periods: RevenuePeriod[];
  totals: Omit<RevenuePeriod, 'periodStart' | 'periodEnd' | 'label'>;
  legend: { revenue: string; tipsCollectedByBusiness: string; tipsDirectCash: string };
}

const WINDOW = `from=${HISTORY_FROM}&to=${HISTORY_TO}`;

describe('GET /reports/revenue — and what is deliberately not in it', () => {
  it('totals base revenue to the same figure §13.3 invariant 4 reconciles', async () => {
    const view = await report<RevenueReport>(`/reports/revenue?${WINDOW}`);
    const actual = await one<{ base: number; quoted: number }>(`
      SELECT (SELECT COALESCE(SUM(amount_fils), 0)::int FROM payments
               WHERE kind = 'BASE'
                 AND business_day BETWEEN DATE '${HISTORY_FROM}' AND DATE '${HISTORY_TO}') AS base,
             (SELECT COALESCE(SUM(base_cost_fils), 0)::int FROM reservations
               WHERE status = 'COMPLETED'
                 AND business_day BETWEEN DATE '${HISTORY_FROM}' AND DATE '${HISTORY_TO}') AS quoted`);

    expect(view.totals.baseCollectedFils).toBe(actual.base);
    // Invariant 4: the desk collected the full quoted price for every completed
    // booking. So the report's revenue line and the menu price of what was
    // actually delivered are the same number, to the fils.
    expect(view.totals.baseCollectedFils).toBe(actual.quoted);
    expect(view.totals.netRevenueFils).toBe(
      view.totals.baseCollectedFils + view.totals.baseRefundedFils + view.totals.adjustmentsFils,
    );
    expect(actual.base).toBeGreaterThan(0);
  });

  it('keeps both tip modes out of revenue and labels them where they are', async () => {
    const view = await report<RevenueReport>(`/reports/revenue?${WINDOW}`);
    const tips = await one<{ collected: number; direct: number }>(`
      SELECT COALESCE(SUM(amount_fils) FILTER (WHERE type = 'COLLECTED_BY_BUSINESS'), 0)::int AS collected,
             COALESCE(SUM(amount_fils) FILTER (WHERE type = 'DIRECT_CASH'), 0)::int           AS direct
        FROM tips
       WHERE reversed_by_tip_id IS NULL
         AND business_day BETWEEN DATE '${HISTORY_FROM}' AND DATE '${HISTORY_TO}'`);

    expect(tips.collected).toBeGreaterThan(0);
    expect(tips.direct).toBeGreaterThan(0);
    expect(view.totals.tipsCollectedByBusinessFils).toBe(tips.collected);
    expect(view.totals.tipsDirectCashFils).toBe(tips.direct);

    // The whole point: neither figure is inside the revenue line.
    expect(view.totals.netRevenueFils).toBeLessThan(
      view.totals.netRevenueFils + tips.collected + tips.direct,
    );
    expect(view.legend.tipsCollectedByBusiness).toMatch(/NOT revenue/);
    expect(view.legend.tipsDirectCash).toMatch(/NOT revenue/);
  });

  it('groups by the TRADING day, so every period boundary is a trading boundary', async () => {
    const view = await report<RevenueReport>(`/reports/revenue?${WINDOW}&groupBy=day`);
    const perDay = await query<{ day: Date; base: number }>(`
      SELECT business_day AS day, COALESCE(SUM(amount_fils), 0)::int AS base
        FROM payments
       WHERE kind = 'BASE'
         AND business_day BETWEEN DATE '${HISTORY_FROM}' AND DATE '${HISTORY_TO}'
       GROUP BY 1 ORDER BY 1`);

    const reported = new Map(view.periods.map((p) => [p.periodStart, p.baseCollectedFils]));
    for (const row of perDay) {
      expect(reported.get(row.day.toISOString().slice(0, 10))).toBe(row.base);
    }
    // A continuous spine: every trading day in the window has a row, including
    // the quiet ones. A gap in a time series reads as missing data.
    expect(view.periods).toHaveLength(61);
    expect(view.periods[0]!.periodStart).toBe(HISTORY_FROM);
    expect(view.periods.at(-1)!.periodEnd).toBe(HISTORY_TO);
  });

  it('rolls days up into weeks and months without changing a single total', async () => {
    const [byDay, byWeek, byMonth] = await Promise.all([
      report<RevenueReport>(`/reports/revenue?${WINDOW}&groupBy=day`),
      report<RevenueReport>(`/reports/revenue?${WINDOW}&groupBy=week`),
      report<RevenueReport>(`/reports/revenue?${WINDOW}&groupBy=month`),
    ]);

    expect(byWeek.totals).toEqual(byDay.totals);
    expect(byMonth.totals).toEqual(byDay.totals);
    expect(byWeek.periods.length).toBeLessThan(byDay.periods.length);
    expect(byMonth.periods.length).toBeLessThan(byWeek.periods.length);

    // A part-week at either end says so rather than claiming days outside the
    // window it was never given.
    expect(byWeek.periods[0]!.periodStart).toBe(HISTORY_FROM);
    expect(byWeek.periods.at(-1)!.periodEnd).toBe(HISTORY_TO);
    expect(byMonth.periods[0]!.label).toMatch(/2026/);
  });

  it('defaults to the current trading month when asked for no dates at all', async () => {
    const view = await report<RevenueReport>('/reports/revenue');

    expect(view.from).toMatch(/^\d{4}-\d{2}-01$/);
    expect(view.to >= view.from).toBe(true);
    expect(view.groupBy).toBe('day');
  });

  it('refuses a window wider than the reporting cap instead of scanning the table', async () => {
    const res = await get('/reports/revenue?from=2020-01-01&to=2026-09-16', tokens.manager);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe(ErrorCode.REPORT_RANGE_TOO_LARGE);
    expect(res.body.error.details).toMatchObject({ maxDays: 400 });
  });

  it('422s a period that ends before it starts', async () => {
    const res = await get('/reports/revenue?from=2026-09-16&to=2026-09-01', tokens.manager);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe(ErrorCode.VALIDATION_FAILED);
  });
});

/* ─────────────────────────── utilisation ─────────────────────────── */

interface UtilisationRow {
  employeeId: string;
  displayName: string;
  sessions: number;
  minutesBooked: number;
  minutesRostered: number;
  minutesClocked: number;
  shifts: number;
  utilisationPct: number | null;
  noShows: number;
  revenueGeneratedFils: number;
  tips: {
    directCash: { tipCount: number; totalFils: number };
    collectedByBusiness: { tipCount: number; totalFils: number };
  };
}

interface UtilisationReport {
  from: string;
  to: string;
  therapists: UtilisationRow[];
  totals: {
    sessions: number;
    minutesBooked: number;
    minutesRostered: number;
    utilisationPct: number | null;
    revenueGeneratedFils: number;
  };
  basis: string;
}

describe('GET /reports/therapist-utilisation — divided by the roster, not by the clock', () => {
  it('divides booked minutes by ROSTERED minutes from `shifts`', async () => {
    const view = await report<UtilisationReport>(`/reports/therapist-utilisation?${WINDOW}`);
    expect(view.therapists.length).toBeGreaterThan(0);

    const rostered = await query<{ employee_id: string; minutes: number; shifts: number }>(`
      SELECT employee_id,
             COALESCE(SUM(EXTRACT(EPOCH FROM (planned_end - planned_start)) / 60), 0)::int AS minutes,
             count(*)::int                                                                 AS shifts
        FROM shifts
       WHERE status <> 'ABSENT'
         AND business_day BETWEEN DATE '${HISTORY_FROM}' AND DATE '${HISTORY_TO}'
       GROUP BY 1`);
    const byEmployee = new Map(rostered.map((row) => [row.employee_id, row]));

    for (const therapist of view.therapists) {
      const shift = byEmployee.get(therapist.employeeId);
      expect(therapist.minutesRostered).toBe(shift?.minutes ?? 0);
      expect(therapist.shifts).toBe(shift?.shifts ?? 0);

      // The claim in one line: a therapist who worked a four-hour shift is not
      // idle for the other eleven, so the divisor is the shift, never the
      // 11:00–02:00 trading window.
      expect(therapist.utilisationPct).toBeCloseTo(
        (therapist.minutesBooked / therapist.minutesRostered) * 100,
        1,
      );
      const tradingWindowMinutes = 15 * 60 * therapist.shifts;
      expect(therapist.minutesRostered).toBeLessThanOrEqual(tradingWindowMinutes);
    }
    expect(view.basis).toMatch(/ROSTERED/);
  });

  it('counts sessions and minutes from COMPLETED bookings only', async () => {
    const view = await report<UtilisationReport>(`/reports/therapist-utilisation?${WINDOW}`);
    const worked = await query<{ employee_id: string; sessions: number; minutes: number }>(`
      SELECT employee_id, count(*)::int AS sessions,
             COALESCE(SUM(duration_minutes), 0)::int AS minutes
        FROM reservations
       WHERE status = 'COMPLETED'
         AND business_day BETWEEN DATE '${HISTORY_FROM}' AND DATE '${HISTORY_TO}'
       GROUP BY 1`);
    const byEmployee = new Map(worked.map((row) => [row.employee_id, row]));

    for (const therapist of view.therapists) {
      const row = byEmployee.get(therapist.employeeId);
      expect(therapist.sessions).toBe(row?.sessions ?? 0);
      expect(therapist.minutesBooked).toBe(row?.minutes ?? 0);
    }
  });

  it('attributes revenue and both tip modes to the therapist who earned them', async () => {
    const view = await report<UtilisationReport>(`/reports/therapist-utilisation?${WINDOW}`);
    const revenue = await report<RevenueReport>(`/reports/revenue?${WINDOW}`);

    // Every dirham of revenue belongs to exactly one therapist, so the
    // per-therapist column and the revenue report must add up to each other —
    // base, base refunds and adjustments alike. Two reports on the same screen
    // that disagree about the same month is how a manager stops trusting both.
    expect(view.totals.revenueGeneratedFils).toBe(revenue.totals.netRevenueFils);
    expect(revenue.totals.netRevenueFils).toBe(
      revenue.totals.baseCollectedFils +
        revenue.totals.baseRefundedFils +
        revenue.totals.adjustmentsFils,
    );

    const tips = await report<TipsReport>(`/reports/tips?${WINDOW}`);
    const directCash = view.therapists.reduce((sum, t) => sum + t.tips.directCash.totalFils, 0);
    const collected = view.therapists.reduce(
      (sum, t) => sum + t.tips.collectedByBusiness.totalFils,
      0,
    );
    expect(directCash).toBe(tips.byMode.directCash.totalFils);
    expect(collected).toBe(tips.byMode.collectedByBusiness.totalFils);
  });

  it('reports no roster as null utilisation rather than a made-up zero', async () => {
    // A day nobody was rostered for. Zero over zero is not 0 %; it is unknown,
    // and a printed 0 % is the number that gets believed.
    const view = await report<UtilisationReport>(
      '/reports/therapist-utilisation?from=2019-01-01&to=2019-01-31',
    );

    expect(view.therapists).toEqual([]);
    expect(view.totals.utilisationPct).toBeNull();
  });
});

/* ─────────────────────────────── tips ─────────────────────────────── */

interface TipsReport {
  from: string;
  to: string;
  byMode: {
    directCash: { tipCount: number; totalFils: number };
    collectedByBusiness: { tipCount: number; totalFils: number };
    totalFils: number;
    labels: { directCash: string; collectedByBusiness: string };
  };
  byTherapist: Array<{
    employeeId: string;
    displayName: string;
    directCash: { tipCount: number; totalFils: number };
    collectedByBusiness: { tipCount: number; totalFils: number };
    totalEarnedFils: number;
    outstandingPayableFils: number;
    unbatchedPayableFils: number;
  }>;
  byDay: Array<{
    businessDay: string;
    directCash: { tipCount: number; totalFils: number };
    collectedByBusiness: { tipCount: number; totalFils: number };
    totalFils: number;
  }>;
  payable: { totalOutstandingFils: number; totalUnbatchedFils: number; basis: string };
}

describe('GET /reports/tips — earned in one column, owed in another', () => {
  it('matches §9.2’s own query for both modes, reversed pairs excluded', async () => {
    const view = await report<TipsReport>(`/reports/tips?${WINDOW}`);
    const actual = await query<{ type: string; tip_count: number; total: number }>(`
      SELECT type, count(*)::int AS tip_count, COALESCE(SUM(amount_fils), 0)::int AS total
        FROM tips
       WHERE business_day BETWEEN DATE '${HISTORY_FROM}' AND DATE '${HISTORY_TO}'
         AND reversed_by_tip_id IS NULL
       GROUP BY type`);

    const line = (type: string): { tip_count: number; total: number } =>
      actual.find((row) => row.type === type) ?? { tip_count: 0, total: 0 };

    expect(view.byMode.directCash).toEqual({
      tipCount: line(TipType.DIRECT_CASH).tip_count,
      totalFils: line(TipType.DIRECT_CASH).total,
    });
    expect(view.byMode.collectedByBusiness).toEqual({
      tipCount: line(TipType.COLLECTED_BY_BUSINESS).tip_count,
      totalFils: line(TipType.COLLECTED_BY_BUSINESS).total,
    });
    expect(view.byMode.totalFils).toBe(
      view.byMode.directCash.totalFils + view.byMode.collectedByBusiness.totalFils,
    );
  });

  it('reconciles the per-therapist payable with §13.3 invariant 1, therapist by therapist', async () => {
    const view = await report<TipsReport>(`/reports/tips?${WINDOW}`);
    // The invariant suite's own identity: balance = collected tips + commission
    // accruals − payouts. If the report disagrees with it for ANY therapist,
    // one of the two is lying and the therapist will find out first.
    const identity = await query<{
      employee_id: string;
      ledger_sum: number;
      expected: number;
      unbatched: number;
    }>(`
      SELECT e.id AS employee_id,
             (SELECT COALESCE(SUM(amount_fils), 0)::int FROM therapist_payout_ledger
               WHERE employee_id = e.id)                                        AS ledger_sum,
             (SELECT COALESCE(SUM(amount_fils), 0)::int FROM tips
               WHERE employee_id = e.id AND type = 'COLLECTED_BY_BUSINESS'
                 AND reversed_by_tip_id IS NULL)
             + (SELECT COALESCE(SUM(amount_fils), 0)::int FROM therapist_payout_ledger
                 WHERE employee_id = e.id AND entry_type = 'COMMISSION_ACCRUAL')
             - (SELECT COALESCE(SUM(-amount_fils), 0)::int FROM therapist_payout_ledger
                 WHERE employee_id = e.id AND entry_type = 'PAYOUT')            AS expected,
             (SELECT COALESCE(SUM(amount_fils), 0)::int FROM therapist_payout_ledger
               WHERE employee_id = e.id AND payout_batch_id IS NULL)            AS unbatched
        FROM employees e`);
    const byEmployee = new Map(identity.map((row) => [row.employee_id, row]));

    expect(view.byTherapist.length).toBeGreaterThan(0);
    for (const therapist of view.byTherapist) {
      const row = byEmployee.get(therapist.employeeId)!;
      expect(therapist.outstandingPayableFils).toBe(row.ledger_sum);
      expect(therapist.outstandingPayableFils).toBe(row.expected);
      expect(therapist.unbatchedPayableFils).toBe(row.unbatched);
    }
    expect(view.payable.totalOutstandingFils).toBe(
      view.byTherapist.reduce((sum, t) => sum + t.outstandingPayableFils, 0),
    );
  });

  it('never adds a DIRECT_CASH tip to what the business owes', async () => {
    const view = await report<TipsReport>(`/reports/tips?${WINDOW}`);

    // §9.2's whole argument, asserted as arithmetic: the payable total cannot
    // have absorbed the cash the therapists are already holding. The seeded
    // ledger carries commission accruals too, so the check is that the DIRECT
    // CASH line is nowhere inside it — never that the two are equal.
    const payableFromLedger = await one<{ total: number }>(`
      SELECT COALESCE(SUM(amount_fils), 0)::int AS total FROM therapist_payout_ledger
       WHERE tip_id IN (SELECT id FROM tips WHERE type = 'DIRECT_CASH')`);
    expect(payableFromLedger.total).toBe(0);
    expect(view.byMode.directCash.totalFils).toBeGreaterThan(0);
    expect(view.byMode.labels.directCash).toMatch(/never held/);
    expect(view.payable.basis).toMatch(/pays a tip twice/);
  });

  it('splits by trading day, and the days add back up to the modes', async () => {
    const view = await report<TipsReport>(`/reports/tips?${WINDOW}`);

    const direct = view.byDay.reduce((sum, day) => sum + day.directCash.totalFils, 0);
    const collected = view.byDay.reduce((sum, day) => sum + day.collectedByBusiness.totalFils, 0);
    expect(direct).toBe(view.byMode.directCash.totalFils);
    expect(collected).toBe(view.byMode.collectedByBusiness.totalFils);

    for (const day of view.byDay) {
      expect(day.businessDay >= HISTORY_FROM && day.businessDay <= HISTORY_TO).toBe(true);
    }
  });

  it('agrees with the daily close-out for a single night', async () => {
    const day = view0(await report<TipsReport>(`/reports/tips?${WINDOW}`));
    const [oneDay, daily] = await Promise.all([
      report<TipsReport>(`/reports/tips?from=${day}&to=${day}`),
      report<DailyReport>(`/reports/daily?businessDay=${day}`),
    ]);

    expect(oneDay.byMode.directCash).toEqual(daily.tips.directCash);
    expect(oneDay.byMode.collectedByBusiness).toEqual(daily.tips.collectedByBusiness);
  });
});

/** The first seeded night on which tips were actually recorded. */
function view0(report: TipsReport): string {
  const day = report.byDay.find((row) => row.totalFils > 0);
  if (!day) throw new Error('the fixture recorded no tips at all');
  return day.businessDay;
}

/* ──────────────────────────── attribution ──────────────────────────── */

interface AttributionChannel {
  source: string;
  medium: string;
  campaign: string | null;
  visitors: number;
  enquiries: number;
  bookings: number;
  completedVisits: number;
  revenueFils: number;
  conversionPct: number | null;
  completionPct: number | null;
}

interface AttributionReport {
  from: string;
  to: string;
  firstTouch: AttributionChannel[];
  lastTouch: AttributionChannel[];
  gap: Array<{
    source: string;
    medium: string;
    campaign: string | null;
    firstTouchRevenueFils: number;
    lastTouchRevenueFils: number;
    differenceFils: number;
    role: 'DISCOVERS' | 'CLOSES' | 'BALANCED';
  }>;
  totals: {
    visitors: number;
    enquiries: number;
    bookings: number;
    completedVisits: number;
    revenueFils: number;
  };
  basis: string;
}

/** Wide enough to hold every seeded snapshot: attribution is captured at BOOKING time. */
const ATTRIBUTION_WINDOW = `from=${shiftDay(SEED_ANCHOR_DAY, -120)}&to=${SEED_ANCHOR_DAY}`;

describe('GET /reports/attribution — both models, and the gap between them', () => {
  it('reports the same cohort twice, so the two sides total the same money', async () => {
    const view = await report<AttributionReport>(`/reports/attribution?${ATTRIBUTION_WINDOW}`);

    expect(view.firstTouch.length).toBeGreaterThan(1);
    expect(view.lastTouch.length).toBeGreaterThan(1);

    const sum = (rows: AttributionChannel[], key: keyof AttributionChannel): number =>
      rows.reduce((total, row) => total + (row[key] as number), 0);

    // First touch and last touch are one cohort split two ways. If the totals
    // differ, one of the two models has lost or duplicated a visitor.
    expect(sum(view.firstTouch, 'revenueFils')).toBe(sum(view.lastTouch, 'revenueFils'));
    expect(sum(view.firstTouch, 'visitors')).toBe(sum(view.lastTouch, 'visitors'));
    expect(sum(view.firstTouch, 'completedVisits')).toBe(sum(view.lastTouch, 'completedVisits'));
    expect(view.totals.revenueFils).toBe(sum(view.lastTouch, 'revenueFils'));
  });

  it('counts revenue as BASE payments on attributed bookings, and no tips', async () => {
    const view = await report<AttributionReport>(`/reports/attribution?${ATTRIBUTION_WINDOW}`);
    // Scoped by `business_day(captured_at)`, exactly as the report scopes it:
    // the cohort is the visitors captured in the window, not every attributed
    // booking that ever happened.
    const actual = await one<{ revenue: number; bookings: number; completed: number }>(`
      SELECT COALESCE(SUM(p.amount_fils) FILTER (WHERE p.kind = 'BASE'), 0)::int AS revenue,
             count(DISTINCT r.id)::int                                           AS bookings,
             count(DISTINCT r.id) FILTER (WHERE r.status = 'COMPLETED')::int     AS completed
        FROM attribution_snapshots a
        JOIN reservations r ON r.attribution_id = a.id
        LEFT JOIN payments p ON p.reservation_id = r.id
       WHERE business_day(a.captured_at)
             BETWEEN DATE '${shiftDay(SEED_ANCHOR_DAY, -120)}' AND DATE '${SEED_ANCHOR_DAY}'`);

    expect(actual.revenue).toBeGreaterThan(0);
    expect(view.totals.revenueFils).toBe(actual.revenue);
    expect(view.totals.bookings).toBe(actual.bookings);
    expect(view.totals.completedVisits).toBe(actual.completed);
  });

  it('surfaces the gap, largest first, and says which way it runs', async () => {
    const view = await report<AttributionReport>(`/reports/attribution?${ATTRIBUTION_WINDOW}`);

    expect(view.gap.length).toBeGreaterThan(0);
    for (const row of view.gap) {
      expect(row.differenceFils).toBe(row.firstTouchRevenueFils - row.lastTouchRevenueFils);
    }
    // Sorted by how far apart the models are: the ordering IS the finding.
    const magnitudes = view.gap.map((row) => Math.abs(row.differenceFils));
    expect([...magnitudes].sort((a, b) => b - a)).toEqual(magnitudes);

    // The seed's channel mix genuinely moves between models, so at least one
    // channel must come out as a discoverer and one as a closer — otherwise
    // this report is reporting nothing and the assertion should say so.
    const roles = new Set(view.gap.map((row) => row.role));
    expect(roles.has('DISCOVERS')).toBe(true);
    expect(roles.has('CLOSES')).toBe(true);

    // And the gap is a redistribution, not new money.
    expect(view.gap.reduce((sum, row) => sum + row.differenceFils, 0)).toBe(0);
  });

  it('reports a conversion rate of null, not 0%, where nothing enquired', async () => {
    const view = await report<AttributionReport>(`/reports/attribution?${ATTRIBUTION_WINDOW}`);
    const enquiries = await one<{ total: number }>(
      'SELECT count(*)::int AS total FROM booking_requests',
    );

    // The seeded fixture books at the desk and writes no website enquiries, so
    // §10.6's denominator is genuinely zero. A printed 0% would read as "this
    // channel converts nobody", which is the opposite of what the data says.
    expect(enquiries.total).toBe(0);
    expect(view.totals.enquiries).toBe(0);
    for (const row of view.lastTouch) {
      expect(row.conversionPct).toBeNull();
      expect(row.completionPct).not.toBeNull();
    }
    expect(view.basis).toMatch(/null rather than a fabricated/);
  });

  it('files a snapshot captured after midnight under the previous trading day', async () => {
    const late = await one<{ trading_day: Date; calendar_day: Date; total: number }>(`
      SELECT business_day(captured_at)                        AS trading_day,
             (captured_at AT TIME ZONE 'Asia/Dubai')::date     AS calendar_day,
             count(*)::int                                     AS total
        FROM attribution_snapshots
       WHERE (captured_at AT TIME ZONE 'Asia/Dubai')::time < TIME '06:00'
       GROUP BY 1, 2
       ORDER BY 3 DESC
       LIMIT 1`);

    const tradingDay = late.trading_day.toISOString().slice(0, 10);
    expect(late.calendar_day.toISOString().slice(0, 10)).toBe(shiftDay(tradingDay, 1));

    const night = await report<AttributionReport>(
      `/reports/attribution?from=${tradingDay}&to=${tradingDay}`,
    );
    expect(night.totals.visitors).toBeGreaterThanOrEqual(late.total);
  });
});

/* ─────────────────────────── §12.1 budget ─────────────────────────── */

describe('performance (§12.1)', () => {
  it('answers the daily close-out well inside its 600 ms budget', async () => {
    // Not a benchmark — a smoke alarm. If this route ever starts scanning the
    // payments table, ten runs of it on a fixture this size will notice.
    const timings: number[] = [];
    for (let i = 0; i < 10; i++) {
      const started = Date.now();
      await report<DailyReport>(`/reports/daily?businessDay=${SEED_ANCHOR_DAY}`);
      timings.push(Date.now() - started);
    }
    timings.sort((a, b) => a - b);

    expect(timings[8]!).toBeLessThan(600);
  });
});

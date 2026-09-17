import { Prisma } from '@prisma/client';
import { ReportGroupBy, UserRole } from '@berelax/contracts';
import type { AuthUser } from '../common/request-context';
import type { PrismaService } from '../prisma/prisma.service';
import { RevenueReportService } from './revenue-report.service';

/**
 * Revenue over time, with the database mocked.
 *
 * The one thing this suite exists to hold still: a tip is not revenue, in
 * either mode. `COLLECTED_BY_BUSINESS` is money the business is holding for
 * somebody else and `DIRECT_CASH` never reached it, so both are reported beside
 * `netRevenueFils` and neither is inside it. §9.1.
 */

const BRANCH_ID = '0192bbbb-0000-7000-8000-00000000000b';

function ownerFixture(): AuthUser {
  return {
    id: '0192dddd-0000-7000-8000-00000000000a',
    role: UserRole.OWNER,
    branchId: BRANCH_ID,
    email: 'owner@berelax.ae',
    fullName: 'Branch Owner',
  };
}

/** `@db.Date` comes back from Postgres as UTC midnight. */
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

const TWO_NIGHTS = [
  {
    periodStart: day('2026-09-15'),
    periodEnd: day('2026-09-15'),
    completedVisits: 4,
    noShows: 1,
    cancellations: 0,
    baseCollectedFils: 100_000,
    baseRefundedFils: -10_000,
    adjustmentsFils: -2_500,
    tipsCollectedByBusinessFils: 5_000,
    tipsDirectCashFils: 9_000,
  },
  {
    periodStart: day('2026-09-16'),
    periodEnd: day('2026-09-16'),
    completedVisits: 3,
    noShows: 0,
    cancellations: 2,
    baseCollectedFils: 80_000,
    baseRefundedFils: 0,
    adjustmentsFils: 0,
    tipsCollectedByBusinessFils: 4_000,
    tipsDirectCashFils: 6_000,
  },
];

function setup(rows: unknown[] = TWO_NIGHTS) {
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue(rows),
  } as unknown as PrismaService;

  return { prisma, service: new RevenueReportService(prisma) };
}

const WINDOW = { from: '2026-09-15', to: '2026-09-16', groupBy: ReportGroupBy.DAY };

/**
 * `Prisma.Sql` is a type at runtime, not a constructor, so a composed fragment
 * is recognised by its shape. Everything else bound into the statement is a
 * plain string.
 */
function isSqlFragment(value: unknown): value is Prisma.Sql {
  return typeof value === 'object' && value !== null && 'strings' in value && 'values' in value;
}

/** Everything interpolated into the statement: bound strings and composed fragments. */
function boundValues(prisma: PrismaService): unknown[] {
  const [, ...values] = (prisma.$queryRaw as unknown as jest.Mock).mock.calls[0]!;
  return values as unknown[];
}

describe('RevenueReportService — what counts as revenue', () => {
  it('reports base, refunds and adjustments, and nothing else, as the revenue line', async () => {
    const { service } = setup();

    const view = await service.revenue(WINDOW, ownerFixture());

    expect(view.periods[0]).toMatchObject({
      periodStart: '2026-09-15',
      baseCollectedFils: 100_000,
      baseRefundedFils: -10_000,
      adjustmentsFils: -2_500,
      netRevenueFils: 87_500,
    });
    // 87 500, not 101 500. The 14 000 of tips on that night is reported, and it
    // is not earnings.
    expect(view.periods[0]!.netRevenueFils).toBe(87_500);
  });

  it('carries both tip lines beside revenue, labelled so neither can be mistaken for it', async () => {
    const { service } = setup();

    const view = await service.revenue(WINDOW, ownerFixture());

    expect(view.totals.tipsCollectedByBusinessFils).toBe(9_000);
    expect(view.totals.tipsDirectCashFils).toBe(15_000);
    expect(view.totals.netRevenueFils).toBe(167_500);
    expect(view.legend.revenue).toMatch(/Business revenue/);
    expect(view.legend.tipsCollectedByBusiness).toMatch(/NOT revenue/);
    expect(view.legend.tipsDirectCash).toMatch(/NOT revenue/);
  });

  it('totals every column across the periods it was given', async () => {
    const { service } = setup();

    const view = await service.revenue(WINDOW, ownerFixture());

    expect(view.totals).toEqual({
      completedVisits: 7,
      noShows: 1,
      cancellations: 2,
      baseCollectedFils: 180_000,
      baseRefundedFils: -10_000,
      adjustmentsFils: -2_500,
      netRevenueFils: 167_500,
      tipsCollectedByBusinessFils: 9_000,
      tipsDirectCashFils: 15_000,
    });
  });

  it('reads an empty window as zeros rather than as missing keys', async () => {
    const { service } = setup([]);

    const view = await service.revenue(WINDOW, ownerFixture());

    expect(view.periods).toEqual([]);
    expect(view.totals.netRevenueFils).toBe(0);
    expect(view.totals.tipsDirectCashFils).toBe(0);
  });
});

describe('RevenueReportService — the bucket', () => {
  it('labels a day with its trading date', async () => {
    const { service } = setup();

    const view = await service.revenue(WINDOW, ownerFixture());

    expect(view.periods.map((period) => period.label)).toEqual(['2026-09-15', '2026-09-16']);
  });

  it('labels a week with the trading days it actually covers', async () => {
    const { service } = setup([
      {
        ...TWO_NIGHTS[0],
        periodStart: day('2026-09-14'),
        periodEnd: day('2026-09-16'),
      },
    ]);

    const view = await service.revenue({ ...WINDOW, groupBy: ReportGroupBy.WEEK }, ownerFixture());

    // Clipped to the window, so a part-week says so instead of claiming days it
    // was never given.
    expect(view.periods[0]!.label).toBe('2026-09-14 – 2026-09-16');
    expect(view.groupBy).toBe('week');
  });

  it('labels a month by name', async () => {
    const { service } = setup([
      { ...TWO_NIGHTS[0], periodStart: day('2026-09-01'), periodEnd: day('2026-09-30') },
    ]);

    const view = await service.revenue({ ...WINDOW, groupBy: ReportGroupBy.MONTH }, ownerFixture());

    expect(view.periods[0]!.label).toBe('September 2026');
  });

  it('builds the bucket from the validated enum and never from caller text', async () => {
    const { service, prisma } = setup();

    await service.revenue({ ...WINDOW, groupBy: ReportGroupBy.MONTH }, ownerFixture());

    const values = boundValues(prisma);
    // `groupBy` selected a fixed `Prisma.sql` fragment; it never reaches the
    // statement as text of its own. The bucket is composed, not concatenated.
    const composed = values.filter(isSqlFragment).map((fragment) => fragment.sql);

    // One bucket expression per source table, and the same month on all of them.
    expect(composed.filter((fragment) => fragment.includes("date_trunc('month'"))).toHaveLength(4);
    expect(composed.some((fragment) => fragment.includes("date_trunc('week'"))).toBe(false);
    expect(composed.some((fragment) => fragment.includes("date_trunc('day'"))).toBe(false);
    expect(values).not.toContain('month');
    expect(values).toContain(BRANCH_ID);
  });

  it('passes the column straight through when the bucket is a single trading day', async () => {
    const { service, prisma } = setup();

    await service.revenue({ ...WINDOW, groupBy: ReportGroupBy.DAY }, ownerFixture());

    const values = boundValues(prisma);
    const composed = values.filter(isSqlFragment).map((fragment) => fragment.sql);

    // No `date_trunc` at all: a trading day is already the bucket, and
    // re-truncating it is the §3.3 bug this whole module is written against.
    expect(composed.some((fragment) => fragment.includes('date_trunc'))).toBe(false);
    expect(composed).toContain('p.business_day');
  });

  it('groups on `business_day`, never on a timestamp re-derived at read time', async () => {
    const { service, prisma } = setup();

    await service.revenue(WINDOW, ownerFixture());

    const [fragments] = (prisma.$queryRaw as unknown as jest.Mock).mock.calls[0]!;
    const sql = (fragments as string[]).join('?');
    // §3.3, asserted rather than trusted: the 01:30 booking is filed by the
    // stored trading day and by nothing else.
    expect(sql).toContain('p.business_day');
    expect(sql).toContain('r.business_day');
    expect(sql).toContain('t.business_day');
    expect(sql).not.toContain('collected_at');
    expect(sql).not.toContain('starts_at');
  });
});

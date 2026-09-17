import { UserRole } from '@berelax/contracts';
import type { AuthUser } from '../common/request-context';
import type { PrismaService } from '../prisma/prisma.service';
import { AttributionReportService } from './attribution-report.service';

/**
 * Channel ROI, with the database mocked.
 *
 * §10.6 says the gap between first touch and last touch is the most useful
 * number in the report, so this suite is mostly about the gap: that it is
 * computed, that it is sorted so the biggest divergence is first, and that it
 * says which way it runs. A channel that discovers guests somebody else closes
 * looks like a failure in a last-touch table and like a bargain in a
 * first-touch one; the difference between those two readings is a budget.
 */

const BRANCH_ID = '0192bbbb-0000-7000-8000-00000000000b';

function managerFixture(): AuthUser {
  return {
    id: '0192dddd-0000-7000-8000-00000000000d',
    role: UserRole.MANAGER,
    branchId: BRANCH_ID,
    email: 'manager@berelax.ae',
    fullName: 'Duty Manager',
  };
}

/**
 * One cohort, split two ways. Organic search finds guests that Instagram then
 * closes, and the two sides total the same 800 000 fils either way — which is
 * what makes the difference readable as a difference rather than as noise.
 */
const COHORT = [
  {
    touch: 'FIRST',
    source: 'google',
    medium: 'organic',
    campaign: null,
    visitors: 40,
    enquiries: 10,
    bookings: 30,
    completedVisits: 25,
    revenueFils: 500_000,
  },
  {
    touch: 'FIRST',
    source: 'instagram',
    medium: 'social',
    campaign: 'reels-autumn',
    visitors: 20,
    enquiries: 0,
    bookings: 15,
    completedVisits: 12,
    revenueFils: 300_000,
  },
  {
    touch: 'LAST',
    source: 'instagram',
    medium: 'social',
    campaign: 'reels-autumn',
    visitors: 35,
    enquiries: 4,
    bookings: 26,
    completedVisits: 21,
    revenueFils: 520_000,
  },
  {
    touch: 'LAST',
    source: 'google',
    medium: 'organic',
    campaign: null,
    visitors: 25,
    enquiries: 6,
    bookings: 19,
    completedVisits: 16,
    revenueFils: 280_000,
  },
];

function setup(rows: unknown[] = COHORT) {
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue(rows),
  } as unknown as PrismaService;

  return { prisma, service: new AttributionReportService(prisma) };
}

const WINDOW = { from: '2026-08-01', to: '2026-09-16' };

describe('AttributionReportService — two models of one cohort', () => {
  it('separates the two touch models into two tables', async () => {
    const { service } = setup();

    const view = await service.attribution(WINDOW, managerFixture());

    expect(view.firstTouch.map((row) => row.source)).toEqual(['google', 'instagram']);
    expect(view.lastTouch.map((row) => row.source)).toEqual(['instagram', 'google']);
  });

  it('totals one side only, because both sides are the same money', async () => {
    const { service } = setup();

    const view = await service.attribution(WINDOW, managerFixture());

    // 800 000 either way. Adding the two tables together would report 1 600 000
    // of revenue from 800 000 of takings — the standard way a multi-touch report
    // gets quoted at a board meeting and never recovers.
    expect(view.totals.revenueFils).toBe(800_000);
    expect(view.firstTouch.reduce((sum, row) => sum + row.revenueFils, 0)).toBe(800_000);
    expect(view.totals.visitors).toBe(60);
    expect(view.totals.completedVisits).toBe(37);
  });

  it('computes §10.6’s conversion rate, and a completion rate beside it', async () => {
    const { service } = setup();

    const view = await service.attribution(WINDOW, managerFixture());

    // 25 completed visits from 10 enquiries — a channel whose enquiries convert
    // and whose walk-ups outnumber them.
    expect(view.firstTouch[0]).toMatchObject({ conversionPct: 250, completionPct: 83.3 });
  });

  it('answers null, not 0 %, for a channel that produced no enquiry', async () => {
    const { service } = setup();

    const view = await service.attribution(WINDOW, managerFixture());

    // Those guests were booked at the desk. "0 % conversion" would read as a
    // channel nobody responds to, which is the opposite of what the row says.
    expect(view.firstTouch[1]!.enquiries).toBe(0);
    expect(view.firstTouch[1]!.conversionPct).toBeNull();
    expect(view.firstTouch[1]!.completionPct).toBe(80);
    expect(view.basis).toMatch(/null rather than a fabricated/);
  });
});

describe('AttributionReportService — the gap', () => {
  it('reports each channel’s two figures and the difference between them', async () => {
    const { service } = setup();

    const view = await service.attribution(WINDOW, managerFixture());

    expect(view.gap).toEqual([
      {
        source: 'google',
        medium: 'organic',
        campaign: null,
        firstTouchRevenueFils: 500_000,
        lastTouchRevenueFils: 280_000,
        differenceFils: 220_000,
        firstTouchCompletedVisits: 25,
        lastTouchCompletedVisits: 16,
        role: 'DISCOVERS',
      },
      {
        source: 'instagram',
        medium: 'social',
        campaign: 'reels-autumn',
        firstTouchRevenueFils: 300_000,
        lastTouchRevenueFils: 520_000,
        differenceFils: -220_000,
        firstTouchCompletedVisits: 12,
        lastTouchCompletedVisits: 21,
        role: 'CLOSES',
      },
    ]);
  });

  it('is a redistribution, so the differences cancel out', async () => {
    const { service } = setup();

    const view = await service.attribution(WINDOW, managerFixture());

    expect(view.gap.reduce((sum, row) => sum + row.differenceFils, 0)).toBe(0);
  });

  it('sorts by how far apart the models are, because the ordering is the finding', async () => {
    const { service } = setup([
      ...COHORT,
      {
        touch: 'FIRST',
        source: 'tripadvisor.com',
        medium: 'referral',
        campaign: null,
        visitors: 5,
        enquiries: 1,
        bookings: 4,
        completedVisits: 3,
        revenueFils: 60_000,
      },
      {
        touch: 'LAST',
        source: 'tripadvisor.com',
        medium: 'referral',
        campaign: null,
        visitors: 5,
        enquiries: 1,
        bookings: 4,
        completedVisits: 3,
        revenueFils: 59_000,
      },
    ]);

    const view = await service.attribution(WINDOW, managerFixture());

    const magnitudes = view.gap.map((row) => Math.abs(row.differenceFils));
    expect([...magnitudes].sort((a, b) => b - a)).toEqual(magnitudes);
    // Within 5 % of itself: the two models are telling the same story about
    // this channel and it should not be dressed up as a finding.
    expect(view.gap.at(-1)).toMatchObject({ source: 'tripadvisor.com', role: 'BALANCED' });
  });

  it('keeps a channel that appears in only one model, which is the strongest case', async () => {
    const { service } = setup([
      {
        touch: 'FIRST',
        source: 'google',
        medium: 'cpc',
        campaign: 'brand',
        visitors: 12,
        enquiries: 3,
        bookings: 9,
        completedVisits: 7,
        revenueFils: 140_000,
      },
    ]);

    const view = await service.attribution(WINDOW, managerFixture());

    // Everything it found was closed elsewhere. A last-touch-only report would
    // show this channel as worthless and it would be cut.
    expect(view.lastTouch).toEqual([]);
    expect(view.gap).toEqual([
      expect.objectContaining({
        source: 'google',
        medium: 'cpc',
        firstTouchRevenueFils: 140_000,
        lastTouchRevenueFils: 0,
        differenceFils: 140_000,
        role: 'DISCOVERS',
      }),
    ]);
  });

  it('reads an empty cohort as empty, not as a channel earning nothing', async () => {
    const { service } = setup([]);

    const view = await service.attribution(WINDOW, managerFixture());

    expect(view.firstTouch).toEqual([]);
    expect(view.gap).toEqual([]);
    expect(view.totals).toEqual({
      visitors: 0,
      enquiries: 0,
      bookings: 0,
      completedVisits: 0,
      revenueFils: 0,
    });
  });
});

describe('AttributionReportService — the window and the branch', () => {
  it('cuts the cohort on business_day(captured_at), not on the raw timestamp', async () => {
    const { service, prisma } = setup();

    await service.attribution(WINDOW, managerFixture());

    const [fragments, ...values] = (prisma.$queryRaw as unknown as jest.Mock).mock.calls[0]!;
    const sql = (fragments as string[]).join('?');
    // The one table in this module without a stored `business_day`, so the SQL
    // function is called on the timestamp. A 01:30 enquiry is still last night's.
    expect(sql).toContain('business_day(a.captured_at) BETWEEN');
    expect(sql).not.toContain("date_trunc('day'");
    expect(values).toContain('2026-08-01');
    expect(values).toContain('2026-09-16');
  });

  it('scopes every fact below the visitor count to the caller’s branch', async () => {
    const { service, prisma } = setup();

    await service.attribution(WINDOW, managerFixture());

    const [fragments, ...rest] = (prisma.$queryRaw as unknown as jest.Mock).mock.calls[0]!;
    const sql = (fragments as string[]).join('?');
    const values = rest as unknown[];
    expect(values.filter((value) => value === BRANCH_ID)).toHaveLength(4);
    expect(sql).toContain('br.branch_id =');
    expect(sql).toContain('r.branch_id =');
    expect(sql).toContain('p.branch_id =');
  });
});

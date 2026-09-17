import { UserRole } from '@berelax/contracts';
import type { AuthUser } from '../common/request-context';
import type { PrismaService } from '../prisma/prisma.service';
import { UtilisationReportService } from './utilisation-report.service';

/**
 * Utilisation, with the database mocked.
 *
 * The claim this suite defends: the divisor is ROSTERED minutes from `shifts`,
 * not the 11:00–02:00 trading window. A therapist who worked a four-hour shift
 * is not idle for the other eleven, and a report that says they are is one a
 * manager will stop opening.
 */

const BRANCH_ID = '0192bbbb-0000-7000-8000-00000000000b';
const LAYLA = '0192cccc-0000-7000-8000-000000000001';
const MAYA = '0192cccc-0000-7000-8000-000000000002';

function managerFixture(): AuthUser {
  return {
    id: '0192dddd-0000-7000-8000-00000000000d',
    role: UserRole.MANAGER,
    branchId: BRANCH_ID,
    email: 'manager@berelax.ae',
    fullName: 'Duty Manager',
  };
}

/** Four-hour shift, three hours of it booked. 75 %, not 20 % of a fifteen-hour night. */
const A_SHORT_SHIFT = {
  employeeId: LAYLA,
  displayName: 'Layla',
  sessions: 3,
  minutesBooked: 180,
  daysWorked: 1,
  noShows: 1,
  minutesLostToNoShows: 60,
  shifts: 1,
  minutesRostered: 240,
  minutesClocked: 245,
  revenueGeneratedFils: 75_000,
  directCashCount: 2,
  directCashFils: 9_000,
  collectedCount: 1,
  collectedFils: 5_000,
};

/** A full night on the floor with almost nothing booked. */
const A_LONG_QUIET_SHIFT = {
  employeeId: MAYA,
  displayName: 'Maya',
  sessions: 1,
  minutesBooked: 60,
  daysWorked: 1,
  noShows: 0,
  minutesLostToNoShows: 0,
  shifts: 1,
  minutesRostered: 900,
  minutesClocked: 910,
  revenueGeneratedFils: 25_000,
  directCashCount: 0,
  directCashFils: 0,
  collectedCount: 0,
  collectedFils: 0,
};

function setup(rows: unknown[] = [A_SHORT_SHIFT, A_LONG_QUIET_SHIFT]) {
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue(rows),
  } as unknown as PrismaService;

  return { prisma, service: new UtilisationReportService(prisma) };
}

const WINDOW = { from: '2026-09-15', to: '2026-09-16' };

describe('UtilisationReportService — the divisor', () => {
  it('divides booked minutes by rostered minutes, not by the trading window', async () => {
    const { service } = setup();

    const view = await service.utilisation(WINDOW, managerFixture());

    // 180 of 240 rostered minutes is 75 %. 180 of a 900-minute night would be
    // 20 %, and it would be a lie about somebody who was not there.
    expect(view.therapists[0]).toMatchObject({
      displayName: 'Layla',
      minutesBooked: 180,
      minutesRostered: 240,
      utilisationPct: 75,
    });
    expect(view.therapists[1]).toMatchObject({ displayName: 'Maya', utilisationPct: 6.7 });
    expect(view.basis).toMatch(/ROSTERED/);
  });

  it('reports the clock alongside the roster without dividing by it', async () => {
    const { service } = setup();

    const view = await service.utilisation(WINDOW, managerFixture());

    // Clocking out twenty minutes late is an attendance fact, not a change to
    // what the therapist was rostered for.
    expect(view.therapists[0]!.minutesClocked).toBe(245);
    expect(view.therapists[0]!.utilisationPct).toBe(75);
  });

  it('answers null utilisation for a therapist with no roster at all', async () => {
    const { service } = setup([{ ...A_SHORT_SHIFT, shifts: 0, minutesRostered: 0 }]);

    const view = await service.utilisation(WINDOW, managerFixture());

    // Not 0 %, not Infinity. Somebody took bookings on a night nobody wrote a
    // shift for, and the honest answer is that utilisation is unknown.
    expect(view.therapists[0]!.utilisationPct).toBeNull();
    expect(view.totals.utilisationPct).toBeNull();
  });

  it('weights the floor total by minutes, not by an average of the rows', async () => {
    const { service } = setup();

    const view = await service.utilisation(WINDOW, managerFixture());

    // 240 booked over 1 140 rostered is 21.1 %. Averaging 75 % and 6.7 % would
    // give 40.9 % and hand a quiet twenty-hour week the same vote as a busy one.
    expect(view.totals.minutesBooked).toBe(240);
    expect(view.totals.minutesRostered).toBe(1_140);
    expect(view.totals.utilisationPct).toBe(21.1);
  });
});

describe('UtilisationReportService — what each therapist earned', () => {
  it('reports revenue and both tip modes per therapist, and totals them', async () => {
    const { service } = setup();

    const view = await service.utilisation(WINDOW, managerFixture());

    expect(view.therapists[0]!.tips).toEqual({
      directCash: { tipCount: 2, totalFils: 9_000 },
      collectedByBusiness: { tipCount: 1, totalFils: 5_000 },
    });
    expect(view.totals).toMatchObject({
      sessions: 4,
      revenueGeneratedFils: 100_000,
      tipsDirectCashFils: 9_000,
      tipsCollectedByBusinessFils: 5_000,
    });
  });

  it('keeps no-shows out of booked minutes and reports them on their own line', async () => {
    const { service } = setup();

    const view = await service.utilisation(WINDOW, managerFixture());

    // A guest who never arrived held the slot but did not consume the
    // therapist's hands. Folding it into `minutesBooked` would flatter
    // utilisation on exactly the nights that went worst.
    expect(view.therapists[0]!.minutesBooked).toBe(180);
    expect(view.therapists[0]!.noShows).toBe(1);
    expect(view.therapists[0]!.minutesLostToNoShows).toBe(60);
  });

  it('reads an empty window as an empty roster, not as a floor at zero percent', async () => {
    const { service } = setup([]);

    const view = await service.utilisation(WINDOW, managerFixture());

    expect(view.therapists).toEqual([]);
    expect(view.totals.utilisationPct).toBeNull();
    expect(view.totals.revenueGeneratedFils).toBe(0);
  });

  it('scopes the statement to the branch and the trading window it was given', async () => {
    const { service, prisma } = setup();

    await service.utilisation(WINDOW, managerFixture());

    const [fragments, ...values] = (prisma.$queryRaw as unknown as jest.Mock).mock.calls[0]!;
    const sql = (fragments as string[]).join('?');
    expect(sql).toContain('FROM shifts');
    expect(sql).toContain("s.status <> 'ABSENT'");
    expect(sql).toContain('business_day BETWEEN');
    expect(new Set(values)).toEqual(new Set([BRANCH_ID, '2026-09-15', '2026-09-16']));
  });

  it('counts revenue the same way /reports/revenue does, so the two reconcile', async () => {
    const { service, prisma } = setup();

    await service.utilisation(WINDOW, managerFixture());

    const [fragments] = (prisma.$queryRaw as unknown as jest.Mock).mock.calls[0]!;
    const sql = (fragments as string[]).join('?');
    // Base, base refunds and adjustments — the three kinds that make up
    // `netRevenueFils`. A refunded TIP is excluded: it was never revenue.
    expect(sql).toContain("p.kind IN ('BASE', 'ADJUSTMENT')");
    expect(sql).toContain("(p.kind = 'REFUND' AND orig.kind IS DISTINCT FROM 'TIP')");
  });
});

import { UserRole } from '@berelax/contracts';
import type { AuthUser } from '../common/request-context';
import type { PrismaService } from '../prisma/prisma.service';
import { TipsReportService } from './tips-report.service';

/**
 * Tips, with the database mocked.
 *
 * Two tables, deliberately never added together (§9.1, §9.2): `tips` says what
 * a therapist EARNED in each mode, the payout ledger says what the business
 * OWES. A `DIRECT_CASH` tip is in the first and absent from the second, and the
 * moment those two columns are summed, somebody gets paid twice.
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

const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

const THERAPISTS = [
  {
    employeeId: LAYLA,
    displayName: 'Layla',
    directCashCount: 3,
    directCashFils: 15_000,
    collectedCount: 2,
    collectedFils: 9_000,
    // More than the window's 9 000: the balance carries commission accruals and
    // earlier months, less everything already paid out.
    outstandingPayableFils: 38_500,
    unbatchedPayableFils: 13_500,
  },
  {
    employeeId: MAYA,
    displayName: 'Maya',
    directCashCount: 1,
    directCashFils: 4_000,
    collectedCount: 0,
    collectedFils: 0,
    outstandingPayableFils: 0,
    unbatchedPayableFils: 0,
  },
];

const DAYS = [
  {
    businessDay: day('2026-09-15'),
    directCashCount: 2,
    directCashFils: 11_000,
    collectedCount: 1,
    collectedFils: 5_000,
  },
  {
    businessDay: day('2026-09-16'),
    directCashCount: 2,
    directCashFils: 8_000,
    collectedCount: 1,
    collectedFils: 4_000,
  },
];

function setup(therapists: unknown[] = THERAPISTS, days: unknown[] = DAYS) {
  const $queryRaw = jest.fn().mockResolvedValueOnce(therapists).mockResolvedValueOnce(days);
  const prisma = {
    $queryRaw,
    $transaction: jest.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
  } as unknown as PrismaService;

  return { prisma, service: new TipsReportService(prisma) };
}

const WINDOW = { from: '2026-09-15', to: '2026-09-16' };

describe('TipsReportService — earned, by mode and by night', () => {
  it('rolls the nights up into the two modes rather than asking a third time', async () => {
    const { service } = setup();

    const view = await service.tips(WINDOW, managerFixture());

    expect(view.byMode.directCash).toEqual({ tipCount: 4, totalFils: 19_000 });
    expect(view.byMode.collectedByBusiness).toEqual({ tipCount: 2, totalFils: 9_000 });
    expect(view.byMode.totalFils).toBe(28_000);
    // The per-day rows and the per-mode totals are the same rows twice, so they
    // cannot disagree with each other.
    expect(view.byDay.reduce((sum, row) => sum + row.totalFils, 0)).toBe(view.byMode.totalFils);
  });

  it('renders each trading day as its own line', async () => {
    const { service } = setup();

    const view = await service.tips(WINDOW, managerFixture());

    expect(view.byDay[0]).toEqual({
      businessDay: '2026-09-15',
      directCash: { tipCount: 2, totalFils: 11_000 },
      collectedByBusiness: { tipCount: 1, totalFils: 5_000 },
      totalFils: 16_000,
    });
  });

  it('labels each mode so a pass-through cannot be read as earnings', async () => {
    const { service } = setup();

    const view = await service.tips(WINDOW, managerFixture());

    expect(view.byMode.labels.directCash).toMatch(/never held/);
    expect(view.byMode.labels.collectedByBusiness).toMatch(/NOT revenue/);
  });

  it('excludes both halves of a reversed pair, not just the original', async () => {
    const { service, prisma } = setup();

    await service.tips(WINDOW, managerFixture());

    // A reversal marks BOTH rows, so `IS NULL` removes the pair. Filtering only
    // the original would leave the −50 mirror behind and report a reversed
    // 50 AED tip as −50 AED earned. §9.4.
    const calls = (prisma.$queryRaw as unknown as jest.Mock).mock.calls;
    for (const [fragments] of calls) {
      expect((fragments as string[]).join('?')).toContain('t.reversed_by_tip_id IS NULL');
    }
  });
});

describe('TipsReportService — owed, which is a different question', () => {
  it('reports the whole-ledger balance, not the window’s tips', async () => {
    const { service } = setup();

    const view = await service.tips(WINDOW, managerFixture());

    const layla = view.byTherapist[0]!;
    expect(layla.totalEarnedFils).toBe(24_000);
    // A balance is a balance (§9.3). Narrowing the dates narrows the earnings
    // lines; it never narrows what somebody is owed.
    expect(layla.outstandingPayableFils).toBe(38_500);
    expect(layla.unbatchedPayableFils).toBe(13_500);
    expect(view.payable.totalOutstandingFils).toBe(38_500);
    expect(view.payable.totalUnbatchedFils).toBe(13_500);
  });

  it('never folds DIRECT_CASH into the payable line', async () => {
    const { service } = setup();

    const view = await service.tips(WINDOW, managerFixture());

    const maya = view.byTherapist[1]!;
    // Maya earned 4 000 in cash the guest handed her directly. The business
    // never held it, so it owes her nothing — and a payout must not include it.
    expect(maya.totalEarnedFils).toBe(4_000);
    expect(maya.outstandingPayableFils).toBe(0);
    expect(view.payable.basis).toMatch(/pays a tip twice/);
  });

  it('leaves the ledger subqueries unbounded by the reporting window', async () => {
    const { service, prisma } = setup();

    await service.tips(WINDOW, managerFixture());

    const [fragments] = (prisma.$queryRaw as unknown as jest.Mock).mock.calls[0]!;
    const sql = (fragments as string[]).join('?');
    const ledgerClause = sql.slice(sql.indexOf('therapist_payout_ledger'));
    expect(ledgerClause).toContain('SUM(l.amount_fils)');
    expect(ledgerClause).toContain('l.payout_batch_id IS NULL');
    expect(ledgerClause).not.toContain('l.business_day');
  });

  it('reads an empty window as zeros rather than as missing keys', async () => {
    const { service } = setup([], []);

    const view = await service.tips(WINDOW, managerFixture());

    expect(view.byTherapist).toEqual([]);
    expect(view.byDay).toEqual([]);
    expect(view.byMode.totalFils).toBe(0);
    expect(view.payable.totalOutstandingFils).toBe(0);
  });
});

import { UserRole } from '@berelax/contracts';
import type { AuthUser } from '../common/request-context';
import type { PrismaService } from '../prisma/prisma.service';
import { DailyReportService } from './daily-report.service';

/**
 * The close-out sheet, with the database mocked out so the arithmetic is the
 * only thing under test.
 *
 * Three claims matter more than the rest:
 *
 *  1. the drawer figure is cash that went through the TILL, so a `DIRECT_CASH`
 *     tip can never be in it — the therapist already has that money (§9.1);
 *  2. a refunded tip is filed against the tip, not against the base, so sending
 *     50 AED back never reads as a shortfall on a 250 AED treatment (§13.3, 4b);
 *  3. the takings split by kind and the takings split by method are two
 *     decompositions of one number and must agree to the fils.
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

interface Rows {
  statuses?: Array<{ status: string; bookings: number; overdue: number }>;
  floor?: Array<{ worked: number; rostered: number }>;
  payments?: Array<{
    kind: string;
    method: string;
    reversesKind: string | null;
    entries: number;
    amountFils: number;
  }>;
  tips?: Array<{ type: string; tipCount: number; totalFils: number }>;
}

/** A full night: four treatments, one no-show, a card sale, a cash sale and both tip modes. */
const A_NIGHT: Required<Rows> = {
  statuses: [
    { status: 'COMPLETED', bookings: 4, overdue: 0 },
    { status: 'NO_SHOW', bookings: 1, overdue: 0 },
    { status: 'CANCELLED', bookings: 2, overdue: 0 },
    { status: 'IN_PROGRESS', bookings: 1, overdue: 1 },
    { status: 'SCHEDULED', bookings: 1, overdue: 0 },
  ],
  floor: [{ worked: 3, rostered: 5 }],
  payments: [
    { kind: 'BASE', method: 'CASH', reversesKind: null, entries: 3, amountFils: 75_000 },
    { kind: 'BASE', method: 'CARD', reversesKind: null, entries: 2, amountFils: 50_000 },
    { kind: 'TIP', method: 'CARD', reversesKind: null, entries: 1, amountFils: 5_000 },
    { kind: 'REFUND', method: 'CARD', reversesKind: 'TIP', entries: 1, amountFils: -5_000 },
    { kind: 'REFUND', method: 'CASH', reversesKind: 'BASE', entries: 1, amountFils: -10_000 },
    { kind: 'ADJUSTMENT', method: 'CASH', reversesKind: null, entries: 1, amountFils: -2_500 },
  ],
  tips: [
    { type: 'DIRECT_CASH', tipCount: 2, totalFils: 9_000 },
    { type: 'COLLECTED_BY_BUSINESS', tipCount: 1, totalFils: 5_000 },
  ],
};

function setup(rows: Rows = {}) {
  const queue = [
    rows.statuses ?? [],
    rows.floor ?? [{ worked: 0, rostered: 0 }],
    rows.payments ?? [],
    rows.tips ?? [],
  ];

  const $queryRaw = jest.fn();
  for (const result of queue) $queryRaw.mockResolvedValueOnce(result);

  const prisma = {
    $queryRaw,
    // The real call batches the four statements into one REPEATABLE READ
    // transaction. Mocked as Promise.all so the ORDER of the four is still
    // exactly what the service declares.
    $transaction: jest.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
  } as unknown as PrismaService;

  return { prisma, service: new DailyReportService(prisma) };
}

describe('DailyReportService — the night in counts', () => {
  it('splits bookings by status and totals them', async () => {
    const { service } = setup(A_NIGHT);

    const view = await service.daily({ businessDay: '2026-09-16' }, managerFixture());

    expect(view.businessDay).toBe('2026-09-16');
    expect(view.bookings).toEqual({
      total: 9,
      scheduled: 1,
      inProgress: 1,
      completed: 4,
      cancelled: 2,
      noShow: 1,
      needingCheckout: 1,
    });
    // Arrived, whether or not they have left: COMPLETED plus IN_PROGRESS.
    expect(view.guestsSeen).toBe(5);
    expect(view.therapists).toEqual({ worked: 3, rostered: 5 });
  });

  it('defaults to tonight rather than to a date fixed at import time', async () => {
    const { service, prisma } = setup();

    const view = await service.daily({}, managerFixture());

    expect(view.businessDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The bindings of the first statement, in order: the §8.4 overdue window,
    // the branch off the token, and the trading day it fell back to.
    const [, ...values] = (prisma.$queryRaw as unknown as jest.Mock).mock.calls[0]!;
    expect(values).toEqual([2, BRANCH_ID, view.businessDay]);
  });

  it('scopes every statement to the branch on the token', async () => {
    const { service, prisma } = setup(A_NIGHT);

    await service.daily({ businessDay: '2026-09-16' }, managerFixture());

    const calls = (prisma.$queryRaw as unknown as jest.Mock).mock.calls;
    expect(calls).toHaveLength(4);
    for (const call of calls) expect(call.slice(1)).toContain(BRANCH_ID);
  });

  it('reads a night the spa did not trade as zeros, not as missing keys', async () => {
    const { service } = setup();

    const view = await service.daily({ businessDay: '2019-01-01' }, managerFixture());

    expect(view.bookings.total).toBe(0);
    expect(view.guestsSeen).toBe(0);
    expect(view.takings.grossFils).toBe(0);
    expect(view.takings.byMethod).toEqual([]);
    expect(view.tips.totalFils).toBe(0);
    expect(view.cashDrawer.expectedCashFils).toBe(0);
  });
});

describe('DailyReportService — the takings', () => {
  it('files a refunded tip against the tip and never against the base', async () => {
    const { service } = setup(A_NIGHT);

    const view = await service.daily({ businessDay: '2026-09-16' }, managerFixture());

    // 125 000 base in, 10 000 base back out; the 5 000 tip refund belongs to the
    // tip line. Bucketing it with the base would make a fully-paid night look
    // 5 000 short and start a conversation about a receptionist.
    expect(view.takings.baseCollectedFils).toBe(125_000);
    expect(view.takings.baseRefundedFils).toBe(-10_000);
    expect(view.takings.tipsCollectedFils).toBe(0);
    expect(view.takings.adjustmentsFils).toBe(-2_500);
  });

  it('adds up to the same gross whether split by kind or by method', async () => {
    const { service } = setup(A_NIGHT);

    const view = await service.daily({ businessDay: '2026-09-16' }, managerFixture());

    expect(view.takings.grossFils).toBe(112_500);
    expect(
      view.takings.baseCollectedFils +
        view.takings.baseRefundedFils +
        view.takings.tipsCollectedFils +
        view.takings.adjustmentsFils,
    ).toBe(view.takings.grossFils);
    expect(view.takings.byMethod.reduce((sum, line) => sum + line.amountFils, 0)).toBe(
      view.takings.grossFils,
    );
  });

  it('rolls every kind up into one line per method, largest first', async () => {
    const { service } = setup(A_NIGHT);

    const view = await service.daily({ businessDay: '2026-09-16' }, managerFixture());

    expect(view.takings.byMethod).toEqual([
      // 75 000 base − 10 000 refund − 2 500 adjustment
      { method: 'CASH', entries: 5, amountFils: 62_500 },
      // 50 000 base + 5 000 tip − 5 000 tip refund
      { method: 'CARD', entries: 4, amountFils: 50_000 },
    ]);
  });
});

describe('DailyReportService — the drawer and the two tip modes', () => {
  it('expects only what went through the till', async () => {
    const { service } = setup(A_NIGHT);

    const view = await service.daily({ businessDay: '2026-09-16' }, managerFixture());

    // Every CASH row, signed: 75 000 − 10 000 − 2 500.
    expect(view.cashDrawer.expectedCashFils).toBe(62_500);
    expect(view.cashDrawer.baseCashFils).toBe(75_000);
    expect(view.cashDrawer.refundedCashFils).toBe(-10_000);
    expect(view.cashDrawer.adjustmentCashFils).toBe(-2_500);
    expect(view.cashDrawer.tipCashFils).toBe(0);
    expect(
      view.cashDrawer.baseCashFils +
        view.cashDrawer.tipCashFils +
        view.cashDrawer.refundedCashFils +
        view.cashDrawer.adjustmentCashFils,
    ).toBe(view.cashDrawer.expectedCashFils);
  });

  it('keeps 9 000 fils of DIRECT_CASH tips out of the drawer entirely', async () => {
    const { service } = setup(A_NIGHT);

    const view = await service.daily({ businessDay: '2026-09-16' }, managerFixture());

    expect(view.tips.directCash).toEqual({ tipCount: 2, totalFils: 9_000 });
    // The therapists walked out with it. A manager counting the till against
    // 71 500 would be 9 000 short and would go looking for a thief.
    expect(view.cashDrawer.expectedCashFils).toBe(62_500);
    expect(view.cashDrawer.note).toMatch(/never entered the till/);
  });

  it('reports what the business now owes as the collected line alone', async () => {
    const { service } = setup(A_NIGHT);

    const view = await service.daily({ businessDay: '2026-09-16' }, managerFixture());

    expect(view.tips.collectedByBusiness).toEqual({ tipCount: 1, totalFils: 5_000 });
    // Earned tonight: 14 000. Owed by the business: 5 000. Adding the two and
    // paying that out is how a spa pays a tip twice. §9.1.
    expect(view.tips.totalFils).toBe(14_000);
    expect(view.tips.payableFils).toBe(5_000);
    expect(view.tips.labels.directCash).toMatch(/never held/);
    expect(view.tips.labels.collectedByBusiness).toMatch(/NOT revenue/);
  });

  it('reads a mode with no tips as zero rather than as absent', async () => {
    const { service } = setup({ tips: [{ type: 'DIRECT_CASH', tipCount: 1, totalFils: 3_000 }] });

    const view = await service.daily({ businessDay: '2026-09-16' }, managerFixture());

    expect(view.tips.collectedByBusiness).toEqual({ tipCount: 0, totalFils: 0 });
    expect(view.tips.payableFils).toBe(0);
    expect(view.tips.totalFils).toBe(3_000);
  });
});

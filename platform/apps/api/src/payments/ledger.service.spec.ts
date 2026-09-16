import { HttpException } from '@nestjs/common';
import type { ApiErrorBody } from '@berelax/contracts';
import { ErrorCode, UserRole, businessDay } from '@berelax/contracts';
import type { AuthUser } from '../common/request-context';
import type { PrismaService } from '../prisma/prisma.service';
import { LEDGER_DEFAULT_SPAN_DAYS, LedgerService } from './ledger.service';
import { shiftTradingDay } from './money.support';

/**
 * The read side of the money layer. Two properties are worth more than all the
 * rest put together:
 *
 *   1. the balance is SUM(amount_fils) and nothing else — §9.3;
 *   2. cash the therapist is holding and money the business owes are two
 *      separate figures that are never added together — §9.2.
 *
 * The second one is not a formatting preference. Adding those two lines is how
 * a spa pays a tip twice, and it is the bug this suite exists to prevent.
 */

const EMPLOYEE_ID = '0192cccc-0000-7000-8000-00000000000c';
const OTHER_EMPLOYEE_ID = '0192cccc-0000-7000-8000-00000000000f';
const BRANCH_ID = '0192bbbb-0000-7000-8000-00000000000b';

function managerFixture(): AuthUser {
  return {
    id: '0192dddd-0000-7000-8000-00000000000d',
    role: UserRole.MANAGER,
    branchId: BRANCH_ID,
    email: 'manager@berelax.ae',
    fullName: 'Manager',
  };
}

function therapistFixture(employeeId: string | null = EMPLOYEE_ID): AuthUser {
  return {
    id: '0192dddd-0000-7000-8000-00000000000e',
    role: UserRole.THERAPIST,
    branchId: BRANCH_ID,
    employeeId,
    email: 'therapist@berelax.ae',
    fullName: 'Therapist A',
  };
}

const LEDGER_ROW = {
  id: 'entry-1',
  createdAt: new Date('2026-09-16T16:12:00.000Z'),
  businessDay: new Date('2026-09-16T00:00:00.000Z'),
  entryType: 'TIP_ACCRUAL',
  amountFils: 5_000,
  reservationRef: 'BR-2026-0417',
  tipType: 'COLLECTED_BY_BUSINESS',
  recordedBy: 'Reception',
  payoutBatchId: 'batch-1',
  paidInBatchAt: new Date('2026-10-01T08:00:00.000Z'),
  acknowledgedAt: new Date('2026-10-02T10:00:00.000Z'),
  note: 'Tip collected by business on BR-2026-0417',
};

/** A commission accrual: no tip, no booking reference on the join, not yet paid. */
const BARE_ROW = {
  id: 'entry-2',
  createdAt: new Date('2026-09-17T16:12:00.000Z'),
  businessDay: new Date('2026-09-17T00:00:00.000Z'),
  entryType: 'COMMISSION_ACCRUAL',
  amountFils: 2_500,
  reservationRef: null,
  tipType: null,
  recordedBy: null,
  payoutBatchId: null,
  paidInBatchAt: null,
  acknowledgedAt: null,
  note: null,
};

function setup(
  options: {
    rows?: Array<Record<string, unknown>>;
    /** [whole ledger, unbatched only]; null stands for "no rows at all". */
    sums?: [number | null, number | null];
    count?: number;
    tips?: Array<{ type: string; _sum: { amountFils: number | null }; _count: { _all: number } }>;
    ledgerGroups?: Array<{ entryType: string; _sum: { amountFils: number | null } }>;
    employeeExists?: boolean;
  } = {},
) {
  const [balance, unbatched] = options.sums ?? [7_500, 2_500];

  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue(options.rows ?? [LEDGER_ROW, BARE_ROW]),
    employee: {
      findFirst: jest
        .fn()
        .mockResolvedValue(options.employeeExists === false ? null : { id: EMPLOYEE_ID }),
    },
    therapistPayoutLedger: {
      aggregate: jest.fn(async ({ where }: { where: { payoutBatchId?: null } }) => ({
        _sum: { amountFils: where.payoutBatchId === null ? unbatched : balance },
      })),
      count: jest.fn().mockResolvedValue(options.count ?? 2),
      groupBy: jest.fn().mockResolvedValue(options.ledgerGroups ?? []),
    },
    tip: { groupBy: jest.fn().mockResolvedValue(options.tips ?? []) },
  } as unknown as PrismaService;

  return { prisma, service: new LedgerService(prisma) };
}

async function caught(run: () => Promise<unknown>): Promise<{ status: number; body: ApiErrorBody }> {
  try {
    await run();
  } catch (err) {
    const http = err as HttpException;
    return { status: http.getStatus(), body: http.getResponse() as ApiErrorBody };
  }
  throw new Error('expected the call to reject, but it resolved');
}

describe('LedgerService — who may read what', () => {
  it('403s a therapist reading a colleague’s ledger', async () => {
    const { service } = setup();

    const { status, body } = await caught(() =>
      service.entries(OTHER_EMPLOYEE_ID, { limit: 200 }, therapistFixture()),
    );

    expect(status).toBe(403);
    expect(body.error.code).toBe(ErrorCode.INSUFFICIENT_ROLE);
  });

  it('403s a therapist login with no employee record behind it', async () => {
    const { service } = setup();

    const { status } = await caught(() =>
      service.balance(EMPLOYEE_ID, therapistFixture(null)),
    );

    expect(status).toBe(403);
  });

  it('lets a therapist read their own record, and a manager read anyone’s', async () => {
    const { service } = setup();

    await expect(service.balance(EMPLOYEE_ID, therapistFixture())).resolves.toMatchObject({
      employeeId: EMPLOYEE_ID,
    });
    await expect(service.balance(OTHER_EMPLOYEE_ID, managerFixture())).resolves.toMatchObject({
      employeeId: OTHER_EMPLOYEE_ID,
    });
  });

  it('404s an unknown employee instead of answering "owed nothing"', async () => {
    const { service } = setup({ employeeExists: false });

    const { status, body } = await caught(() =>
      service.entries(EMPLOYEE_ID, { limit: 200 }, managerFixture()),
    );

    expect(status).toBe(404);
    expect(body.error.code).toBe(ErrorCode.NOT_FOUND);
  });
});

describe('LedgerService — the dispute artefact (§9.7)', () => {
  it('returns every line with its booking, its author and its batch', async () => {
    const { service } = setup();

    const view = await service.entries(
      EMPLOYEE_ID,
      { from: '2026-09-01', to: '2026-09-30', limit: 200 },
      managerFixture(),
    );

    expect(view.entries).toEqual([
      {
        id: 'entry-1',
        createdAt: '2026-09-16T16:12:00.000Z',
        businessDay: '2026-09-16',
        entryType: 'TIP_ACCRUAL',
        amountFils: 5_000,
        reservationRef: 'BR-2026-0417',
        tipType: 'COLLECTED_BY_BUSINESS',
        recordedBy: 'Reception',
        payoutBatchId: 'batch-1',
        paidInBatchAt: '2026-10-01T08:00:00.000Z',
        acknowledgedAt: '2026-10-02T10:00:00.000Z',
        note: 'Tip collected by business on BR-2026-0417',
      },
      {
        id: 'entry-2',
        createdAt: '2026-09-17T16:12:00.000Z',
        businessDay: '2026-09-17',
        entryType: 'COMMISSION_ACCRUAL',
        amountFils: 2_500,
        reservationRef: null,
        tipType: null,
        recordedBy: null,
        payoutBatchId: null,
        paidInBatchAt: null,
        acknowledgedAt: null,
        note: null,
      },
    ]);
    expect(view.windowTotalFils).toBe(7_500);
    expect(view.entryCount).toBe(2);
  });

  it('reports the balance over the WHOLE ledger, not the window it was asked for', async () => {
    const { service } = setup({ rows: [BARE_ROW], sums: [42_000, 2_500] });

    const view = await service.entries(
      EMPLOYEE_ID,
      { from: '2026-09-17', to: '2026-09-17', limit: 200 },
      managerFixture(),
    );

    // A balance is a balance. Narrowing the dates narrows the LINES, never the
    // number the therapist is owed.
    expect(view.balanceFils).toBe(42_000);
    expect(view.unbatchedFils).toBe(2_500);
    expect(view.windowTotalFils).toBe(2_500);
  });

  it('opens on the last ninety trading days when no period is given', async () => {
    const { service } = setup();

    const view = await service.entries(EMPLOYEE_ID, { limit: 200 }, managerFixture());

    expect(view.to).toBe(businessDay(new Date()));
    expect(view.from).toBe(shiftTradingDay(view.to, -LEDGER_DEFAULT_SPAN_DAYS));
  });

  it('422s a period that ends before it starts', async () => {
    const { service } = setup();

    const { status, body } = await caught(() =>
      service.entries(EMPLOYEE_ID, { from: '2026-09-30', to: '2026-09-01', limit: 200 }, managerFixture()),
    );

    expect(status).toBe(422);
    expect(body.error.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it('passes the window and the limit to the query, scoped to the branch', async () => {
    const { service, prisma } = setup();
    await service.entries(EMPLOYEE_ID, { from: '2026-09-01', to: '2026-09-30', limit: 25 }, managerFixture());

    const call = (prisma.$queryRaw as unknown as jest.Mock).mock.calls[0]!;
    expect((call[0] as string[]).join('?')).toContain('therapist_payout_ledger');
    expect(call.slice(1)).toEqual([EMPLOYEE_ID, BRANCH_ID, '2026-09-01', '2026-09-30', 25]);
  });
});

describe('LedgerService — the balance is always a sum (§9.3)', () => {
  it('answers with the sum, what is unbatched, and how many rows made it', async () => {
    const { service } = setup({ sums: [38_500, 13_500], count: 19 });

    const view = await service.balance(EMPLOYEE_ID, managerFixture());

    expect(view).toMatchObject({
      employeeId: EMPLOYEE_ID,
      balanceFils: 38_500,
      unbatchedFils: 13_500,
      entryCount: 19,
    });
    expect(view.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('reads an empty ledger as zero rather than null', async () => {
    const { service } = setup({ sums: [null, null], count: 0 });

    const view = await service.balance(EMPLOYEE_ID, managerFixture());

    expect(view.balanceFils).toBe(0);
    expect(view.unbatchedFils).toBe(0);
  });
});

describe('LedgerService — earnings, kept deliberately apart (§9.2)', () => {
  const tipGroups = [
    { type: 'DIRECT_CASH', _sum: { amountFils: 64_000 }, _count: { _all: 12 } },
    { type: 'COLLECTED_BY_BUSINESS', _sum: { amountFils: 25_000 }, _count: { _all: 5 } },
  ];
  const ledgerGroups = [
    { entryType: 'TIP_ACCRUAL', _sum: { amountFils: 25_000 } },
    { entryType: 'COMMISSION_ACCRUAL', _sum: { amountFils: 13_500 } },
    { entryType: 'PAYOUT', _sum: { amountFils: -20_000 } },
    { entryType: 'REVERSAL', _sum: { amountFils: -5_000 } },
    { entryType: 'ADJUSTMENT', _sum: { amountFils: 1_000 } },
  ];

  it('reports cash the therapist holds and money the business owes as two figures', async () => {
    const { service } = setup({ tips: tipGroups, ledgerGroups, sums: [38_500, 18_500] });

    const view = await service.earnings(
      EMPLOYEE_ID,
      { from: '2026-09-01', to: '2026-09-30' },
      managerFixture(),
    );

    expect(view.cashReceivedDirectly).toEqual({
      label: expect.stringContaining('already holding'),
      tipCount: 12,
      totalFils: 64_000,
    });
    expect(view.heldByBusinessAndPayable).toMatchObject({
      label: expect.stringContaining('payable'),
      tipsCollected: { tipCount: 5, totalFils: 25_000 },
      commissionAccruedFils: 13_500,
      adjustmentsFils: 1_000,
      reversalsFils: -5_000,
      // 25 000 accrued + 13 500 commission + 1 000 adjustment − 5 000 reversed
      accruedInPeriodFils: 34_500,
      // Stored negative on the ledger, read as a magnitude on a statement.
      paidOutInPeriodFils: 20_000,
      balanceNowFils: 38_500,
      unbatchedFils: 18_500,
    });
    // The two lines are reported side by side and summed only into "earned",
    // never into "owed": 64 000 of that total is already in the therapist's hand.
    expect(view.totalEarnedInPeriodFils).toBe(98_500);
    expect(view.explanation).toContain('pays a tip twice');
  });

  it('reads a quiet month as zeros, not as missing keys', async () => {
    const { service } = setup({ tips: [], ledgerGroups: [], sums: [null, null] });

    const view = await service.earnings(
      EMPLOYEE_ID,
      { from: '2026-09-01', to: '2026-09-30' },
      managerFixture(),
    );

    expect(view.cashReceivedDirectly).toMatchObject({ tipCount: 0, totalFils: 0 });
    expect(view.heldByBusinessAndPayable).toMatchObject({
      tipsCollected: { tipCount: 0, totalFils: 0 },
      commissionAccruedFils: 0,
      accruedInPeriodFils: 0,
      paidOutInPeriodFils: 0,
      balanceNowFils: 0,
    });
    expect(view.totalEarnedInPeriodFils).toBe(0);
  });

  it('treats a NULL sum from Postgres as zero fils', async () => {
    const { service } = setup({
      tips: [{ type: 'DIRECT_CASH', _sum: { amountFils: null }, _count: { _all: 0 } }],
      ledgerGroups: [{ entryType: 'PAYOUT', _sum: { amountFils: null } }],
    });

    const view = await service.earnings(EMPLOYEE_ID, {}, managerFixture());

    expect(view.cashReceivedDirectly.totalFils).toBe(0);
    expect(view.heldByBusinessAndPayable.paidOutInPeriodFils).toBe(0);
  });

  it('defaults to the trading month, and excludes reversed tips on both sides', async () => {
    const { service, prisma } = setup({ tips: tipGroups, ledgerGroups });

    const view = await service.earnings(EMPLOYEE_ID, {}, therapistFixture());

    const today = businessDay(new Date());
    expect(view.period).toEqual({ from: `${today.slice(0, 7)}-01`, to: today });

    const { where } = (prisma.tip.groupBy as unknown as jest.Mock).mock.calls[0]![0] as {
      where: Record<string, unknown>;
    };
    // §9.2's query, to the letter: a reversed tip is not earnings, and neither
    // is its mirror row.
    expect(where).toMatchObject({ employeeId: EMPLOYEE_ID, branchId: BRANCH_ID, reversedByTipId: null });
  });
});

import { UserRole, ReconciliationVerdict } from '@berelax/contracts';
import { AuditAction, type AuditService } from '../common/audit.service';
import type { AuthUser, RequestContext } from '../common/request-context';
import type { PrismaService } from '../prisma/prisma.service';
import type {
  CloseOutDetailView,
  DailyReportService,
  DailyReportView,
} from '../reports/daily-report.service';
import { ReconciliationConfig } from './reconciliation.config';
import { ReconciliationService } from './reconciliation.service';
import { StreakBreakReason } from './reconciliation.support';

/**
 * The service, with the database and the report service mocked out.
 *
 * What is actually being asserted here is the WRITE: that the row stored for a
 * night carries the system figures as they stood, the variances derived from
 * them, the tolerance in force, and whoever was taking cash at the desk — and
 * that a second submission for the same night is a NEW row pointing at the one
 * it corrects, never an edit of it. The line arithmetic itself belongs to
 * `reconciliation.support.spec.ts`; this file is about what survives to the
 * table, because that is what the switchover decision is read from months later.
 */

const BRANCH_ID = '0192bbbb-0000-7000-8000-00000000000b';
const DESK_USER_ID = '0192ffff-0000-7000-8000-00000000000f';
const NIGHT = '2026-09-16';

function manager(): AuthUser {
  return {
    id: '0192dddd-0000-7000-8000-00000000000d',
    role: UserRole.MANAGER,
    branchId: BRANCH_ID,
    email: 'manager@berelax.ae',
    fullName: 'Duty Manager',
  };
}

function ctx(): RequestContext {
  return {
    requestId: 'req_test',
    branchId: BRANCH_ID,
    actorUserId: manager().id,
    actorRole: UserRole.MANAGER,
  };
}

function reportFixture(overrides: Partial<DailyReportView> = {}): DailyReportView {
  return {
    businessDay: NIGHT,
    generatedAt: '2026-09-17T02:10:00.000Z',
    bookings: {
      total: 26,
      scheduled: 0,
      inProgress: 0,
      completed: 23,
      cancelled: 2,
      noShow: 1,
      needingCheckout: 0,
    },
    guestsSeen: 23,
    therapists: { worked: 6, rostered: 8 },
    takings: {
      grossFils: 626_000,
      baseCollectedFils: 566_000,
      baseRefundedFils: 0,
      tipsCollectedFils: 60_000,
      adjustmentsFils: 0,
      byMethod: [],
    },
    tips: {
      directCash: { tipCount: 6, totalFils: 30_000 },
      collectedByBusiness: { tipCount: 4, totalFils: 60_000 },
      totalFils: 90_000,
      payableFils: 60_000,
      labels: { directCash: 'handed over', collectedByBusiness: 'held' },
    },
    cashDrawer: {
      expectedCashFils: 184_000,
      baseCashFils: 174_000,
      tipCashFils: 10_000,
      refundedCashFils: 0,
      adjustmentCashFils: 0,
      note: 'drawer',
    },
    cardTerminal: {
      expectedCardFils: 412_000,
      baseCardFils: 362_000,
      tipCardFils: 50_000,
      refundedCardFils: 0,
      adjustmentCardFils: 0,
      note: 'terminal',
    },
    ...overrides,
  };
}

const DETAIL: CloseOutDetailView = {
  businessDay: NIGHT,
  byTherapist: [],
  openSessions: [],
  cashDesk: [{ userId: DESK_USER_ID, fullName: 'Reception', entries: 17, amountFils: 184_000 }],
};

interface Harness {
  service: ReconciliationService;
  create: jest.Mock;
  findFirst: jest.Mock;
  findMany: jest.Mock;
  auditWrite: jest.Mock;
}

function setup(options: { report?: DailyReportView; tolerance?: string; previousId?: string } = {}): Harness {
  const create = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: '0192cccc-0000-7000-8000-00000000000c',
    submittedAt: new Date('2026-09-17T02:30:00.000Z'),
    supersedesId: null,
    paperTipsCashFils: null,
    tipsCashVarianceFils: null,
    note: null,
    ...data,
  }));
  const findFirst = jest.fn().mockResolvedValue(
    options.previousId ? { id: options.previousId } : null,
  );
  // Called by `streak()` after every submit.
  const findMany = jest.fn().mockResolvedValue([]);
  const auditWrite = jest.fn().mockResolvedValue(undefined);

  const tx = { nightlyReconciliation: { create, findFirst } };
  const prisma = {
    nightlyReconciliation: { findMany, findFirst },
    $transaction: jest.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
  } as unknown as PrismaService;

  const dailyReport = {
    daily: jest.fn().mockResolvedValue(options.report ?? reportFixture()),
    closeOutDetail: jest.fn().mockResolvedValue(DETAIL),
  } as unknown as DailyReportService;

  const config = new ReconciliationConfig({
    get: () => options.tolerance,
  } as never);

  const service = new ReconciliationService(
    prisma,
    dailyReport,
    config,
    { write: auditWrite } as unknown as AuditService,
  );

  return { service, create, findFirst, findMany, auditWrite };
}

const MATCHING_PAPER = {
  countedCashFils: 184_000,
  paperBookings: 23,
  paperCardTotalFils: 412_000,
};

describe('ReconciliationService.submit — what reaches the table', () => {
  it('snapshots the system figures rather than leaving them to be recomputed', async () => {
    const { service, create } = setup();

    await service.submit(NIGHT, MATCHING_PAPER, manager(), ctx());

    // A refund filed next Thursday against a Tuesday payment legitimately moves
    // Tuesday's live total. It must not silently un-match a night that was
    // signed off on Tuesday, so the figures are stored, not referenced.
    expect(create.mock.calls[0]?.[0].data).toMatchObject({
      systemCashFils: 184_000,
      systemCardTotalFils: 412_000,
      systemBookings: 23,
      systemTipsCashFils: 30_000,
      openSessions: 0,
    });
  });

  it('stores the variance signed, and the tolerance that was in force', async () => {
    const { service, create } = setup({ tolerance: '500' });

    await service.submit(
      NIGHT,
      { ...MATCHING_PAPER, countedCashFils: 183_800 },
      manager(),
      ctx(),
    );

    const data = create.mock.calls[0]?.[0].data;
    expect(data).toMatchObject({
      cashVarianceFils: -200,
      cardVarianceFils: 0,
      bookingsVariance: 0,
      cashToleranceFils: 500,
      verdict: ReconciliationVerdict.MATCHED,
    });
  });

  it('attributes the night to whoever actually took cash at the desk', async () => {
    const { service, create } = setup();

    await service.submit(NIGHT, MATCHING_PAPER, manager(), ctx());

    // §15.4: the system cannot prove the cash reached the drawer; what it can
    // do is name the people on shift when it was taken. Not the manager
    // signing it off — they were not the ones holding it.
    expect(create.mock.calls[0]?.[0].data.cashDeskUserIds).toEqual([DESK_USER_ID]);
    expect(create.mock.calls[0]?.[0].data.submittedByUserId).toBe(manager().id);
  });

  it('stores the line-by-line comparison exactly as it was presented', async () => {
    const { service, create } = setup();

    const result = await service.submit(NIGHT, MATCHING_PAPER, manager(), ctx());

    expect(create.mock.calls[0]?.[0].data.lines).toEqual(result.lines);
    expect(result.lines).toHaveLength(5);
  });

  it('leaves the optional tips line null rather than recording a zero', async () => {
    const { service, create } = setup();

    await service.submit(NIGHT, MATCHING_PAPER, manager(), ctx());

    const data = create.mock.calls[0]?.[0].data;
    expect(data.paperTipsCashFils).toBeNull();
    expect(data.tipsCashVarianceFils).toBeNull();
  });

  it('records the tips variance when the figure was supplied', async () => {
    const { service, create } = setup();

    await service.submit(
      NIGHT,
      { ...MATCHING_PAPER, paperTipsCashFils: 27_000 },
      manager(),
      ctx(),
    );

    expect(create.mock.calls[0]?.[0].data).toMatchObject({
      paperTipsCashFils: 27_000,
      tipsCashVarianceFils: -3_000,
      verdict: ReconciliationVerdict.MISMATCHED,
    });
  });
});

describe('ReconciliationService.submit — corrections', () => {
  it('writes a NEW row pointing at the submission it corrects', async () => {
    const previousId = '0192aaaa-0000-7000-8000-00000000000a';
    const { service, create, findFirst } = setup({ previousId });

    await service.submit(NIGHT, MATCHING_PAPER, manager(), ctx());

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }] }),
    );
    expect(create.mock.calls[0]?.[0].data.supersedesId).toBe(previousId);
  });

  it('leaves supersedesId null on the first submission for a night', async () => {
    const { service, create } = setup();

    await service.submit(NIGHT, MATCHING_PAPER, manager(), ctx());

    expect(create.mock.calls[0]?.[0].data.supersedesId).toBeNull();
  });
});

describe('ReconciliationService.submit — the audit trail', () => {
  it('audits inside the same transaction as the write', async () => {
    const { service, auditWrite } = setup();

    await service.submit(NIGHT, MATCHING_PAPER, manager(), ctx());

    expect(auditWrite).toHaveBeenCalledTimes(1);
    const [, auditCtx, entry] = auditWrite.mock.calls[0] ?? [];
    expect(auditCtx).toEqual(ctx());
    expect(entry).toMatchObject({
      action: AuditAction.RECONCILIATION_SUBMITTED,
      entityType: 'NightlyReconciliation',
    });
  });

  it('files the cash variance as the audited amount — the number searched for later', async () => {
    const { service, auditWrite } = setup();

    await service.submit(
      NIGHT,
      { ...MATCHING_PAPER, countedCashFils: 179_000 },
      manager(),
      ctx(),
    );

    expect(auditWrite.mock.calls[0]?.[2]).toMatchObject({ amountFils: -5_000 });
  });
});

describe('ReconciliationService.streak — the effective verdict per night', () => {
  function row(businessDay: string, verdict: ReconciliationVerdict, id: string) {
    return { id, businessDay: new Date(`${businessDay}T00:00:00.000Z`), verdict };
  }

  it('counts each night once, at its most recent submission', async () => {
    const { service, findMany } = setup();
    // Ordered newest-first per night, as the query asks for. The 16th was
    // reconciled twice: found wrong, fixed, reconciled again.
    findMany.mockResolvedValue([
      row('2026-09-16', ReconciliationVerdict.MATCHED, 'b'),
      row('2026-09-16', ReconciliationVerdict.MISMATCHED, 'a'),
      row('2026-09-15', ReconciliationVerdict.MATCHED, 'c'),
    ]);

    const streak = await service.streak(manager());

    // A night that was reconciled, found wrong, fixed and reconciled again
    // matched in the end. Refusing to let it count would punish people for
    // using the tool properly — and the failed attempt stays in the history.
    expect(streak.nights.map((night) => night.businessDay)).toEqual([
      '2026-09-16',
      '2026-09-15',
    ]);
    expect(streak.consecutiveMatchedNights).toBe(2);
  });

  it('stops at the most recent mismatch', async () => {
    const { service, findMany } = setup();
    findMany.mockResolvedValue([
      row('2026-09-16', ReconciliationVerdict.MATCHED, 'c'),
      row('2026-09-15', ReconciliationVerdict.MISMATCHED, 'b'),
      row('2026-09-14', ReconciliationVerdict.MATCHED, 'a'),
    ]);

    const streak = await service.streak(manager());

    expect(streak.consecutiveMatchedNights).toBe(1);
    expect(streak.brokenBy).toEqual({
      businessDay: '2026-09-15',
      reason: StreakBreakReason.MISMATCHED,
    });
    expect(streak.readyToSwitch).toBe(false);
  });

  it('scopes the read to the branch on the token, never to a parameter', async () => {
    const { service, findMany } = setup();

    await service.streak(manager());

    expect(findMany.mock.calls[0]?.[0].where).toMatchObject({ branchId: BRANCH_ID });
  });
});

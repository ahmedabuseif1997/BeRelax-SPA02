import { UserRole } from '@berelax/contracts';
import type { AuthUser } from '../common/request-context';
import type {
  CloseOutDetailView,
  DailyReportService,
  DailyReportView,
} from '../reports/daily-report.service';
import { CloseOutSheetService, systemFiguresFrom } from './close-out-sheet.service';
import { ReconciliationLineKey } from './reconciliation.support';

/**
 * The sheet reception ticks off at 02:00, with the report service mocked so the
 * only thing under test is the arrangement.
 *
 * The claim that matters most is `systemFiguresFrom`: the figure PRINTED on the
 * tick-list and the figure the verdict is later decided against are the same
 * read of the same field, not two readings that happen to agree today. Every
 * other assertion here is about saying out loud what would make tonight's
 * comparison misleading.
 */

const BRANCH_ID = '0192bbbb-0000-7000-8000-00000000000b';

function manager(): AuthUser {
  return {
    id: '0192dddd-0000-7000-8000-00000000000d',
    role: UserRole.MANAGER,
    branchId: BRANCH_ID,
    email: 'manager@berelax.ae',
    fullName: 'Duty Manager',
  };
}

function reportFixture(overrides: Partial<DailyReportView> = {}): DailyReportView {
  return {
    businessDay: '2026-09-16',
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
      labels: { directCash: 'handed over', collectedByBusiness: 'held by BE RELAX' },
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

function detailFixture(overrides: Partial<CloseOutDetailView> = {}): CloseOutDetailView {
  return {
    businessDay: '2026-09-16',
    byTherapist: [
      {
        employeeId: '0192eeee-0000-7000-8000-00000000000e',
        displayName: 'Maya',
        sessions: 4,
        completed: 4,
        inProgress: 0,
        scheduled: 0,
        noShow: 0,
        cancelled: 1,
        tipsDirectCashFils: 10_000,
        tipsCollectedByBusinessFils: 20_000,
      },
    ],
    openSessions: [],
    cashDesk: [
      {
        userId: '0192ffff-0000-7000-8000-00000000000f',
        fullName: 'Reception',
        entries: 17,
        amountFils: 184_000,
      },
    ],
    ...overrides,
  };
}

function setup(report = reportFixture(), detail = detailFixture()) {
  const daily = jest.fn().mockResolvedValue(report);
  const closeOutDetail = jest.fn().mockResolvedValue(detail);
  const dailyReport = { daily, closeOutDetail } as unknown as DailyReportService;

  return { daily, closeOutDetail, service: new CloseOutSheetService(dailyReport) };
}

describe('systemFiguresFrom', () => {
  it('takes every compared figure straight off the close-out report', () => {
    const report = reportFixture();

    expect(systemFiguresFrom(report)).toEqual({
      cashFils: report.cashDrawer.expectedCashFils,
      cardFils: report.cardTerminal.expectedCardFils,
      bookings: report.guestsSeen,
      tipsDirectCashFils: report.tips.directCash.totalFils,
      openSessions: report.bookings.inProgress,
    });
  });

  it('counts sessions as guests SEEN, not as bookings taken', () => {
    // 26 bookings on the grid; 23 guests were treated. Reception's paper sheet
    // has the 23 on it — a cancellation was never a session and a no-show never
    // happened.
    const figures = systemFiguresFrom(reportFixture());

    expect(figures.bookings).toBe(23);
  });
});

describe('CloseOutSheetService', () => {
  it('asks the report service for the night, and nothing else for the figures', async () => {
    const { service, daily, closeOutDetail } = setup();

    const sheet = await service.sheet('2026-09-16', manager());

    expect(daily).toHaveBeenCalledWith({ businessDay: '2026-09-16' }, manager());
    expect(closeOutDetail).toHaveBeenCalledWith({ businessDay: '2026-09-16' }, manager());
    expect(sheet.cash.expectedCashFils).toBe(184_000);
    expect(sheet.card.expectedCardFils).toBe(412_000);
    expect(sheet.tips.payableFils).toBe(60_000);
  });

  it('lists the five things to check, in the order the form asks for them', async () => {
    const { service } = setup();

    const sheet = await service.sheet('2026-09-16', manager());

    expect(sheet.toCheck.map((line) => line.key)).toEqual([
      ReconciliationLineKey.CASH,
      ReconciliationLineKey.CARD,
      ReconciliationLineKey.BOOKINGS,
      ReconciliationLineKey.TIPS_DIRECT_CASH,
      ReconciliationLineKey.OPEN_SESSIONS,
    ]);
    // Only the tips line and the open-session count are optional — a night
    // cannot be signed off without a drawer count, a Z-report and a session count.
    expect(sheet.toCheck.filter((line) => line.required).map((line) => line.key)).toEqual([
      ReconciliationLineKey.CASH,
      ReconciliationLineKey.CARD,
      ReconciliationLineKey.BOOKINGS,
    ]);
  });

  it('warns about a session still in a room, and says why it matters', async () => {
    const { service } = setup(
      reportFixture({
        bookings: { ...reportFixture().bookings, inProgress: 1, needingCheckout: 1 },
      }),
      detailFixture({
        openSessions: [
          {
            reservationId: '0192aaaa-0000-7000-8000-00000000000a',
            ref: 'BR-2026-0042',
            therapist: 'Maya',
            room: 'Suite 1',
            startsAt: '2026-09-16T21:00:00.000Z',
            blockedUntil: '2026-09-16T22:15:00.000Z',
            actualArrivalAt: '2026-09-16T21:02:00.000Z',
            baseCostFils: 25_000,
            overdue: true,
          },
        ],
      }),
    );

    const sheet = await service.sheet('2026-09-16', manager());

    expect(sheet.openSessions).toHaveLength(1);
    expect(sheet.openSessions[0]?.ref).toBe('BR-2026-0042');
    expect(sheet.warnings.join(' ')).toMatch(/1 session is still open/);
    expect(sheet.warnings.join(' ')).toMatch(/tips have not been recorded/);
  });

  it('says so when the night is empty, and points at the night before', async () => {
    const empty = reportFixture({
      bookings: {
        total: 0,
        scheduled: 0,
        inProgress: 0,
        completed: 0,
        cancelled: 0,
        noShow: 0,
        needingCheckout: 0,
      },
      guestsSeen: 0,
      therapists: { worked: 0, rostered: 0 },
    });
    const { service } = setup(empty, detailFixture({ byTherapist: [], cashDesk: [] }));

    const sheet = await service.sheet('2026-09-16', manager());

    // Nothing recorded is a finding, not a quiet zero. Anything after midnight
    // belongs to the night it started on (§3.3), which is where to look first.
    expect(sheet.warnings.join(' ')).toMatch(/Nothing at all is recorded/);
    expect(sheet.warnings.join(' ')).toMatch(/night before/);
  });

  it('warns when there are bookings but nobody was rostered', async () => {
    const { service } = setup(reportFixture({ therapists: { worked: 6, rostered: 0 } }));

    const sheet = await service.sheet('2026-09-16', manager());

    expect(sheet.warnings.join(' ')).toMatch(/Nobody was rostered/);
  });

  it('says nothing when there is nothing to say', async () => {
    const { service } = setup();

    expect((await service.sheet('2026-09-16', manager())).warnings).toEqual([]);
  });

  it('names who took cash at the desk, so a variance belongs to somebody', async () => {
    const { service } = setup();

    const sheet = await service.sheet('2026-09-16', manager());

    expect(sheet.cashDesk).toEqual([
      expect.objectContaining({ fullName: 'Reception', amountFils: 184_000 }),
    ]);
  });
});

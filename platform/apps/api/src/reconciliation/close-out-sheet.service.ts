import { Injectable } from '@nestjs/common';
import { businessDay } from '@berelax/contracts';
import type { AuthUser } from '../common/request-context';
import {
  DailyReportService,
  type CashDeskLine,
  type CashDrawerView,
  type CardTerminalView,
  type DailyBookingsView,
  type DailyReportView,
  type DailyTipsView,
  type OpenSessionLine,
  type TherapistNightLine,
} from '../reports/daily-report.service';
import { LineUnit, ReconciliationLineKey, type SystemNightFigures } from './reconciliation.support';

/**
 * The sheet reception prints and ticks off at 02:00.
 *
 * It is the close-out report, rearranged around one job: letting somebody
 * holding a paper sheet find, without interpreting anything, where the two
 * disagree. So every figure on it is one the paper also has — a count of
 * sessions, the notes in the drawer, the terminal total, the tips — and every
 * one of them arrives from `DailyReportService`. Nothing is recomputed here.
 * Two implementations of "what the spa took last night" is how a reconciliation
 * tool becomes the thing that needs reconciling.
 *
 * What this service DOES add is arrangement and plain language: which figures
 * are compared and which are context, what to write next to each one, and what
 * about tonight would make a comparison meaningless if it were ignored.
 */
@Injectable()
export class CloseOutSheetService {
  constructor(private readonly dailyReport: DailyReportService) {}

  async sheet(day: string, actor: AuthUser): Promise<CloseOutSheetView> {
    // Two reads, deliberately in this order: the figures that get COMPARED all
    // come from `daily()`'s single REPEATABLE READ snapshot, and the detail is
    // context for chasing down a difference. See `closeOutDetail`.
    const report = await this.dailyReport.daily({ businessDay: day }, actor);
    const detail = await this.dailyReport.closeOutDetail({ businessDay: day }, actor);

    return {
      businessDay: report.businessDay,
      generatedAt: report.generatedAt,
      isTonight: report.businessDay === businessDay(new Date()),
      bookings: report.bookings,
      guestsSeen: report.guestsSeen,
      therapists: report.therapists,
      byTherapist: detail.byTherapist,
      cash: report.cashDrawer,
      card: report.cardTerminal,
      tips: report.tips,
      openSessions: detail.openSessions,
      cashDesk: detail.cashDesk,
      toCheck: checklistFor(report),
      warnings: warningsFor(report, detail.openSessions),
    };
  }
}

/* ───────────────────────── the view ───────────────────────── */

/**
 * One row of the tick-list, and the contract between this sheet and the form
 * beside it: the form has exactly these fields, in exactly this order.
 */
export interface CloseOutCheckLine {
  key: ReconciliationLineKey;
  label: string;
  unit: LineUnit;
  /** What the system says. What the paper must be checked against — not copied from. */
  systemFigure: number;
  /** Whether a figure is required to sign the night off. */
  required: boolean;
  /** Where the paper figure comes from, in one sentence. */
  from: string;
}

export interface CloseOutSheetView {
  businessDay: string;
  generatedAt: string;
  /** True while the night is still running. A sheet for tonight is provisional. */
  isTonight: boolean;
  bookings: DailyBookingsView;
  guestsSeen: number;
  therapists: { worked: number; rostered: number };
  byTherapist: TherapistNightLine[];
  cash: CashDrawerView;
  card: CardTerminalView;
  tips: DailyTipsView;
  openSessions: OpenSessionLine[];
  cashDesk: CashDeskLine[];
  /** The four figures to take off the paper, and the fifth that must be zero. */
  toCheck: CloseOutCheckLine[];
  /** Anything about tonight that would make a comparison misleading. */
  warnings: string[];
}

/* ───────────────────────── assembly ───────────────────────── */

/**
 * The system side of every comparison, in one place, read off the daily report.
 *
 * Both the sheet and the submission go through this function, which is the
 * point of it: the figure printed on the tick-list at 02:00 and the figure the
 * verdict is decided against are the same read of the same field, not two
 * readings that happen to agree today.
 */
export function systemFiguresFrom(report: DailyReportView): SystemNightFigures {
  return {
    cashFils: report.cashDrawer.expectedCashFils,
    cardFils: report.cardTerminal.expectedCardFils,
    // Arrived and treated. A cancellation was never a session and a no-show
    // never happened, so neither is on reception's sheet as one.
    bookings: report.guestsSeen,
    tipsDirectCashFils: report.tips.directCash.totalFils,
    openSessions: report.bookings.inProgress,
  };
}

function checklistFor(report: DailyReportView): CloseOutCheckLine[] {
  const system = systemFiguresFrom(report);

  return [
    {
      key: ReconciliationLineKey.CASH,
      label: 'Cash in the drawer',
      unit: LineUnit.FILS,
      systemFigure: system.cashFils,
      required: true,
      from: 'Count the notes and coins in the till. Count them before you read this sheet.',
    },
    {
      key: ReconciliationLineKey.CARD,
      label: 'Card terminal total',
      unit: LineUnit.FILS,
      systemFigure: system.cardFils,
      required: true,
      from: 'The Z-report total on the terminal printout. Staple the slip to the sheet.',
    },
    {
      key: ReconciliationLineKey.BOOKINGS,
      label: 'Sessions that took place',
      unit: LineUnit.COUNT,
      systemFigure: system.bookings,
      required: true,
      from: 'Count the treatments written on the paper sheet. Not cancellations, not no-shows.',
    },
    {
      key: ReconciliationLineKey.TIPS_DIRECT_CASH,
      label: 'Cash tips handed to therapists',
      unit: LineUnit.FILS,
      systemFigure: system.tipsDirectCashFils,
      required: false,
      from:
        'Tips the guest put straight into a therapist’s hand, if the paper records them. ' +
        'This money never went through the till, so it is not part of the drawer count.',
    },
    {
      key: ReconciliationLineKey.OPEN_SESSIONS,
      label: 'Sessions left open',
      unit: LineUnit.COUNT,
      systemFigure: system.openSessions,
      required: false,
      from: 'Nothing to write. This must be zero before the night can be signed off.',
    },
  ];
}

/**
 * What would make tonight's comparison misleading, said out loud on the sheet.
 *
 * Every one of these is a reason a variance might not mean what it looks like,
 * and a manager who reads them first spends the next twenty minutes looking in
 * the right place. A sheet that stays silent about an open session sends
 * somebody to recount a drawer that was never wrong.
 */
function warningsFor(report: DailyReportView, openSessions: OpenSessionLine[]): string[] {
  const warnings: string[] = [];

  if (openSessions.length > 0) {
    const overdue = openSessions.filter((session) => session.overdue).length;
    warnings.push(
      `${openSessions.length} session${openSessions.length === 1 ? ' is' : 's are'} still open` +
        (overdue > 0 ? ` (${overdue} of them long past the room being released)` : '') +
        '. Their tips have not been recorded, so tonight’s tip and card figures are still ' +
        'moving. Check them out on the grid before reconciling.',
    );
  }

  if (report.therapists.rostered === 0 && report.bookings.total > 0) {
    warnings.push(
      'Nobody was rostered on this trading night, but there are bookings against it. Either ' +
        'the shifts were never entered or these bookings are filed to the wrong night.',
    );
  }

  if (report.bookings.total === 0) {
    warnings.push(
      'Nothing at all is recorded against this trading night. If the spa was open, the ' +
        'bookings are on another day — check the night before: anything after midnight ' +
        'belongs to the night it started on.',
    );
  }

  return warnings;
}

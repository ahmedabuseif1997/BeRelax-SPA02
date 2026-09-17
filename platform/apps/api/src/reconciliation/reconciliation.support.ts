import { UnprocessableEntityException } from '@nestjs/common';
import {
  ErrorCode,
  RECONCILIATION_STREAK_REQUIRED,
  ReconciliationVerdict,
  type SubmitReconciliationDto,
} from '@berelax/contracts';
import { apiError, shiftTradingDay } from '../payments/money.support';

/**
 * The arithmetic of the parallel pilot, with nothing injected into it.
 *
 * Every decision Phase 7 rests on is made by a pure function in this file —
 * whether a line agrees, what the night's verdict is, and how many consecutive
 * nights have matched — so that each one can be argued with in a unit test
 * rather than through a database. The service above does the reading, the
 * writing and the auditing; it makes no judgements of its own.
 *
 * Nothing here computes a figure. The system side of every comparison arrives
 * already computed by `DailyReportService` (§14's instruction to run the pilot
 * against the close-out the business actually uses), and a second way to total
 * a night's cash is the one thing a reconciliation tool must never grow.
 */

/* ───────────────────────── the lines ───────────────────────── */

/** Which of the night's figures a line compares. Stable — it is stored in the row. */
export const ReconciliationLineKey = {
  CASH: 'CASH',
  CARD: 'CARD',
  BOOKINGS: 'BOOKINGS',
  TIPS_DIRECT_CASH: 'TIPS_DIRECT_CASH',
  OPEN_SESSIONS: 'OPEN_SESSIONS',
} as const;
export type ReconciliationLineKey =
  (typeof ReconciliationLineKey)[keyof typeof ReconciliationLineKey];

/** Money lines carry fils; counting lines carry a count. Never both. */
export const LineUnit = { FILS: 'FILS', COUNT: 'COUNT' } as const;
export type LineUnit = (typeof LineUnit)[keyof typeof LineUnit];

export interface ReconciliationLine {
  key: ReconciliationLineKey;
  label: string;
  unit: LineUnit;
  /** What the system says. Always present — zero is a real answer here. */
  system: number;
  /** What the paper says. `null` only when the figure was not submitted. */
  paper: number | null;
  /** Paper minus system. Positive means the paper is higher. `null` if not submitted. */
  difference: number | null;
  /** How far this line may be out before it counts as a disagreement. */
  toleranceFils: number;
  /** False only when a figure was submitted AND it is outside tolerance. */
  withinTolerance: boolean;
  /** Whether this line was actually compared, or skipped because it was optional. */
  compared: boolean;
  /** One sentence a manager can act on, printed under the line. */
  basis: string;
}

/* ───────────────────────── the input ───────────────────────── */

/**
 * The system side of the comparison, every figure of it sourced from
 * `DailyReportService`. This interface exists so the pure functions below can
 * be tested without a report service, NOT so a second one can be substituted.
 */
export interface SystemNightFigures {
  /** `daily().cashDrawer.expectedCashFils` — what should be in the drawer. */
  cashFils: number;
  /** `daily().cardTerminal.expectedCardFils` — net, to check the Z-report against. */
  cardFils: number;
  /** `daily().guestsSeen` — arrived and treated. Not cancellations, not no-shows. */
  bookings: number;
  /** `daily().tips.directCash.totalFils` — handed over, never through the till. */
  tipsDirectCashFils: number;
  /** `daily().bookings.inProgress` — still in a room when the night was closed. */
  openSessions: number;
}

export interface ComparisonInput {
  system: SystemNightFigures;
  paper: SubmitReconciliationDto;
  /** How far the counted cash may be out. Zero unless deliberately configured. */
  cashToleranceFils: number;
}

export interface ComparisonResult {
  verdict: ReconciliationVerdict;
  lines: ReconciliationLine[];
  /** Every line that disagreed. Empty on a match — this is the finding list. */
  failing: ReconciliationLine[];
}

/* ───────────────────────── the comparison ───────────────────────── */

/**
 * Why the card line's tolerance is nailed to zero.
 *
 * The terminal's Z-report is not somebody's recollection of the evening: it is
 * the bank's own total, printed by a machine nobody at the desk can edit. There
 * is no counting error to forgive, so a card difference of a single fil is a
 * real transaction filed to the wrong night, typed with a wrong amount, or
 * missing — each of which is exactly what the pilot is looking for. §15.4
 * extends trust to CASH because cash is counted by hand; it does not extend it
 * here.
 */
const CARD_TOLERANCE_FILS = 0;

/** A booking is a whole booking. There is no half-session to round away. */
const COUNT_TOLERANCE = 0;

export function compareNight(input: ComparisonInput): ComparisonResult {
  const { system, paper, cashToleranceFils } = input;

  const lines: ReconciliationLine[] = [
    line({
      key: ReconciliationLineKey.CASH,
      label: 'Cash in the drawer',
      unit: LineUnit.FILS,
      system: system.cashFils,
      paper: paper.countedCashFils,
      toleranceFils: cashToleranceFils,
      basis:
        'Counted notes against every CASH payment filed to this trading night, refunds already ' +
        'deducted. A tip handed straight to a therapist is NOT in this figure — it never entered ' +
        'the till.',
    }),
    line({
      key: ReconciliationLineKey.CARD,
      label: 'Card terminal total',
      unit: LineUnit.FILS,
      system: system.cardFils,
      paper: paper.paperCardTotalFils,
      toleranceFils: CARD_TOLERANCE_FILS,
      basis:
        'The terminal Z-report against every CARD payment filed to this night, net of anything ' +
        'refunded on the terminal. This line must agree to the fil: the bank printed it, so ' +
        'there is no counting error to forgive.',
    }),
    line({
      key: ReconciliationLineKey.BOOKINGS,
      label: 'Sessions that took place',
      unit: LineUnit.COUNT,
      system: system.bookings,
      paper: paper.paperBookings,
      toleranceFils: COUNT_TOLERANCE,
      basis:
        'Guests who arrived and were treated — completed, plus anyone still in a room. Do not ' +
        'count cancellations or no-shows on the paper sheet; they are listed separately below.',
    }),
    line({
      key: ReconciliationLineKey.TIPS_DIRECT_CASH,
      label: 'Cash tips handed to therapists',
      unit: LineUnit.FILS,
      system: system.tipsDirectCashFils,
      // Optional on purpose: not every sheet records it, and a figure nobody
      // wrote down must not be compared against zero and called a mismatch.
      paper: paper.paperTipsCashFils ?? null,
      toleranceFils: cashToleranceFils,
      basis:
        'Tips the guest put straight into the therapist’s hand. This money never entered the ' +
        'till and BE RELAX never owed it (§9.2), so it is NOT part of the drawer figure above. ' +
        'A gap here usually means a tip was recorded in the wrong mode — which is how a spa ends ' +
        'up paying the same tip twice.',
    }),
    line({
      key: ReconciliationLineKey.OPEN_SESSIONS,
      label: 'Sessions left open',
      unit: LineUnit.COUNT,
      system: system.openSessions,
      // Not a paper figure at all: the expectation is zero, because a closed
      // night has nobody still in a room.
      paper: 0,
      toleranceFils: COUNT_TOLERANCE,
      basis:
        'A treatment still in progress has not been checked out, so its tip has not been ' +
        'recorded and tonight’s figures are still moving. Close it on the grid and reconcile ' +
        'again — a night signed off while it is still changing certifies nothing.',
    }),
  ];

  const failing = lines.filter((entry) => entry.compared && !entry.withinTolerance);

  return { verdict: verdictFor(failing.length === 0, paper.note), lines, failing };
}

/**
 * MATCHED_WITH_NOTE is a MATCH with an explanation attached, not a hedge.
 *
 * A note is how "one walk-in paid half cash half card" survives to the morning,
 * and the numbers still agreed when it was written. What a note can never do is
 * rescue a night whose figures disagree: if a line is out, the verdict is
 * MISMATCHED however good the explanation, because the streak counts nights
 * where the numbers matched — not nights where somebody had a reason.
 */
function verdictFor(matched: boolean, note: string | undefined): ReconciliationVerdict {
  if (!matched) return ReconciliationVerdict.MISMATCHED;
  return note ? ReconciliationVerdict.MATCHED_WITH_NOTE : ReconciliationVerdict.MATCHED;
}

function line(
  spec: Omit<ReconciliationLine, 'difference' | 'withinTolerance' | 'compared'>,
): ReconciliationLine {
  const { paper } = spec;
  const compared = paper !== null;
  const difference = paper === null ? null : paper - spec.system;

  return {
    ...spec,
    compared,
    difference,
    // An uncompared line is never a failure. It is a question nobody asked.
    withinTolerance: difference === null || Math.abs(difference) <= spec.toleranceFils,
  };
}

/** A verdict that counts towards the five. §14. */
export function isMatch(verdict: ReconciliationVerdict): boolean {
  return verdict !== ReconciliationVerdict.MISMATCHED;
}

/* ───────────────────────── the streak ───────────────────────── */

/** One night's effective result: its MOST RECENT submission, corrections included. */
export interface NightVerdict {
  businessDay: string;
  verdict: ReconciliationVerdict;
}

/** Why the run of matched nights stopped where it did. */
export const StreakBreakReason = {
  /** That night was reconciled and the figures disagreed. */
  MISMATCHED: 'MISMATCHED',
  /** That night was never reconciled at all, so nobody can say it matched. */
  NOT_RECONCILED: 'NOT_RECONCILED',
  /** Nothing before it: the pilot has not been running any longer than this. */
  NO_EARLIER_NIGHTS: 'NO_EARLIER_NIGHTS',
} as const;
export type StreakBreakReason = (typeof StreakBreakReason)[keyof typeof StreakBreakReason];

export interface StreakView {
  /** How many consecutive trading nights have matched, counting back. */
  consecutiveMatchedNights: number;
  /** Five, from §14. */
  requiredNights: number;
  /** The one question the pilot asks. */
  readyToSwitch: boolean;
  /** The trading nights in the run, newest first. */
  nights: NightVerdict[];
  /** The most recent night with any reconciliation at all. */
  lastReconciledNight: string | null;
  /** Where the run stops, and why. `null` when nothing has been reconciled yet. */
  brokenBy: { businessDay: string; reason: StreakBreakReason } | null;
  /**
   * Finished trading nights after `lastReconciledNight` that nobody has
   * reconciled. Tonight is not in here — it is not over yet.
   */
  unreconciledNights: string[];
  /** The trading night the streak was counted as of. */
  asOf: string;
}

/**
 * Count back from the most recent reconciled night, one trading night at a time.
 *
 * A GAP BREAKS THE RUN, and that is the load-bearing decision in this function.
 * "Five consecutive nights" cannot mean five matches scattered across a
 * fortnight: the nights that were skipped are precisely the busy ones, and a
 * pilot that lets them be skipped measures the quiet nights and calls it
 * evidence. So a night with no reconciliation ends the count exactly as a
 * mismatch does — the difference is only in what the manager is told to do
 * about it.
 *
 * The count is taken as of the last night ANYBODY reconciled, not as of
 * tonight, so a manager reading this at 18:00 does not see yesterday's four
 * become zero because today's sheet has not been filled in yet. Nights that are
 * over and still unreconciled are reported separately, by name.
 */
export function computeStreak(
  nights: NightVerdict[],
  currentTradingDay: string,
  requiredNights: number = RECONCILIATION_STREAK_REQUIRED,
): StreakView {
  const byDay = new Map(nights.map((night) => [night.businessDay, night]));
  const reconciledDays = [...byDay.keys()].sort();
  const lastReconciledNight = reconciledDays.at(-1) ?? null;

  if (lastReconciledNight === null) {
    return {
      consecutiveMatchedNights: 0,
      requiredNights,
      readyToSwitch: false,
      nights: [],
      lastReconciledNight: null,
      brokenBy: null,
      unreconciledNights: [],
      asOf: currentTradingDay,
    };
  }

  const earliestReconciledNight = reconciledDays[0];
  const run: NightVerdict[] = [];
  let cursor = lastReconciledNight;
  let brokenBy: StreakView['brokenBy'] = null;

  for (;;) {
    const night = byDay.get(cursor);
    if (!night) {
      brokenBy = { businessDay: cursor, reason: StreakBreakReason.NOT_RECONCILED };
      break;
    }
    if (!isMatch(night.verdict)) {
      brokenBy = { businessDay: cursor, reason: StreakBreakReason.MISMATCHED };
      break;
    }
    run.push(night);
    const previous = shiftTradingDay(cursor, -1);
    // Run out of history rather than off the end of it: the pilot started
    // somewhere, and the night before it began is not a night that failed.
    if (previous < earliestReconciledNight) {
      brokenBy = { businessDay: previous, reason: StreakBreakReason.NO_EARLIER_NIGHTS };
      break;
    }
    cursor = previous;
  }

  return {
    consecutiveMatchedNights: run.length,
    requiredNights,
    readyToSwitch: run.length >= requiredNights,
    nights: run,
    lastReconciledNight,
    brokenBy,
    unreconciledNights: finishedNightsBetween(lastReconciledNight, currentTradingDay, byDay),
    asOf: currentTradingDay,
  };
}

/**
 * Trading nights that are OVER, later than the last one reconciled, and still
 * missing a sheet. Tonight is excluded: it has not finished, so nobody owes a
 * reconciliation for it yet.
 */
function finishedNightsBetween(
  lastReconciled: string,
  currentTradingDay: string,
  byDay: Map<string, NightVerdict>,
): string[] {
  const missing: string[] = [];
  for (
    let day = shiftTradingDay(lastReconciled, 1);
    day < currentTradingDay;
    day = shiftTradingDay(day, 1)
  ) {
    if (!byDay.has(day)) missing.push(day);
    // A pilot is two weeks; a window wider than a quarter is a dormant
    // deployment, not a gap somebody is going to fill in.
    if (missing.length >= 92) break;
  }
  return missing;
}

/* ───────────────────────── refusals ───────────────────────── */

/**
 * The single thing this endpoint will not do.
 *
 * Everything else it is handed, it records: a variance is a finding, and a tool
 * that refuses the findings it dislikes is a tool that makes the pilot pass on
 * optimism (§15.4). But a trading night that has not happened has no figures at
 * all, and comparing a paper sheet against five structural zeros would enter a
 * mismatch caused entirely by the calendar — and reset a real streak with it.
 */
export function assertNightHasHappened(day: string, currentTradingDay: string): void {
  if (day <= currentTradingDay) return;

  throw new UnprocessableEntityException(
    apiError(
      ErrorCode.RECONCILIATION_DAY_IN_FUTURE,
      `${day} has not happened yet. Tonight is ${currentTradingDay}; reconcile a night once it is over.`,
      { businessDay: day, currentTradingDay },
    ),
  );
}

import { UnprocessableEntityException } from '@nestjs/common';
import { ErrorCode, ReconciliationVerdict, type SubmitReconciliationDto } from '@berelax/contracts';
import {
  ReconciliationLineKey,
  StreakBreakReason,
  assertNightHasHappened,
  compareNight,
  computeStreak,
  isMatch,
  type NightVerdict,
  type SystemNightFigures,
} from './reconciliation.support';

/**
 * The arithmetic the switchover decision rests on, with nothing else in the
 * room. Four claims matter more than the rest:
 *
 *  1. the CARD line is exact and stays exact whatever the cash tolerance is —
 *     the terminal's Z-report is printed by the bank, not remembered by a person;
 *  2. a tolerance FORGIVES a variance without hiding it: the difference is still
 *     on the line, and the tolerance in force is still on the row;
 *  3. MATCHED_WITH_NOTE is a match and counts towards the five, but a note can
 *     never rescue a night whose figures disagree;
 *  4. a night nobody reconciled BREAKS the streak exactly as a mismatch does.
 *     Five scattered matches across a fortnight are not five consecutive nights,
 *     and the nights that get skipped are the busy ones.
 */

/** A night where nothing is out: 1,840 in the drawer, 4,120 on the terminal, 23 sessions. */
const A_NIGHT: SystemNightFigures = {
  cashFils: 184_000,
  cardFils: 412_000,
  bookings: 23,
  tipsDirectCashFils: 30_000,
  openSessions: 0,
};

function paper(overrides: Partial<SubmitReconciliationDto> = {}): SubmitReconciliationDto {
  return {
    countedCashFils: 184_000,
    paperBookings: 23,
    paperCardTotalFils: 412_000,
    ...overrides,
  };
}

function compare(
  system: Partial<SystemNightFigures> = {},
  sheet: Partial<SubmitReconciliationDto> = {},
  cashToleranceFils = 0,
) {
  return compareNight({
    system: { ...A_NIGHT, ...system },
    paper: paper(sheet),
    cashToleranceFils,
  });
}

function lineFor(result: ReturnType<typeof compare>, key: ReconciliationLineKey) {
  const found = result.lines.find((line) => line.key === key);
  if (!found) throw new Error(`no ${key} line`);
  return found;
}

describe('compareNight — the verdict', () => {
  it('matches when every submitted figure agrees', () => {
    const result = compare();

    expect(result.verdict).toBe(ReconciliationVerdict.MATCHED);
    expect(result.failing).toEqual([]);
    expect(result.lines.every((line) => line.withinTolerance)).toBe(true);
  });

  it('is MATCHED_WITH_NOTE when the figures agree and a note explains the night', () => {
    const result = compare({}, { note: 'one walk-in paid half cash half card' });

    expect(result.verdict).toBe(ReconciliationVerdict.MATCHED_WITH_NOTE);
    expect(result.failing).toEqual([]);
    // Both verdicts count towards the five. §14 asks whether the NUMBERS
    // matched, and they did.
    expect(isMatch(result.verdict)).toBe(true);
  });

  it('is MISMATCHED however good the explanation, once a line is out', () => {
    const result = compare({}, { countedCashFils: 183_500, note: 'a fifty went missing, looking' });

    expect(result.verdict).toBe(ReconciliationVerdict.MISMATCHED);
    expect(isMatch(result.verdict)).toBe(false);
    expect(result.failing.map((line) => line.key)).toEqual([ReconciliationLineKey.CASH]);
  });

  it('reports the difference signed: paper minus system', () => {
    const short = lineFor(compare({}, { countedCashFils: 183_500 }), ReconciliationLineKey.CASH);
    const over = lineFor(compare({}, { countedCashFils: 184_500 }), ReconciliationLineKey.CASH);

    // Short in the drawer reads negative, over reads positive. A manager
    // holding notes needs to know which way to look, not just how far.
    expect(short.difference).toBe(-500);
    expect(over.difference).toBe(500);
  });
});

describe('compareNight — tolerance', () => {
  it('forgives a cash variance inside the configured tolerance without hiding it', () => {
    const result = compare({}, { countedCashFils: 183_800 }, 500);
    const cash = lineFor(result, ReconciliationLineKey.CASH);

    expect(result.verdict).toBe(ReconciliationVerdict.MATCHED);
    expect(cash.withinTolerance).toBe(true);
    // Forgiven, not erased. The variance is still on the line and the tolerance
    // that forgave it is still beside it. §15.4 records variances; it does not
    // suppress them.
    expect(cash.difference).toBe(-200);
    expect(cash.toleranceFils).toBe(500);
  });

  it('refuses a cash variance one fil outside the tolerance', () => {
    const result = compare({}, { countedCashFils: 183_499 }, 500);

    expect(result.verdict).toBe(ReconciliationVerdict.MISMATCHED);
    expect(lineFor(result, ReconciliationLineKey.CASH).withinTolerance).toBe(false);
  });

  it('defaults to zero: a single fil out of the drawer is a mismatch', () => {
    const result = compare({}, { countedCashFils: 183_999 });

    expect(result.verdict).toBe(ReconciliationVerdict.MISMATCHED);
  });

  it('keeps the card line exact however wide the cash tolerance is opened', () => {
    const result = compare({}, { paperCardTotalFils: 412_001 }, 100_000);
    const card = lineFor(result, ReconciliationLineKey.CARD);

    expect(card.toleranceFils).toBe(0);
    expect(card.withinTolerance).toBe(false);
    expect(result.verdict).toBe(ReconciliationVerdict.MISMATCHED);
  });

  it('counts sessions exactly — there is no half a booking to round away', () => {
    const result = compare({}, { paperBookings: 24 }, 100_000);

    expect(lineFor(result, ReconciliationLineKey.BOOKINGS).difference).toBe(1);
    expect(result.verdict).toBe(ReconciliationVerdict.MISMATCHED);
  });
});

describe('compareNight — the optional tips line', () => {
  it('does not compare a figure nobody wrote down', () => {
    const tips = lineFor(compare(), ReconciliationLineKey.TIPS_DIRECT_CASH);

    // Absent, not zero. Comparing a missing figure against a real one and
    // calling the gap a mismatch would make reception stop filling the sheet in.
    expect(tips.compared).toBe(false);
    expect(tips.paper).toBeNull();
    expect(tips.difference).toBeNull();
    expect(tips.withinTolerance).toBe(true);
  });

  it('compares it when it is supplied, against the DIRECT_CASH total', () => {
    const matched = compare({}, { paperTipsCashFils: 30_000 });
    const out = compare({}, { paperTipsCashFils: 27_000 });

    expect(matched.verdict).toBe(ReconciliationVerdict.MATCHED);
    expect(lineFor(out, ReconciliationLineKey.TIPS_DIRECT_CASH).difference).toBe(-3_000);
    expect(out.verdict).toBe(ReconciliationVerdict.MISMATCHED);
  });

  it('holds the tips line to the cash tolerance, not to the card line', () => {
    const result = compare({}, { paperTipsCashFils: 29_800 }, 500);

    expect(lineFor(result, ReconciliationLineKey.TIPS_DIRECT_CASH).withinTolerance).toBe(true);
    expect(result.verdict).toBe(ReconciliationVerdict.MATCHED);
  });

  it('keeps direct cash OUT of the drawer figure — the two lines are independent', () => {
    // A tip handed straight over never entered the till (§9.1), so a night with
    // a big direct-cash total and an exactly-counted drawer still matches.
    const result = compare({ tipsDirectCashFils: 500_000 }, { paperTipsCashFils: 500_000 });

    expect(result.verdict).toBe(ReconciliationVerdict.MATCHED);
    expect(lineFor(result, ReconciliationLineKey.CASH).difference).toBe(0);
  });
});

describe('compareNight — a night that is still moving', () => {
  it('will not certify a night with a session still in a room', () => {
    const result = compare({ openSessions: 1 });
    const open = lineFor(result, ReconciliationLineKey.OPEN_SESSIONS);

    // Every money line agrees. It is still MISMATCHED, because an unchecked-out
    // treatment is a tip nobody has recorded — the figures are not final yet.
    expect(result.lines.filter((line) => !line.withinTolerance)).toEqual([open]);
    expect(result.verdict).toBe(ReconciliationVerdict.MISMATCHED);
    expect(open.difference).toBe(-1);
  });

  it('matches once the session has been closed', () => {
    expect(compare({ openSessions: 0 }).verdict).toBe(ReconciliationVerdict.MATCHED);
  });
});

describe('computeStreak', () => {
  const matched = (day: string): NightVerdict => ({
    businessDay: day,
    verdict: ReconciliationVerdict.MATCHED,
  });
  const withNote = (day: string): NightVerdict => ({
    businessDay: day,
    verdict: ReconciliationVerdict.MATCHED_WITH_NOTE,
  });
  const failed = (day: string): NightVerdict => ({
    businessDay: day,
    verdict: ReconciliationVerdict.MISMATCHED,
  });

  it('is zero, and not ready, before anything has been reconciled', () => {
    const streak = computeStreak([], '2026-09-16');

    expect(streak.consecutiveMatchedNights).toBe(0);
    expect(streak.readyToSwitch).toBe(false);
    expect(streak.lastReconciledNight).toBeNull();
    expect(streak.brokenBy).toBeNull();
  });

  it('counts five consecutive matched nights and says so', () => {
    const nights = ['09-12', '09-13', '09-14', '09-15', '09-16'].map((d) => matched(`2026-${d}`));

    const streak = computeStreak(nights, '2026-09-16');

    expect(streak.consecutiveMatchedNights).toBe(5);
    expect(streak.requiredNights).toBe(5);
    expect(streak.readyToSwitch).toBe(true);
    expect(streak.nights[0]?.businessDay).toBe('2026-09-16');
    expect(streak.brokenBy?.reason).toBe(StreakBreakReason.NO_EARLIER_NIGHTS);
  });

  it('counts a night that matched with a note', () => {
    const streak = computeStreak(
      [matched('2026-09-15'), withNote('2026-09-16')],
      '2026-09-16',
    );

    expect(streak.consecutiveMatchedNights).toBe(2);
  });

  it('resets on a mismatch — four nights of work, and the fifth is a one', () => {
    const nights = [
      matched('2026-09-12'),
      matched('2026-09-13'),
      matched('2026-09-14'),
      failed('2026-09-15'),
      matched('2026-09-16'),
    ];

    const streak = computeStreak(nights, '2026-09-16');

    expect(streak.consecutiveMatchedNights).toBe(1);
    expect(streak.readyToSwitch).toBe(false);
    expect(streak.brokenBy).toEqual({
      businessDay: '2026-09-15',
      reason: StreakBreakReason.MISMATCHED,
    });
  });

  it('breaks on a night nobody reconciled, exactly as on a mismatch', () => {
    // 09-14 is missing. Five matches, four consecutive nights — and the run
    // stops at the gap, because nobody can say the 14th matched.
    const nights = [
      matched('2026-09-11'),
      matched('2026-09-12'),
      matched('2026-09-13'),
      matched('2026-09-15'),
      matched('2026-09-16'),
    ];

    const streak = computeStreak(nights, '2026-09-16');

    expect(streak.consecutiveMatchedNights).toBe(2);
    expect(streak.readyToSwitch).toBe(false);
    expect(streak.brokenBy).toEqual({
      businessDay: '2026-09-14',
      reason: StreakBreakReason.NOT_RECONCILED,
    });
  });

  it('counts as of the last night reconciled, not as of tonight', () => {
    const nights = ['09-12', '09-13', '09-14', '09-15', '09-16'].map((d) => matched(`2026-${d}`));

    // Read on the 18th: the 17th is over and nobody has reconciled it. The
    // five nights that DID match still matched, so the count stands — and the
    // night that is owed is named rather than silently folded into the run.
    const streak = computeStreak(nights, '2026-09-18');

    expect(streak.consecutiveMatchedNights).toBe(5);
    expect(streak.lastReconciledNight).toBe('2026-09-16');
    expect(streak.unreconciledNights).toEqual(['2026-09-17']);
    expect(streak.asOf).toBe('2026-09-18');
  });

  it('does not ask for tonight — the night is not over yet', () => {
    const streak = computeStreak([matched('2026-09-16')], '2026-09-17');

    expect(streak.unreconciledNights).toEqual([]);
  });

  it('counts across a month boundary rather than resetting at the 1st', () => {
    const nights = [
      matched('2026-08-30'),
      matched('2026-08-31'),
      matched('2026-09-01'),
      matched('2026-09-02'),
      matched('2026-09-03'),
    ];

    expect(computeStreak(nights, '2026-09-03').consecutiveMatchedNights).toBe(5);
  });
});

describe('assertNightHasHappened', () => {
  it('allows tonight and every night before it', () => {
    expect(() => assertNightHasHappened('2026-09-16', '2026-09-16')).not.toThrow();
    expect(() => assertNightHasHappened('2026-09-01', '2026-09-16')).not.toThrow();
  });

  it('refuses a night that has not happened, with the day in the details', () => {
    try {
      assertNightHasHappened('2026-09-17', '2026-09-16');
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      const body = (error as UnprocessableEntityException).getResponse() as {
        error: { code: string; details?: Record<string, unknown> };
      };
      expect(body.error.code).toBe(ErrorCode.RECONCILIATION_DAY_IN_FUTURE);
      expect(body.error.details).toEqual({
        businessDay: '2026-09-17',
        currentTradingDay: '2026-09-16',
      });
    }
  });
});

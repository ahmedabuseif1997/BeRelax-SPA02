/**
 * The business day, pinned against literal dates. Spec §3.3.
 *
 * The spa opens at 11:00 and closes at 02:00 the following morning, so a
 * reservation at 01:30 on Tuesday is MONDAY's takings, Monday's revenue report
 * and Monday's therapist shift. Getting this wrong does not throw — it quietly
 * mis-files a few bookings every single night, and the first symptom is a
 * manager who no longer trusts the numbers.
 *
 * There are two implementations of this rule: `businessDay()` in
 * `@berelax/contracts` and the SQL `business_day(timestamptz)` installed by
 * `00000000000000_init_extensions`. They MUST agree.
 *
 *   - This file pins the TypeScript side against expected literal dates, so it
 *     needs no database and runs in the ordinary unit suite.
 *   - `test/financial-invariants.e2e-spec.ts` runs the two side by side over
 *     every seeded reservation, which is where the SQL half is cross-checked.
 *
 * A literal expected date is the point. Re-deriving the expectation with the
 * same arithmetic the implementation uses would assert only that the code
 * agrees with itself.
 */

import {
  BUSINESS_DAY_CUTOFF_HOURS,
  OPERATING_TIMEZONE,
  businessDay,
  businessDayBounds,
} from '@berelax/contracts';

interface Case {
  /** An instant, written in Dubai wall-clock time. */
  at: string;
  /** The trading day it belongs to. */
  day: string;
  why: string;
}

const CASES: readonly Case[] = [
  // The three the SQL verification script asserts verbatim
  // (docs/sql/verify-core-constraints.sql), so the two files visibly agree.
  { at: '2026-09-16T01:30:00+04:00', day: '2026-09-15', why: '01:30 belongs to the previous trading day — the case §3.3 leads with' },
  { at: '2026-09-16T23:30:00+04:00', day: '2026-09-16', why: 'late evening is still the same trading day' },
  { at: '2026-09-16T11:00:00+04:00', day: '2026-09-16', why: 'opening time starts its own trading day' },

  // The cutover, from both sides.
  { at: '2026-09-16T05:59:00+04:00', day: '2026-09-15', why: 'one minute before the 06:00 cutover, deep inside the closed window' },
  { at: '2026-09-16T06:00:00+04:00', day: '2026-09-16', why: 'the cutover itself opens the new trading day' },
  { at: '2026-09-16T23:59:00+04:00', day: '2026-09-16', why: 'the last minute before midnight has not rolled over' },
  { at: '2026-09-17T02:00:00+04:00', day: '2026-09-16', why: 'closing time belongs to the day that opened it' },

  // Boundaries that a naive date_trunc gets wrong in a way nobody notices for months.
  { at: '2026-01-01T00:00:00+04:00', day: '2025-12-31', why: 'New Year takings before 06:00 belong to the old YEAR' },
  { at: '2027-03-01T03:45:00+04:00', day: '2027-02-28', why: 'month boundary, non-leap year' },
  { at: '2028-03-01T04:00:00+04:00', day: '2028-02-29', why: 'month boundary, leap year' },

  // A few ordinary instants with no boundary in sight.
  { at: '2026-07-04T13:20:00+04:00', day: '2026-07-04', why: 'quiet midday' },
  { at: '2026-11-19T19:05:00+04:00', day: '2026-11-19', why: 'busy evening' },
  { at: '2026-04-27T21:47:00+04:00', day: '2026-04-27', why: 'busy evening' },
  { at: '2026-02-14T00:10:00+04:00', day: '2026-02-13', why: 'ten past midnight is the night before' },
];

/** Deterministic PRNG: "a few random instants" that are the same random instants every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('businessDay()', () => {
  it.each(CASES)('$at is trading day $day — $why', ({ at, day }) => {
    expect(businessDay(at)).toBe(day);
  });

  it('accepts a Date and an ISO string interchangeably', () => {
    for (const { at, day } of CASES) {
      expect(businessDay(new Date(at))).toBe(day);
    }
  });

  it('depends on the instant, not on how the caller wrote it', () => {
    // 01:30+04:00 and 21:30Z the previous day are the SAME moment. The SQL
    // function converts AT TIME ZONE 'Asia/Dubai' from a literal, so it ignores
    // the session timezone; this must ignore the caller's formatting for the
    // same reason. Dubai never observes daylight saving, so a fixed +04:00 is
    // exact rather than merely convenient (§3.2).
    expect(businessDay('2026-09-15T21:30:00Z')).toBe('2026-09-15');
    expect(businessDay('2026-09-16T01:30:00+04:00')).toBe('2026-09-15');
    expect(businessDay('2026-09-15T23:30:00+02:00')).toBe('2026-09-15');
    expect(businessDay('2026-09-15T14:30:00-03:00')).toBe('2026-09-15');
  });

  it('disagrees with the calendar date exactly where a report would go wrong', () => {
    // This is the bug §3.3 warns about: grouping revenue by date_trunc('day', …)
    // instead of business_day(…). If these two ever stop differing, the cutover
    // has been lost and every late-night booking is being filed a day late.
    const lateNight = '2026-09-16T01:30:00+04:00';
    const calendarDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: OPERATING_TIMEZONE,
      dateStyle: 'short',
    }).format(new Date(lateNight));

    expect(calendarDate).toBe('2026-09-16');
    expect(businessDay(lateNight)).toBe('2026-09-15');
    expect(businessDay(lateNight)).not.toBe(calendarDate);
  });

  it('rejects an unparseable instant rather than inventing a day', () => {
    expect(() => businessDay('not a date')).toThrow(RangeError);
    expect(() => businessDay(new Date('nonsense'))).toThrow(RangeError);
  });
});

describe('the 06:00 cutover', () => {
  it('sits inside the 02:00–11:00 closed window, so it can never split a live session', () => {
    // The whole reason the constant is 6 and not, say, 0 or 12.
    expect(BUSINESS_DAY_CUTOFF_HOURS).toBe(6);
    expect(BUSINESS_DAY_CUTOFF_HOURS).toBeGreaterThan(2); // after closing
    expect(BUSINESS_DAY_CUTOFF_HOURS).toBeLessThan(11); // before opening
  });

  it('assigns every minute of one trading day to that day and no other', () => {
    // Walk 11:00 through 02:00 in five-minute steps: every one of them must file
    // under 2026-09-16, including the ninety minutes that fall after midnight.
    const open = new Date('2026-09-16T11:00:00+04:00').getTime();
    const close = new Date('2026-09-17T02:00:00+04:00').getTime();

    const misfiled: string[] = [];
    for (let t = open; t <= close; t += 5 * 60_000) {
      const day = businessDay(new Date(t));
      if (day !== '2026-09-16') misfiled.push(`${new Date(t).toISOString()} -> ${day}`);
    }
    expect(misfiled).toEqual([]);
  });
});

describe('businessDayBounds()', () => {
  it('brackets its own day and hands the next minute to the next day', () => {
    const { start, end } = businessDayBounds('2026-09-16');

    // 06:00 Dubai to 06:00 Dubai, expressed as the UTC instants a query wants.
    expect(start.toISOString()).toBe('2026-09-16T02:00:00.000Z');
    expect(end.toISOString()).toBe('2026-09-17T02:00:00.000Z');

    // Half-open, matching every `>= start AND < end` query that uses it.
    expect(businessDay(start)).toBe('2026-09-16');
    expect(businessDay(new Date(end.getTime() - 1))).toBe('2026-09-16');
    expect(businessDay(end)).toBe('2026-09-17');
  });

  it('round-trips every case in the table', () => {
    for (const { at, day } of CASES) {
      const { start, end } = businessDayBounds(day);
      const instant = new Date(at).getTime();
      expect(instant).toBeGreaterThanOrEqual(start.getTime());
      expect(instant).toBeLessThan(end.getTime());
    }
  });

  it('contains every one of 500 pseudo-random instants inside its own day', () => {
    // The property that makes the pair usable for reporting: whatever day a
    // moment is filed under, querying that day's bounds finds it again.
    const rng = mulberry32(0x5eed1a);
    const epoch = Date.parse('2026-01-01T00:00:00Z');
    const span = 3 * 365 * 24 * 60 * 60 * 1000;

    const escaped: string[] = [];
    for (let i = 0; i < 500; i++) {
      const instant = new Date(epoch + Math.floor(rng() * span));
      const { start, end } = businessDayBounds(businessDay(instant));
      if (instant < start || instant >= end) {
        escaped.push(`${instant.toISOString()} filed under ${businessDay(instant)}`);
      }
    }
    expect(escaped).toEqual([]);
  });

  it('rejects anything that is not a YYYY-MM-DD trading day', () => {
    expect(() => businessDayBounds('16/09/2026')).toThrow(RangeError);
    expect(() => businessDayBounds('2026-09-16T00:00:00Z')).toThrow(RangeError);
  });
});

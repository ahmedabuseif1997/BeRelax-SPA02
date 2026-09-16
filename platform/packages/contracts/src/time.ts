/**
 * The spa opens at 11:00 and closes at 02:00 the following morning, so a
 * reservation at 01:30 on Tuesday belongs to MONDAY's trading day, Monday's
 * revenue and Monday's shift.
 *
 * Every report and every shift grouping uses the business day, not the
 * calendar day. Grouping by calendar date is a reporting bug that will be
 * wrong every single night. Spec §3.3.
 *
 * This mirrors the SQL `business_day(timestamptz)` function exactly. The two
 * MUST agree; `business-day.spec.ts` asserts they do.
 */

export const OPERATING_TIMEZONE = 'Asia/Dubai';

/** Hours subtracted before taking the date. 6 sits inside the 02:00-11:00 closed window. */
export const BUSINESS_DAY_CUTOFF_HOURS = 6;

/** Dubai is UTC+4 year round -- no daylight saving, so a fixed offset is correct. */
const DUBAI_UTC_OFFSET_MINUTES = 4 * 60;

/**
 * The trading date a moment belongs to, as `YYYY-MM-DD`.
 *
 *   businessDay('2026-09-16T01:30:00+04:00') === '2026-09-15'   // still Monday night
 *   businessDay('2026-09-16T23:30:00+04:00') === '2026-09-16'
 *   businessDay('2026-09-16T11:00:00+04:00') === '2026-09-16'   // opening time
 */
export function businessDay(at: Date | string): string {
  const instant = typeof at === 'string' ? new Date(at) : at;
  if (Number.isNaN(instant.getTime())) throw new RangeError(`businessDay: invalid date "${String(at)}"`);

  const shifted = new Date(
    instant.getTime() +
      DUBAI_UTC_OFFSET_MINUTES * 60_000 -
      BUSINESS_DAY_CUTOFF_HOURS * 3_600_000,
  );
  return shifted.toISOString().slice(0, 10);
}

/** The UTC instants bounding a business day, for `>= start AND < end` queries. */
export function businessDayBounds(day: string): { start: Date; end: Date } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new RangeError(`businessDayBounds: expected YYYY-MM-DD, got "${day}"`);
  const startUtcMs =
    Date.parse(`${day}T00:00:00Z`) -
    DUBAI_UTC_OFFSET_MINUTES * 60_000 +
    BUSINESS_DAY_CUTOFF_HOURS * 3_600_000;
  return { start: new Date(startUtcMs), end: new Date(startUtcMs + 86_400_000) };
}

/** Render an instant in Dubai wall-clock time, for the dashboard and for logs. */
export function formatDubai(at: Date | string, opts: Intl.DateTimeFormatOptions = {}): string {
  const instant = typeof at === 'string' ? new Date(at) : at;
  return new Intl.DateTimeFormat('en-AE', {
    timeZone: OPERATING_TIMEZONE,
    dateStyle: 'medium',
    timeStyle: 'short',
    ...opts,
  }).format(instant);
}

export function addMinutes(at: Date, minutes: number): Date {
  return new Date(at.getTime() + minutes * 60_000);
}

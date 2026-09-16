import { businessDay } from '@berelax/contracts';
import type { ReservationView } from './api-types';

/**
 * The trading day, in pixels.
 *
 * The spa opens at 11:00 and closes at 02:00 the NEXT morning, so the grid is a
 * single 15-hour column that crosses midnight. A 01:30 booking belongs at the
 * BOTTOM of Monday's grid, not the top of Tuesday's — the API already tells us
 * which trading day a reservation is on (`businessDay`), and every position
 * here is measured from 11:00 Dubai on that day. Spec §3.3.
 *
 * Dubai is UTC+4 all year — no daylight saving — which is why a fixed offset is
 * correct here. This mirrors `businessDay()` in @berelax/contracts and
 * `business_day()` in SQL; all three must agree.
 */

export const DUBAI_UTC_OFFSET = '+04:00';
export const OPENING_HOUR = 11;
export const TRADING_HOURS = 15;
export const TRADING_MINUTES = TRADING_HOURS * 60;

/** 30-minute rows at 48px: a one-hour booking is a 96px tap target. */
export const SLOT_MINUTES = 30;
export const SLOT_PX = 48;
export const PX_PER_MINUTE = SLOT_PX / SLOT_MINUTES;

/** §8.4: IN_PROGRESS this long past `blockedUntil` is a booking someone forgot. */
export const NEEDS_CHECKOUT_AFTER_MS = 2 * 60 * 60 * 1000;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function assertDay(day: string): void {
  if (!DAY_PATTERN.test(day)) throw new RangeError(`Expected a YYYY-MM-DD trading day, got "${day}"`);
}

/** The trading day we are in right now. */
export function currentBusinessDay(now: Date = new Date()): string {
  return businessDay(now);
}

/** Move a trading day by whole days. Calendar arithmetic in UTC, so no drift. */
export function shiftBusinessDay(day: string, deltaDays: number): string {
  assertDay(day);
  const shifted = new Date(Date.parse(`${day}T00:00:00Z`) + deltaDays * 86_400_000);
  return shifted.toISOString().slice(0, 10);
}

/** The UTC milliseconds of 11:00 Dubai on this trading day, and of 02:00 after it. */
export function gridWindow(day: string): { openMs: number; closeMs: number } {
  assertDay(day);
  const openMs = Date.parse(
    `${day}T${String(OPENING_HOUR).padStart(2, '0')}:00:00${DUBAI_UTC_OFFSET}`,
  );
  return { openMs, closeMs: openMs + TRADING_MINUTES * 60_000 };
}

/**
 * Minutes from 11:00 on that trading day. A 01:30 start returns 870 (14.5 h in),
 * which is the bottom of the grid — the whole point of this module.
 */
export function minutesFromOpen(at: string | Date, day: string): number {
  const ms = typeof at === 'string' ? Date.parse(at) : at.getTime();
  if (Number.isNaN(ms)) throw new RangeError(`minutesFromOpen: invalid instant "${String(at)}"`);
  return (ms - gridWindow(day).openMs) / 60_000;
}

export function minutesToPx(minutes: number): number {
  return minutes * PX_PER_MINUTE;
}

/** An instant for a slot N minutes into the trading day. Crosses midnight safely. */
export function slotInstant(day: string, minutesFromOpening: number): Date {
  return new Date(gridWindow(day).openMs + minutesFromOpening * 60_000);
}

/** True when the booking falls outside the 11:00–02:00 band and cannot be drawn. */
export function isOutsideTradingHours(reservation: ReservationView, day: string): boolean {
  const start = minutesFromOpen(reservation.startsAt, day);
  return start < 0 || start >= TRADING_MINUTES;
}

export interface SlotLabel {
  minutes: number;
  /** "11:00", "00:30", "01:30" — 24-hour, because 01:00 is a working hour here. */
  label: string;
  /** The top of an hour, drawn heavier than the half. */
  isHour: boolean;
}

export function slotLabels(day: string): SlotLabel[] {
  const labels: SlotLabel[] = [];
  for (let minutes = 0; minutes < TRADING_MINUTES; minutes += SLOT_MINUTES) {
    labels.push({
      minutes,
      label: dubaiTime(slotInstant(day, minutes)),
      isHour: minutes % 60 === 0,
    });
  }
  return labels;
}

/** Where "now" sits on this day's grid, or null when it is not on screen. */
export function nowOffsetMinutes(day: string, now: Date = new Date()): number | null {
  const minutes = minutesFromOpen(now, day);
  return minutes >= 0 && minutes <= TRADING_MINUTES ? minutes : null;
}

/* ───────────────────────── rendering time ───────────────────────── */

const timeFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dubai',
  hour: '2-digit',
  minute: '2-digit',
  // h23 rather than hour12:false: midnight must read 00:00, never 24:00.
  hourCycle: 'h23',
});

const dayFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

const shortDayFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});

/** "14:00" in Asia/Dubai. The API speaks ISO-8601 with an offset. Spec §3.2. */
export function dubaiTime(at: string | Date): string {
  const instant = typeof at === 'string' ? new Date(at) : at;
  if (Number.isNaN(instant.getTime())) return '--:--';
  return timeFormat.format(instant);
}

export function dubaiTimeRange(from: string | Date, to: string | Date): string {
  return `${dubaiTime(from)}–${dubaiTime(to)}`;
}

/**
 * "Monday 15 September" for a trading day. Formatted in UTC from the bare date
 * so the label never slides a day either side of midnight.
 */
export function businessDayLabel(day: string, short = false): string {
  assertDay(day);
  const noon = new Date(`${day}T12:00:00Z`);
  return (short ? shortDayFormat : dayFormat).format(noon);
}

/** How a trading day reads relative to now: "Tonight", "Last night", or a date. */
export function businessDayRelation(day: string, now: Date = new Date()): string {
  const today = currentBusinessDay(now);
  if (day === today) return 'Tonight';
  if (day === shiftBusinessDay(today, -1)) return 'Last night';
  if (day === shiftBusinessDay(today, 1)) return 'Tomorrow';
  return businessDayLabel(day, true);
}

/* ───────────────────────── status helpers ───────────────────────── */

/**
 * §8.4: an IN_PROGRESS booking whose `blockedUntil` passed more than two hours
 * ago is flagged red. A booking left open overnight is a wrong report tomorrow.
 */
export function needsCheckout(reservation: ReservationView, now: Date = new Date()): boolean {
  if (reservation.status !== 'IN_PROGRESS') return false;
  const blockedUntil = Date.parse(reservation.blockedUntil);
  if (Number.isNaN(blockedUntil)) return false;
  return now.getTime() - blockedUntil > NEEDS_CHECKOUT_AFTER_MS;
}

/** "3 hours ago" — for the needs-checkout badge, which has to feel overdue. */
export function overdueBy(reservation: ReservationView, now: Date = new Date()): string {
  const minutes = Math.floor((now.getTime() - Date.parse(reservation.blockedUntil)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 60) return `${Math.max(minutes, 0)} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}

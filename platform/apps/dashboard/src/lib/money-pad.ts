import { asFils, formatAed } from '@berelax/contracts';

/**
 * The amount pad, in fils.
 *
 * Digits accumulate from the right the way a card terminal works: 2,5,0,0,0
 * reads AED 250.00. There is no decimal key and no `parseFloat` anywhere in
 * this file — the value is only ever an integer built from digit characters,
 * because a rounding bug here is a real till discrepancy at the end of the
 * night. Spec §3.1.
 */

/** 9 digits = AED 9,999,999.99, comfortably inside the API's per-line ceiling. */
const MAX_DIGITS = 9;

export type PadKey =
  | '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'
  | '00'
  | 'backspace'
  | 'clear';

/** The keypad's own state: a string of digits, nothing more. */
export interface PadValue {
  readonly digits: string;
}

export const EMPTY_PAD: PadValue = { digits: '' };

export function padPress(value: PadValue, key: PadKey): PadValue {
  if (key === 'clear') return EMPTY_PAD;
  if (key === 'backspace') return { digits: value.digits.slice(0, -1) };

  const next = `${value.digits}${key}`.replace(/^0+(?=\d)/, '');
  if (next.length > MAX_DIGITS) return value;
  return { digits: next };
}

/** The pad's value as whole fils. An empty pad is zero, not NaN. */
export function padFils(value: PadValue): number {
  if (value.digits === '') return 0;
  return asFils(Number.parseInt(value.digits, 10));
}

/** Seed the pad from an amount already in fils (the "Exact" shortcut). */
export function padFromFils(fils: number): PadValue {
  const whole = Math.max(0, Math.trunc(fils));
  return { digits: whole === 0 ? '' : String(whole) };
}

/** "AED 250.00" while typing, and "AED 0.00" before anything is typed. */
export function padDisplay(value: PadValue): string {
  return formatAed(padFils(value));
}

/**
 * What is still owed on a check-in, as the receptionist types. Positive means
 * short, negative means over — both are rendered, neither is rounded away.
 */
export function remainderFils(dueFils: number, lines: readonly number[]): number {
  return lines.reduce((outstanding, line) => outstanding - line, dueFils);
}

/** The banknotes actually handed over a desk in Abu Dhabi, in fils. */
export const CASH_SHORTCUTS_FILS: readonly number[] = [5_000, 10_000, 20_000, 50_000];

/** Tips land on round numbers far more often than not. */
export const TIP_SHORTCUTS_FILS: readonly number[] = [2_000, 5_000, 10_000];

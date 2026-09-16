/**
 * Money is an integer number of fils. 1 AED = 100 fils.
 * There are no floats and no Decimal round-trips anywhere in this system.
 * Spec §3.1.
 */

/** A branded integer. `Fils` cannot be passed where a plain number is expected by accident. */
export type Fils = number & { readonly __brand: 'Fils' };

export const FILS_PER_AED = 100;

/** Convert a human AED figure to fils. Rounds half-away-from-zero at the fils boundary. */
export function toFils(aed: number): Fils {
  if (!Number.isFinite(aed)) throw new RangeError(`toFils: ${aed} is not a finite number`);
  return Math.round(aed * FILS_PER_AED) as Fils;
}

/** Assert that a value is a usable fils amount: a safe, whole integer. */
export function asFils(value: number): Fils {
  if (!Number.isInteger(value)) throw new RangeError(`asFils: ${value} is not an integer`);
  if (!Number.isSafeInteger(value)) throw new RangeError(`asFils: ${value} exceeds safe integer range`);
  return value as Fils;
}

export function toAed(fils: Fils | number): number {
  return fils / FILS_PER_AED;
}

/** "AED 250.00" — the ONLY place money becomes a string. */
export function formatAed(fils: Fils | number): string {
  return new Intl.NumberFormat('en-AE', {
    style: 'currency',
    currency: 'AED',
    minimumFractionDigits: 2,
  }).format(toAed(fils));
}

export function sumFils(amounts: readonly (Fils | number)[]): Fils {
  return asFils(amounts.reduce<number>((total, n) => total + n, 0));
}

/**
 * Split a commission in basis points, rounding to the nearest fils.
 * 10_000 bps = 100%. Used for therapist commission on the base service.
 */
export function applyBps(fils: Fils | number, bps: number): Fils {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new RangeError(`applyBps: ${bps} is not a valid basis-point value (0-10000)`);
  }
  return asFils(Math.round((fils * bps) / 10_000));
}

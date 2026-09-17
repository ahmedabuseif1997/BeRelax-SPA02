import type { ConfigService } from '@nestjs/config';
import { CASH_TOLERANCE_ENV, ReconciliationConfig, parseCashTolerance } from './reconciliation.config';

/**
 * The one setting this module has, and the only one it will ever have.
 *
 * The test worth reading is the one about "5.00". Money is an integer number of
 * fils and the tool must never invite a decimal (§3.1); a coerced parse would
 * read that as five fils — half a fil short of nothing — and silently run the
 * whole pilot with a tolerance five hundred times narrower than the person who
 * typed it believed. A refusal at boot is the only safe answer.
 */

function configWith(value: string | undefined): ConfigService {
  return { get: () => value } as unknown as ConfigService;
}

describe('parseCashTolerance', () => {
  it('defaults to zero when unset', () => {
    expect(parseCashTolerance(undefined)).toBe(0);
  });

  it('defaults to zero when set to nothing', () => {
    // .env.example ships optional keys as KEY="" so their names are
    // discoverable. An empty value means "not set", exactly as `env.ts` reads it.
    expect(parseCashTolerance('')).toBe(0);
    expect(parseCashTolerance('   ')).toBe(0);
  });

  it('accepts a whole number of fils', () => {
    expect(parseCashTolerance('500')).toBe(500);
    expect(parseCashTolerance(' 500 ')).toBe(500);
    expect(parseCashTolerance('0')).toBe(0);
  });

  it('refuses a decimal rather than reading AED 5.00 as five fils', () => {
    expect(() => parseCashTolerance('5.00')).toThrow(/whole number of fils/);
  });

  it('refuses a negative tolerance, which would accept anything', () => {
    expect(() => parseCashTolerance('-500')).toThrow(/whole number of fils/);
  });

  it('refuses something that is not a number at all', () => {
    expect(() => parseCashTolerance('AED 5')).toThrow(/whole number of fils/);
    expect(() => parseCashTolerance('1e3')).toThrow(/whole number of fils/);
  });

  it('names the variable in the failure, so it can be fixed without a search', () => {
    expect(() => parseCashTolerance('nonsense')).toThrow(new RegExp(CASH_TOLERANCE_ENV));
  });
});

describe('ReconciliationConfig', () => {
  it('reads the tolerance off the injected config', () => {
    expect(new ReconciliationConfig(configWith('250')).cashToleranceFils).toBe(250);
  });

  it('is zero by default — a variance is recorded, not forgiven', () => {
    expect(new ReconciliationConfig(configWith(undefined)).cashToleranceFils).toBe(0);
  });

  it('fails the process rather than the request when it is misconfigured', () => {
    // At boot this is a five-second problem. Discovered mid-pilot, it
    // invalidates every night signed off under it.
    expect(() => new ReconciliationConfig(configWith('2.5'))).toThrow();
  });
});

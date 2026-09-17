import { HttpException } from '@nestjs/common';
import type { ApiErrorBody } from '@berelax/contracts';
import { ErrorCode } from '@berelax/contracts';
import {
  REPORT_MAX_SPAN_DAYS,
  percentOrNull,
  resolveReportWindow,
  tradingDaysBetween,
} from './reports.support';

/**
 * The window every report is cut on, and the one percentage helper.
 *
 * Two properties here are load-bearing well beyond their size: an unspecified
 * period means the current TRADING month rather than the current calendar one,
 * and a denominator of zero yields null rather than 0 %. A report that prints a
 * made-up zero gets believed.
 */

/** 07:00 Dubai on the 17th is still the 16th's trading day — the 06:00 cutover. */
const DURING_THE_17TH = new Date('2026-09-17T12:00:00+04:00');
const AFTER_MIDNIGHT = new Date('2026-09-17T01:30:00+04:00');

async function caught(run: () => unknown): Promise<{ status: number; body: ApiErrorBody }> {
  try {
    await run();
  } catch (err) {
    const http = err as HttpException;
    return { status: http.getStatus(), body: http.getResponse() as ApiErrorBody };
  }
  throw new Error('expected the call to reject, but it resolved');
}

describe('resolveReportWindow', () => {
  it('defaults to the current trading month, to date', () => {
    expect(resolveReportWindow({}, DURING_THE_17TH)).toEqual({
      from: '2026-09-01',
      to: '2026-09-17',
    });
  });

  it('puts a 01:30 request on the night before, not on the new month’s first day', () => {
    // 01:30 on 1 October is still September's trading month, and a report opened
    // at that hour must not show an empty new month. §3.3.
    const firstOfOctober = new Date('2026-10-01T01:30:00+04:00');

    expect(resolveReportWindow({}, firstOfOctober)).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
    });
  });

  it('fills in the missing end of a half-given range', () => {
    expect(resolveReportWindow({ from: '2026-08-01' }, AFTER_MIDNIGHT)).toEqual({
      from: '2026-08-01',
      to: '2026-09-16',
    });
    expect(resolveReportWindow({ to: '2026-08-20' }, DURING_THE_17TH)).toEqual({
      from: '2026-08-01',
      to: '2026-08-20',
    });
  });

  it('422s a period that ends before it starts', async () => {
    const { status, body } = await caught(() =>
      resolveReportWindow({ from: '2026-09-30', to: '2026-09-01' }),
    );

    expect(status).toBe(422);
    expect(body.error.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it('refuses a window wider than the cap rather than quietly narrowing it', async () => {
    const { status, body } = await caught(() =>
      resolveReportWindow({ from: '2020-01-01', to: '2026-09-16' }),
    );

    expect(status).toBe(422);
    expect(body.error.code).toBe(ErrorCode.REPORT_RANGE_TOO_LARGE);
    // The details carry what was asked for AND the limit, so the dashboard can
    // narrow the range itself instead of making the manager guess.
    expect(body.error.details).toMatchObject({
      from: '2020-01-01',
      to: '2026-09-16',
      maxDays: REPORT_MAX_SPAN_DAYS,
    });
  });

  it('answers a window exactly on the cap', () => {
    const to = '2026-09-16';
    const from = new Date(Date.parse(`${to}T00:00:00Z`) - (REPORT_MAX_SPAN_DAYS - 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);

    expect(resolveReportWindow({ from, to })).toEqual({ from, to });
  });
});

describe('tradingDaysBetween', () => {
  it('counts inclusively, so one night is one day', () => {
    expect(tradingDaysBetween('2026-09-16', '2026-09-16')).toBe(1);
    expect(tradingDaysBetween('2026-09-16', '2026-09-17')).toBe(2);
    expect(tradingDaysBetween('2026-09-01', '2026-09-30')).toBe(30);
  });

  it('is unmoved by the month and year boundaries', () => {
    expect(tradingDaysBetween('2026-12-31', '2027-01-01')).toBe(2);
    // 2028 is a leap year; February has to be 29 days or every annual report
    // drifts by one.
    expect(tradingDaysBetween('2028-02-01', '2028-02-29')).toBe(29);
  });
});

describe('percentOrNull', () => {
  it('rounds to one decimal', () => {
    expect(percentOrNull(1, 3)).toBe(33.3);
    expect(percentOrNull(2, 3)).toBe(66.7);
    expect(percentOrNull(1_620, 21_600)).toBe(7.5);
    expect(percentOrNull(1, 1)).toBe(100);
  });

  it('answers null for a zero denominator, never 0 and never Infinity', () => {
    // A therapist with no roster is not 0 % utilised and a channel with no
    // enquiries did not convert 0 % of them. Both are unknown.
    expect(percentOrNull(0, 0)).toBeNull();
    expect(percentOrNull(120, 0)).toBeNull();
  });

  it('reports a genuine zero as zero', () => {
    expect(percentOrNull(0, 480)).toBe(0);
  });
});

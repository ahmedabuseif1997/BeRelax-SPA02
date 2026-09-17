import { UnprocessableEntityException } from '@nestjs/common';
import { ErrorCode } from '@berelax/contracts';
import {
  apiError,
  monthStart,
  resolveTradingWindow,
  shiftTradingDay,
  tradingDayOf,
  type TradingWindow,
} from '../payments/money.support';

/**
 * Shared ground for the reporting layer: the window every report is cut on, the
 * one percentage helper, and the labels that keep a tip from being read as
 * earnings.
 *
 * `apiError`, `resolveTradingWindow`, `shiftTradingDay`, `monthStart` and
 * `tradingDayOf` come from the money module rather than being reimplemented
 * here, for the reason `money.support.ts` gives itself: a second
 * `businessDayColumn` is how a refund lands in a different trading day from the
 * payment it reverses, and a second error-body shape is how the dashboard ends
 * up with two of them to parse.
 */
export { apiError, monthStart, shiftTradingDay, tradingDayOf };
export type { TradingWindow };

/**
 * The widest window any report will answer, in trading days. Thirteen months,
 * so "this year against last" fits in one request and a fat-fingered `from`
 * does not quietly turn the 600 ms daily close-out into a table scan for
 * everyone else on the branch (§12.1).
 */
export const REPORT_MAX_SPAN_DAYS = 400;

/**
 * Resolve `?from=&to=` into inclusive TRADING days, and refuse a window wider
 * than the cap.
 *
 * Asked for without dates, a report means "this trading month so far" — the
 * period a manager actually closes, and the one a payout is cut on (§9.5).
 * `/reports/daily` is the exception and does not come through here: it is a
 * single night, so it defaults to tonight instead.
 *
 * The refusal is 422 with its own code rather than a silent clamp: a report
 * that quietly answers a narrower question than it was asked is the kind of
 * wrong that gets pasted into a board pack. `from > to` keeps the shared
 * VALIDATION_FAILED from `resolveTradingWindow` — one mistake, one code,
 * wherever in the money layer it is made.
 */
export function resolveReportWindow(
  query: { from?: string; to?: string },
  now: Date = new Date(),
): TradingWindow {
  const window = resolveTradingWindow(query, monthStart, now);
  const span = tradingDaysBetween(window.from, window.to);

  if (span > REPORT_MAX_SPAN_DAYS) {
    throw new UnprocessableEntityException(
      apiError(
        ErrorCode.REPORT_RANGE_TOO_LARGE,
        `That is ${span} trading days. Ask for at most ${REPORT_MAX_SPAN_DAYS} at a time.`,
        { from: window.from, to: window.to, days: span, maxDays: REPORT_MAX_SPAN_DAYS },
      ),
    );
  }
  return window;
}

/** Inclusive: a single day is 1, not 0. */
export function tradingDaysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/**
 * A percentage to one decimal, or `null` when the denominator is zero.
 *
 * Null, never 0 and never 100: a therapist with no roster is not 0 % utilised
 * and a channel with no enquiries did not convert 0 % of them. A report that
 * prints a made-up zero is worse than one that says it does not know — the
 * zero gets believed.
 */
export function percentOrNull(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 1_000) / 10;
}

/**
 * The three money lines, spelled out. §9.1's table is the whole reason these
 * strings exist: a tip is not revenue in either mode, and the difference
 * between the two modes is who is holding the cash right now.
 */
export const MONEY_LINE_LABELS = {
  revenue:
    'Business revenue — base treatments collected at the desk, net of refunds and adjustments',
  tipsCollectedByBusiness:
    'Tips added to the bill — held by BE RELAX and owed out to the therapist. A pass-through, NOT revenue',
  tipsDirectCash:
    'Tips handed straight to the therapist — the business never held this and never owed it. NOT revenue',
} as const;

/** A pair of figures reported for each tip mode. §9.1. */
export interface TipLine {
  tipCount: number;
  totalFils: number;
}

export const NO_TIPS: TipLine = { tipCount: 0, totalFils: 0 };

/**
 * `SUM()` over zero rows is NULL in Postgres and Prisma passes that straight
 * through, so every aggregate in this module is `COALESCE`d in SQL and read
 * back through here as well. A null that reaches a money field renders as a
 * silent zero, which in a report is indistinguishable from a quiet night.
 */
export function fils(value: number | null | undefined): number {
  return value ?? 0;
}

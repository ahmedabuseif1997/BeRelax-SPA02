import { ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ErrorCode, UserRole, businessDay } from '@berelax/contracts';
import type { AuthUser } from '../common/request-context';
import { apiError, businessDayColumn, isManagerOrAbove } from '../reservations/reservations.service';

/**
 * Shared ground for the money module: the role gates, the trading-day window
 * every report is cut on, and the one way a balance is ever obtained.
 *
 * `apiError`, `businessDayColumn` and `isManagerOrAbove` are imported from the
 * reservations service and re-exported here rather than reimplemented. Two
 * copies of the error-body shape is exactly how a dashboard ends up with two
 * error shapes to parse, and a second `businessDayColumn` is how a refund lands
 * in a different trading day from the payment it reverses.
 */
export { apiError, businessDayColumn };

/** Issuing refunds, reversing tips, approving payouts and reading the audit log. §6.4. */
export const MANAGER_PLUS = [UserRole.OWNER, UserRole.MANAGER] as const;

/** A therapist may read their OWN ledger and earnings. Nobody else's. §6.4. */
export const MANAGER_PLUS_OR_THERAPIST = [...MANAGER_PLUS, UserRole.THERAPIST] as const;

/**
 * A therapist reading a therapist record: theirs, or nothing.
 *
 * 403 rather than 404 on purpose. The reservations service hides other people's
 * bookings behind a 404 so a therapist walking ids cannot learn which ones
 * exist; an employee id is not a secret — it is on the booking grid — so
 * pretending the record does not exist would only be confusing. What is
 * confidential is the money, and that is what this refuses.
 */
export function assertMayReadEmployeeRecord(employeeId: string, actor: AuthUser): void {
  if (isManagerOrAbove(actor.role)) return;
  if (actor.employeeId && actor.employeeId === employeeId) return;

  throw new ForbiddenException(
    apiError(
      ErrorCode.INSUFFICIENT_ROLE,
      'You can only see your own earnings and payout record.',
    ),
  );
}

export interface TradingWindow {
  from: string;
  to: string;
}

/** `YYYY-MM-DD` arithmetic on trading days. UTC midnight, so no offset can shift the date. */
export function shiftTradingDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The first trading day of the month a day falls in — the default earnings period. */
export function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

/**
 * Resolve a reporting window in TRADING days, not calendar days: a 01:30 tip
 * belongs to the night before, and a report that disagrees with that is the one
 * that makes a therapist distrust the whole system. §3.3.
 *
 * `to` defaults to the current trading day, `from` to whatever the caller's
 * report considers a sensible span back from it.
 */
export function resolveTradingWindow(
  query: { from?: string; to?: string },
  defaultFrom: (to: string) => string,
  now: Date = new Date(),
): TradingWindow {
  const to = query.to ?? businessDay(now);
  const from = query.from ?? defaultFrom(to);

  if (from > to) {
    throw new UnprocessableEntityException(
      apiError(ErrorCode.VALIDATION_FAILED, 'The period ends before it starts.', { from, to }),
    );
  }
  return { from, to };
}

/**
 * The balance. SUM(amount_fils) over the ledger, every time, for every caller.
 *
 * There is no stored balance column and there will not be one: a denormalised
 * balance is a second source of truth that drifts, and the drift is discovered
 * during a dispute — the worst possible moment. Postgres returns NULL for a SUM
 * over zero rows and Prisma passes that straight through, so the coalesce is
 * here rather than at each of the five call sites. §9.3.
 */
export async function ledgerSumFils(
  client: Prisma.TransactionClient,
  where: Prisma.TherapistPayoutLedgerWhereInput,
): Promise<number> {
  const total = await client.therapistPayoutLedger.aggregate({
    _sum: { amountFils: true },
    where,
  });
  return total._sum.amountFils ?? 0;
}

/** A `@db.Date` column read back as a Date is UTC midnight; this is its trading day. */
export function tradingDayOf(column: Date): string {
  return column.toISOString().slice(0, 10);
}

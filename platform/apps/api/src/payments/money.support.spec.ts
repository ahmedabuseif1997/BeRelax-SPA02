import { HttpException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { ApiErrorBody } from '@berelax/contracts';
import { ErrorCode, UserRole } from '@berelax/contracts';
import type { AuthUser } from '../common/request-context';
import {
  assertMayReadEmployeeRecord,
  ledgerSumFils,
  monthStart,
  resolveTradingWindow,
  shiftTradingDay,
  tradingDayOf,
} from './money.support';

const EMPLOYEE_ID = '0192cccc-0000-7000-8000-00000000000c';
const OTHER_EMPLOYEE_ID = '0192cccc-0000-7000-8000-00000000000f';

function userFixture(role: UserRole, employeeId: string | null = null): AuthUser {
  return {
    id: '0192dddd-0000-7000-8000-00000000000d',
    role,
    branchId: '0192bbbb-0000-7000-8000-00000000000b',
    employeeId,
    email: 'user@berelax.ae',
    fullName: 'User',
  };
}

function caught(run: () => unknown): { status: number; body: ApiErrorBody } {
  try {
    run();
  } catch (err) {
    const http = err as HttpException;
    return { status: http.getStatus(), body: http.getResponse() as ApiErrorBody };
  }
  throw new Error('expected the call to throw, but it returned');
}

describe('assertMayReadEmployeeRecord — §6.4', () => {
  it('lets a manager and an owner read anybody’s record', () => {
    expect(() =>
      assertMayReadEmployeeRecord(EMPLOYEE_ID, userFixture(UserRole.MANAGER)),
    ).not.toThrow();
    expect(() =>
      assertMayReadEmployeeRecord(EMPLOYEE_ID, userFixture(UserRole.OWNER)),
    ).not.toThrow();
  });

  it('lets a therapist read their own', () => {
    expect(() =>
      assertMayReadEmployeeRecord(EMPLOYEE_ID, userFixture(UserRole.THERAPIST, EMPLOYEE_ID)),
    ).not.toThrow();
  });

  it('403s a therapist reading somebody else’s', () => {
    const { status, body } = caught(() =>
      assertMayReadEmployeeRecord(OTHER_EMPLOYEE_ID, userFixture(UserRole.THERAPIST, EMPLOYEE_ID)),
    );

    expect(status).toBe(403);
    expect(body.error.code).toBe(ErrorCode.INSUFFICIENT_ROLE);
  });

  it('403s a therapist login with no employee record behind it', () => {
    const { status } = caught(() =>
      assertMayReadEmployeeRecord(EMPLOYEE_ID, userFixture(UserRole.THERAPIST, null)),
    );

    expect(status).toBe(403);
  });

  it('403s a receptionist, who never sees the money at all', () => {
    const { status } = caught(() =>
      assertMayReadEmployeeRecord(EMPLOYEE_ID, userFixture(UserRole.RECEPTIONIST)),
    );

    expect(status).toBe(403);
  });
});

describe('trading-day arithmetic — §3.3', () => {
  it('steps back across a month boundary without losing a day', () => {
    expect(shiftTradingDay('2026-09-01', -1)).toBe('2026-08-31');
    expect(shiftTradingDay('2026-09-16', -90)).toBe('2026-06-18');
    expect(shiftTradingDay('2026-02-28', 1)).toBe('2026-03-01');
  });

  it('finds the first trading day of the month', () => {
    expect(monthStart('2026-09-16')).toBe('2026-09-01');
  });

  it('reads a @db.Date column as the trading day it stores', () => {
    expect(tradingDayOf(new Date('2026-09-16T00:00:00.000Z'))).toBe('2026-09-16');
  });
});

describe('resolveTradingWindow', () => {
  // A 01:30 moment belongs to the night before, which is the whole point of a
  // trading day and the difference between a right report and a plausible one.
  const AFTER_MIDNIGHT = new Date('2026-09-17T01:30:00+04:00');

  it('takes both ends when both are given', () => {
    expect(
      resolveTradingWindow({ from: '2026-09-01', to: '2026-09-30' }, monthStart, AFTER_MIDNIGHT),
    ).toEqual({ from: '2026-09-01', to: '2026-09-30' });
  });

  it('ends on the current trading day when no end is given', () => {
    expect(resolveTradingWindow({ from: '2026-09-01' }, monthStart, AFTER_MIDNIGHT)).toEqual({
      from: '2026-09-01',
      to: '2026-09-16',
    });
  });

  it('derives the start from the end when no start is given', () => {
    expect(resolveTradingWindow({}, (end) => shiftTradingDay(end, -7), AFTER_MIDNIGHT)).toEqual({
      from: '2026-09-09',
      to: '2026-09-16',
    });
  });

  it('422s a window that ends before it starts', () => {
    const { status, body } = caught(() =>
      resolveTradingWindow({ from: '2026-09-30', to: '2026-09-01' }, monthStart, AFTER_MIDNIGHT),
    );

    expect(status).toBe(422);
    expect(body.error.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(body.error.details).toEqual({ from: '2026-09-30', to: '2026-09-01' });
  });

  it('accepts a single-day window', () => {
    expect(
      resolveTradingWindow({ from: '2026-09-16', to: '2026-09-16' }, monthStart),
    ).toEqual({ from: '2026-09-16', to: '2026-09-16' });
  });
});

describe('ledgerSumFils — §9.3', () => {
  const client = (sum: number | null) =>
    ({
      therapistPayoutLedger: { aggregate: jest.fn().mockResolvedValue({ _sum: { amountFils: sum } }) },
    }) as unknown as Prisma.TransactionClient;

  it('returns the sum the database gives it', async () => {
    await expect(ledgerSumFils(client(38_500), { employeeId: EMPLOYEE_ID })).resolves.toBe(38_500);
  });

  it('reads SUM over zero rows — NULL in Postgres — as zero fils', async () => {
    await expect(ledgerSumFils(client(null), { employeeId: EMPLOYEE_ID })).resolves.toBe(0);
  });

  it('passes the filter through untouched, so the caller decides the scope', async () => {
    const tx = client(0);
    await ledgerSumFils(tx, { employeeId: EMPLOYEE_ID, payoutBatchId: null });

    expect(tx.therapistPayoutLedger.aggregate).toHaveBeenCalledWith({
      _sum: { amountFils: true },
      where: { employeeId: EMPLOYEE_ID, payoutBatchId: null },
    });
  });
});

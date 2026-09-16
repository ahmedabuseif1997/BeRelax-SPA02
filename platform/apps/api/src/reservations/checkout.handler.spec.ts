import { HttpException } from '@nestjs/common';
import type { Reservation } from '@prisma/client';
import type { ApiErrorBody, CheckoutDto } from '@berelax/contracts';
import { ErrorCode, UserRole } from '@berelax/contracts';
import { AuditService } from '../common/audit.service';
import type { AuthUser, RequestContext } from '../common/request-context';
import type { PrismaService } from '../prisma/prisma.service';
import { CheckoutHandler } from './checkout.handler';

/**
 * §13.2 puts the money logic at 100 % of branches, and §9.1 is the distinction
 * the whole design rests on: BOTH tip modes are exercised here, and the
 * DIRECT_CASH case asserts the absence of a ledger row explicitly. Conflating
 * the two is how a spa pays a tip twice.
 */

const RESERVATION_ID = '0192f8a1-0000-7000-8000-000000000001';
const BRANCH_ID = '0192bbbb-0000-7000-8000-00000000000b';
const EMPLOYEE_ID = '0192cccc-0000-7000-8000-00000000000c';
const USER_ID = '0192dddd-0000-7000-8000-00000000000d';

const ARRIVED_AT = new Date('2026-09-16T19:04:00+04:00');
const COMPLETED_AT = '2026-09-16T20:12:00+04:00';

function reservationFixture(overrides: Partial<Reservation> = {}): Reservation {
  return {
    id: RESERVATION_ID,
    ref: 'BR-2026-0417',
    branchId: BRANCH_ID,
    guestId: null,
    employeeId: EMPLOYEE_ID,
    roomId: null,
    serviceId: '0192eeee-0000-7000-8000-00000000000e',
    startsAt: new Date('2026-09-16T19:00:00+04:00'),
    durationMinutes: 60,
    endsAt: new Date('2026-09-16T20:00:00+04:00'),
    blockedUntil: new Date('2026-09-16T20:15:00+04:00'),
    businessDay: new Date('2026-09-16T00:00:00.000Z'),
    status: 'IN_PROGRESS',
    baseCostFils: 25_000,
    sourceChannel: 'WALK_IN',
    attributionId: null,
    actualArrivalAt: ARRIVED_AT,
    completedAt: null,
    cancelledAt: null,
    cancellationReason: null,
    notes: null,
    createdByUserId: USER_ID,
    createdAt: new Date('2026-09-10T08:00:00.000Z'),
    updatedAt: new Date('2026-09-16T19:04:00.000Z'),
    ...overrides,
  };
}

function actorFixture(role: UserRole = UserRole.RECEPTIONIST): AuthUser {
  return {
    id: USER_ID,
    role,
    branchId: BRANCH_ID,
    email: 'reception@berelax.ae',
    fullName: 'Reception',
  };
}

const CTX: RequestContext = {
  requestId: 'req_01JBQ7X8',
  branchId: BRANCH_ID,
  actorUserId: USER_ID,
  actorRole: UserRole.RECEPTIONIST,
  idempotencyKey: '2b7c9d10-3e4f-4a5b-8c6d-1f2e3a4b5c6d',
};

function checkoutDto(overrides: Partial<CheckoutDto> = {}): CheckoutDto {
  return { completedAt: COMPLETED_AT, tip: null, confirmLargeTip: false, ...overrides };
}

type LedgerRow = { entryType: string; amountFils: number; tipId?: string | null };

type Tx = {
  $queryRaw: jest.Mock;
  reservation: { findUniqueOrThrow: jest.Mock; update: jest.Mock };
  payment: { aggregate: jest.Mock; create: jest.Mock };
  tip: { create: jest.Mock };
  therapistPayoutLedger: { create: jest.Mock; aggregate: jest.Mock };
  financialAuditLog: { create: jest.Mock };
};

function setup(
  options: {
    reservation?: Reservation;
    /** null stands for "no payment rows at all": Postgres SUM over nothing is NULL. */
    settledFils?: number | null;
    /** A commission accrued at check-in, already sitting on the ledger. */
    existingLedgerFils?: number;
    found?: boolean;
  } = {},
) {
  const reservation = options.reservation ?? reservationFixture();
  const existing = options.existingLedgerFils ?? 0;
  const ledgerRows: LedgerRow[] = [];

  const tx: Tx = {
    $queryRaw: jest.fn().mockResolvedValue(options.found === false ? [] : [{ id: reservation.id }]),
    reservation: {
      findUniqueOrThrow: jest.fn().mockResolvedValue(reservation),
      update: jest.fn(async ({ data }: { data: Partial<Reservation> }) =>
        reservationFixture({ ...reservation, ...data }),
      ),
    },
    payment: {
      aggregate: jest.fn().mockResolvedValue({
        _sum: {
          amountFils:
            options.settledFils === undefined ? reservation.baseCostFils : options.settledFils,
        },
      }),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...data,
        id: 'payment-1',
      })),
    },
    tip: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...data,
        id: 'tip-1',
      })),
    },
    therapistPayoutLedger: {
      create: jest.fn(async ({ data }: { data: LedgerRow }) => {
        ledgerRows.push(data);
        return { ...data, id: `ledger-${ledgerRows.length}` };
      }),
      // The balance is always SUM(amount_fils) — never a stored column. §9.3.
      // SUM over zero rows is NULL in Postgres, and Prisma passes that through.
      aggregate: jest.fn(async () => {
        const rows = ledgerRows.reduce((sum, r) => sum + r.amountFils, 0);
        const empty = existing === 0 && ledgerRows.length === 0;
        return { _sum: { amountFils: empty ? null : existing + rows } };
      }),
    },
    financialAuditLog: { create: jest.fn().mockResolvedValue({}) },
  };

  const prisma = {
    $transaction: jest.fn(async (cb: (client: Tx) => Promise<unknown>) => cb(tx)),
  } as unknown as PrismaService;

  return { tx, ledgerRows, handler: new CheckoutHandler(prisma, new AuditService()) };
}

async function caught(run: () => Promise<unknown>): Promise<{ status: number; body: ApiErrorBody }> {
  try {
    await run();
  } catch (err) {
    const http = err as HttpException;
    return { status: http.getStatus(), body: http.getResponse() as ApiErrorBody };
  }
  throw new Error('expected the call to reject, but it resolved');
}

describe('CheckoutHandler — step 2 of the two-step financial workflow', () => {
  describe('rejections', () => {
    it('404s when no such booking exists in this branch', async () => {
      const { handler, tx } = setup({ found: false });

      const { status, body } = await caught(() =>
        handler.checkout(RESERVATION_ID, checkoutDto(), actorFixture(), CTX),
      );

      expect(status).toBe(404);
      expect(body.error.code).toBe(ErrorCode.RESERVATION_NOT_FOUND);
      expect(tx.reservation.update).not.toHaveBeenCalled();
    });

    it('locks the row for update before reading it', async () => {
      const { handler, tx } = setup();
      await handler.checkout(RESERVATION_ID, checkoutDto(), actorFixture(), CTX);

      expect((tx.$queryRaw.mock.calls[0]![0] as string[]).join('?')).toContain('FOR UPDATE');
    });

    it.each(['SCHEDULED', 'COMPLETED', 'CANCELLED', 'NO_SHOW'] as const)(
      '409s when the booking is %s rather than IN_PROGRESS',
      async (status) => {
        const { handler } = setup({ reservation: reservationFixture({ status }) });

        const result = await caught(() =>
          handler.checkout(RESERVATION_ID, checkoutDto(), actorFixture(), CTX),
        );

        expect(result.status).toBe(409);
        expect(result.body.error.code).toBe(ErrorCode.RESERVATION_NOT_IN_PROGRESS);
        expect(result.body.error.details).toEqual({ status });
      },
    );

    it('409s when the base is not fully settled, naming what is outstanding', async () => {
      const { handler, tx } = setup({ settledFils: 20_000 });

      const { status, body } = await caught(() =>
        handler.checkout(RESERVATION_ID, checkoutDto(), actorFixture(), CTX),
      );

      expect(status).toBe(409);
      expect(body.error.code).toBe(ErrorCode.BASE_PAYMENT_OUTSTANDING);
      expect(body.error.details).toEqual({
        expectedFils: 25_000,
        settledFils: 20_000,
        outstandingFils: 5_000,
      });
      expect(tx.reservation.update).not.toHaveBeenCalled();
    });

    it('409s when nothing at all has been collected', async () => {
      const { handler } = setup({ settledFils: null });

      const { status, body } = await caught(() =>
        handler.checkout(RESERVATION_ID, checkoutDto(), actorFixture(), CTX),
      );

      expect(status).toBe(409);
      expect(body.error.code).toBe(ErrorCode.BASE_PAYMENT_OUTSTANDING);
      expect(body.error.details).toEqual({
        expectedFils: 25_000,
        settledFils: 0,
        outstandingFils: 25_000,
      });
    });

    it('counts BASE, ADJUSTMENT and REFUND rows towards settlement, and nothing else', async () => {
      const { handler, tx } = setup();
      await handler.checkout(RESERVATION_ID, checkoutDto(), actorFixture(), CTX);

      expect(tx.payment.aggregate).toHaveBeenCalledWith({
        _sum: { amountFils: true },
        where: {
          reservationId: RESERVATION_ID,
          kind: { in: ['BASE', 'ADJUSTMENT', 'REFUND'] },
        },
      });
    });

    it('422s a completion timestamp that precedes the arrival', async () => {
      const { handler } = setup();

      const { status, body } = await caught(() =>
        handler.checkout(
          RESERVATION_ID,
          checkoutDto({ completedAt: '2026-09-16T19:00:00+04:00' }),
          actorFixture(),
          CTX,
        ),
      );

      expect(status).toBe(422);
      expect(body.error.code).toBe(ErrorCode.COMPLETION_BEFORE_ARRIVAL);
    });

    it('422s a non-positive tip', async () => {
      const { handler, tx } = setup();

      const { status, body } = await caught(() =>
        handler.checkout(
          RESERVATION_ID,
          checkoutDto({ tip: { amountFils: 0, type: 'DIRECT_CASH' } }),
          actorFixture(),
          CTX,
        ),
      );

      expect(status).toBe(422);
      expect(body.error.code).toBe(ErrorCode.INVALID_AMOUNT);
      expect(tx.tip.create).not.toHaveBeenCalled();
    });

    it('422s a business-collected tip with no payment method', async () => {
      const { handler } = setup();

      const { status, body } = await caught(() =>
        handler.checkout(
          RESERVATION_ID,
          checkoutDto({ tip: { amountFils: 5_000, type: 'COLLECTED_BY_BUSINESS' } }),
          actorFixture(),
          CTX,
        ),
      );

      expect(status).toBe(422);
      expect(body.error.code).toBe(ErrorCode.TIP_METHOD_REQUIRED);
    });

    it('422s a direct-cash tip that carries a payment method', async () => {
      const { handler } = setup();

      const { status, body } = await caught(() =>
        handler.checkout(
          RESERVATION_ID,
          checkoutDto({ tip: { amountFils: 5_000, type: 'DIRECT_CASH', method: 'CARD' } }),
          actorFixture(),
          CTX,
        ),
      );

      expect(status).toBe(422);
      expect(body.error.code).toBe(ErrorCode.TIP_METHOD_NOT_ALLOWED);
    });
  });

  describe('the 3x sanity limit', () => {
    const largeTip = (amountFils: number): CheckoutDto['tip'] => ({
      amountFils,
      type: 'DIRECT_CASH',
    });

    it('422s a tip over three times the treatment price', async () => {
      const { handler, tx } = setup();

      const { status, body } = await caught(() =>
        handler.checkout(RESERVATION_ID, checkoutDto({ tip: largeTip(75_001) }), actorFixture(), CTX),
      );

      expect(status).toBe(422);
      expect(body.error.code).toBe(ErrorCode.TIP_EXCEEDS_SANITY_LIMIT);
      expect(body.error.details).toEqual({
        amountFils: 75_001,
        limitFils: 75_000,
        baseCostFils: 25_000,
      });
      expect(tx.tip.create).not.toHaveBeenCalled();
    });

    it('allows a tip of exactly three times without any override', async () => {
      const { handler, tx } = setup();

      await handler.checkout(RESERVATION_ID, checkoutDto({ tip: largeTip(75_000) }), actorFixture(), CTX);

      expect(tx.tip.create).toHaveBeenCalledTimes(1);
    });

    it('still refuses when a RECEPTIONIST sets confirmLargeTip: the override is MANAGER+', async () => {
      const { handler } = setup();

      const { body } = await caught(() =>
        handler.checkout(
          RESERVATION_ID,
          checkoutDto({ tip: largeTip(75_001), confirmLargeTip: true }),
          actorFixture(UserRole.RECEPTIONIST),
          CTX,
        ),
      );

      expect(body.error.code).toBe(ErrorCode.TIP_EXCEEDS_SANITY_LIMIT);
    });

    it.each([UserRole.MANAGER, UserRole.OWNER])('lets a %s confirm it deliberately', async (role) => {
      const { handler, tx } = setup();

      await handler.checkout(
        RESERVATION_ID,
        checkoutDto({ tip: largeTip(75_001), confirmLargeTip: true }),
        actorFixture(role),
        CTX,
      );

      const { data } = tx.tip.create.mock.calls[0]![0] as { data: { amountFils: number } };
      expect(data.amountFils).toBe(75_001);
    });

    it('does not ask a manager to confirm a tip inside the limit', async () => {
      const { handler, tx } = setup();

      await handler.checkout(
        RESERVATION_ID,
        checkoutDto({ tip: largeTip(5_000) }),
        actorFixture(UserRole.MANAGER),
        CTX,
      );

      expect(tx.tip.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('no tip — the most common checkout', () => {
    it('completes the booking and records nothing financial', async () => {
      const { handler, tx } = setup();

      const result = await handler.checkout(RESERVATION_ID, checkoutDto(), actorFixture(), CTX);

      expect(tx.payment.create).not.toHaveBeenCalled();
      expect(tx.tip.create).not.toHaveBeenCalled();
      expect(tx.therapistPayoutLedger.create).not.toHaveBeenCalled();
      expect(tx.reservation.update).toHaveBeenCalledWith({
        where: { id: RESERVATION_ID },
        data: { status: 'COMPLETED', completedAt: new Date(COMPLETED_AT) },
      });
      expect(result.status).toBe('COMPLETED');
      expect(result.totals).toEqual({
        baseCollectedFils: 25_000,
        tipFils: 0,
        tipType: null,
        businessReceivedFils: 25_000,
        therapistOwedFromThisVisitFils: 0,
      });
    });

    it('records a zero amount on the audit entry rather than skipping it', async () => {
      const { handler, tx } = setup();

      await handler.checkout(RESERVATION_ID, checkoutDto(), actorFixture(), CTX);

      const { data } = tx.financialAuditLog.create.mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(data).toMatchObject({ action: 'RESERVATION_CHECKOUT', amountFils: 0 });
      expect((data.afterState as Record<string, unknown>).tip).toBeNull();
    });
  });

  describe('mode A — COLLECTED_BY_BUSINESS: the business holds it and now owes it', () => {
    const tip: CheckoutDto['tip'] = {
      amountFils: 5_000,
      type: 'COLLECTED_BY_BUSINESS',
      method: 'CARD',
      externalRef: 'TRM-88240',
    };

    it('writes a payment, a tip and a ledger accrual — all three', async () => {
      const { handler, tx } = setup();

      await handler.checkout(RESERVATION_ID, checkoutDto({ tip }), actorFixture(), CTX);

      expect(tx.payment.create).toHaveBeenCalledTimes(1);
      expect(tx.tip.create).toHaveBeenCalledTimes(1);
      expect(tx.therapistPayoutLedger.create).toHaveBeenCalledTimes(1);
    });

    it('puts the money through the till as a TIP payment with a derived key', async () => {
      const { handler, tx } = setup();

      await handler.checkout(RESERVATION_ID, checkoutDto({ tip }), actorFixture(), CTX);

      const { data } = tx.payment.create.mock.calls[0]![0] as { data: Record<string, unknown> };
      expect(data).toMatchObject({
        branchId: BRANCH_ID,
        reservationId: RESERVATION_ID,
        kind: 'TIP',
        method: 'CARD',
        amountFils: 5_000,
        collectedByUserId: USER_ID,
        externalRef: 'TRM-88240',
        idempotencyKey: '2b7c9d10-3e4f-4a5b-8c6d-1f2e3a4b5c6d:tip',
        businessDay: new Date('2026-09-16T00:00:00.000Z'),
      });
    });

    it('leaves the tip payment key null rather than colliding on "undefined"', async () => {
      const { handler, tx } = setup();

      await handler.checkout(RESERVATION_ID, checkoutDto({ tip }), actorFixture(), {
        requestId: 'req_no_key',
        branchId: BRANCH_ID,
      });

      const { data } = tx.payment.create.mock.calls[0]![0] as { data: Record<string, unknown> };
      expect(data.idempotencyKey).toBeNull();
    });

    it('links the tip row to the payment row', async () => {
      const { handler, tx } = setup();

      await handler.checkout(RESERVATION_ID, checkoutDto({ tip }), actorFixture(), CTX);

      const { data } = tx.tip.create.mock.calls[0]![0] as { data: Record<string, unknown> };
      expect(data).toMatchObject({
        type: 'COLLECTED_BY_BUSINESS',
        employeeId: EMPLOYEE_ID,
        amountFils: 5_000,
        method: 'CARD',
        paymentId: 'payment-1',
        recordedByUserId: USER_ID,
      });
    });

    it('accrues the liability: this is the only place a tip becomes payable', async () => {
      const { handler, tx } = setup();

      await handler.checkout(RESERVATION_ID, checkoutDto({ tip }), actorFixture(), CTX);

      const { data } = tx.therapistPayoutLedger.create.mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(data).toMatchObject({
        branchId: BRANCH_ID,
        employeeId: EMPLOYEE_ID,
        entryType: 'TIP_ACCRUAL',
        amountFils: 5_000, // positive: owed to the therapist
        reservationId: RESERVATION_ID,
        tipId: 'tip-1',
        createdByUserId: USER_ID,
        note: 'Tip collected by business on BR-2026-0417',
      });
    });

    it('reports the tip as money the business received and as money it owes', async () => {
      const { handler } = setup();

      const result = await handler.checkout(
        RESERVATION_ID,
        checkoutDto({ tip }),
        actorFixture(),
        CTX,
      );

      expect(result.totals).toEqual({
        baseCollectedFils: 25_000,
        tipFils: 5_000,
        tipType: 'COLLECTED_BY_BUSINESS',
        businessReceivedFils: 30_000,
        therapistOwedFromThisVisitFils: 5_000,
      });
    });

    it('adds the check-in commission to what this visit owes, straight off the ledger', async () => {
      const { handler } = setup({ existingLedgerFils: 3_750 });

      const result = await handler.checkout(
        RESERVATION_ID,
        checkoutDto({ tip }),
        actorFixture(),
        CTX,
      );

      expect(result.totals.therapistOwedFromThisVisitFils).toBe(8_750);
      // The commission never was the business's money to receive.
      expect(result.totals.businessReceivedFils).toBe(30_000);
    });
  });

  describe('mode B — DIRECT_CASH: recorded, but never owed', () => {
    const tip: CheckoutDto['tip'] = { amountFils: 5_000, type: 'DIRECT_CASH' };

    it('creates NO ledger entry: the business never held that money (§9.2)', async () => {
      const { handler, tx, ledgerRows } = setup();

      await handler.checkout(RESERVATION_ID, checkoutDto({ tip }), actorFixture(), CTX);

      expect(tx.therapistPayoutLedger.create).not.toHaveBeenCalled();
      expect(ledgerRows).toHaveLength(0);
    });

    it('creates no payment row either: no money entered the business', async () => {
      const { handler, tx } = setup();

      await handler.checkout(RESERVATION_ID, checkoutDto({ tip }), actorFixture(), CTX);

      expect(tx.payment.create).not.toHaveBeenCalled();
    });

    it('records the tip with a null method and a null paymentId', async () => {
      const { handler, tx } = setup();

      await handler.checkout(RESERVATION_ID, checkoutDto({ tip }), actorFixture(), CTX);

      const { data } = tx.tip.create.mock.calls[0]![0] as { data: Record<string, unknown> };
      expect(data).toMatchObject({
        type: 'DIRECT_CASH',
        employeeId: EMPLOYEE_ID,
        amountFils: 5_000,
        recordedByUserId: USER_ID,
      });
      expect(data.method).toBeNull();
      expect(data.paymentId).toBeNull();
    });

    it('keeps it out of business revenue and out of what the business owes', async () => {
      const { handler } = setup();

      const result = await handler.checkout(
        RESERVATION_ID,
        checkoutDto({ tip }),
        actorFixture(),
        CTX,
      );

      expect(result.totals).toEqual({
        baseCollectedFils: 25_000,
        tipFils: 5_000,
        tipType: 'DIRECT_CASH',
        // The guest's 50 dirhams went straight into the therapist's hand.
        businessReceivedFils: 25_000,
        therapistOwedFromThisVisitFils: 0,
      });
    });

    it('leaves a check-in commission owing, and adds nothing to it', async () => {
      const { handler } = setup({ existingLedgerFils: 3_750 });

      const result = await handler.checkout(
        RESERVATION_ID,
        checkoutDto({ tip }),
        actorFixture(),
        CTX,
      );

      expect(result.totals.therapistOwedFromThisVisitFils).toBe(3_750);
    });
  });

  describe('the audit trail', () => {
    it('writes RESERVATION_CHECKOUT with the tip through the same transaction', async () => {
      const { handler, tx } = setup();

      await handler.checkout(
        RESERVATION_ID,
        checkoutDto({
          tip: { amountFils: 5_000, type: 'COLLECTED_BY_BUSINESS', method: 'CARD' },
        }),
        actorFixture(),
        CTX,
      );

      expect(tx.financialAuditLog.create).toHaveBeenCalledTimes(1);
      const { data } = tx.financialAuditLog.create.mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(data).toMatchObject({
        action: 'RESERVATION_CHECKOUT',
        entityType: 'Reservation',
        entityId: RESERVATION_ID,
        amountFils: 5_000,
        requestId: 'req_01JBQ7X8',
      });
      expect((data.beforeState as Record<string, unknown>).status).toBe('IN_PROGRESS');
      expect((data.afterState as Record<string, unknown>).status).toBe('COMPLETED');
      expect((data.afterState as { tip: Record<string, unknown> }).tip).toMatchObject({
        id: 'tip-1',
        type: 'COLLECTED_BY_BUSINESS',
        amountFils: 5_000,
      });
    });

    it('writes nothing when the tip is rejected', async () => {
      const { handler, tx } = setup();

      await caught(() =>
        handler.checkout(
          RESERVATION_ID,
          checkoutDto({ tip: { amountFils: 500_000, type: 'DIRECT_CASH' } }),
          actorFixture(),
          CTX,
        ),
      );

      expect(tx.financialAuditLog.create).not.toHaveBeenCalled();
      expect(tx.reservation.update).not.toHaveBeenCalled();
      expect(tx.tip.create).not.toHaveBeenCalled();
    });
  });

  it('defaults the completion time to now when reception does not type one', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-16T20:30:00+04:00'));
    try {
      const { handler, tx } = setup();
      await handler.checkout(
        RESERVATION_ID,
        { tip: null, confirmLargeTip: false },
        actorFixture(),
        CTX,
      );
      const { data } = tx.reservation.update.mock.calls[0]![0] as { data: { completedAt: Date } };
      expect(data.completedAt).toEqual(new Date('2026-09-16T20:30:00+04:00'));
    } finally {
      jest.useRealTimers();
    }
  });
});

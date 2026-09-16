import { HttpException } from '@nestjs/common';
import type { Employee, Payment, Reservation } from '@prisma/client';
import type { ApiErrorBody, CheckInDto } from '@berelax/contracts';
import { ErrorCode, UserRole } from '@berelax/contracts';
import { AuditService } from '../common/audit.service';
import type { AuthUser, RequestContext } from '../common/request-context';
import type { PrismaService } from '../prisma/prisma.service';
import { CheckInHandler } from './check-in.handler';

/**
 * §13.2 puts the money logic at 100 % of branches. Every rejection in the §8.2
 * table has a test here, and so does every write the happy path makes.
 */

const RESERVATION_ID = '0192f8a1-0000-7000-8000-000000000001';
const BRANCH_ID = '0192bbbb-0000-7000-8000-00000000000b';
const EMPLOYEE_ID = '0192cccc-0000-7000-8000-00000000000c';
const USER_ID = '0192dddd-0000-7000-8000-00000000000d';

/** 19:00 Dubai, 16 September 2026. */
const STARTS_AT = new Date('2026-09-16T19:00:00+04:00');

function reservationFixture(overrides: Partial<Reservation> = {}): Reservation {
  return {
    id: RESERVATION_ID,
    ref: 'BR-2026-0417',
    branchId: BRANCH_ID,
    guestId: null,
    employeeId: EMPLOYEE_ID,
    roomId: null,
    serviceId: '0192eeee-0000-7000-8000-00000000000e',
    startsAt: STARTS_AT,
    durationMinutes: 60,
    endsAt: new Date('2026-09-16T20:00:00+04:00'),
    blockedUntil: new Date('2026-09-16T20:15:00+04:00'),
    businessDay: new Date('2026-09-16T00:00:00.000Z'),
    status: 'SCHEDULED',
    baseCostFils: 25_000,
    sourceChannel: 'WALK_IN',
    attributionId: null,
    actualArrivalAt: null,
    completedAt: null,
    cancelledAt: null,
    cancellationReason: null,
    notes: null,
    createdByUserId: USER_ID,
    createdAt: new Date('2026-09-10T08:00:00.000Z'),
    updatedAt: new Date('2026-09-10T08:00:00.000Z'),
    ...overrides,
  };
}

function employeeFixture(commissionBps: number): Employee {
  return {
    id: EMPLOYEE_ID,
    branchId: BRANCH_ID,
    displayName: 'Layla',
    legalName: null,
    phone: null,
    status: 'ACTIVE',
    commissionBps,
    hiredOn: null,
    photoUrl: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    deletedAt: null,
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
  idempotencyKey: '8f14e45f-ea3b-4f2c-9a1d-7c9b2e5a0d33',
};

function splitPayment(): CheckInDto {
  return {
    actualArrivalAt: '2026-09-16T19:04:00+04:00',
    basePayments: [
      { method: 'CARD', amountFils: 20_000, externalRef: 'TRM-88213' },
      { method: 'CASH', amountFils: 5_000 },
    ],
    note: 'Guest paid AED 50 cash, rest on card',
  };
}

type Tx = {
  $queryRaw: jest.Mock;
  reservation: { findUniqueOrThrow: jest.Mock; update: jest.Mock };
  payment: { createManyAndReturn: jest.Mock };
  employee: { findUniqueOrThrow: jest.Mock };
  therapistPayoutLedger: { create: jest.Mock };
  financialAuditLog: { create: jest.Mock };
};

function setup(options: { reservation?: Reservation; commissionBps?: number; found?: boolean } = {}) {
  const reservation = options.reservation ?? reservationFixture();

  const tx: Tx = {
    $queryRaw: jest.fn().mockResolvedValue(options.found === false ? [] : [{ id: reservation.id }]),
    reservation: {
      findUniqueOrThrow: jest.fn().mockResolvedValue(reservation),
      update: jest.fn(async ({ data }: { data: Partial<Reservation> }) =>
        reservationFixture({ ...reservation, ...data }),
      ),
    },
    payment: {
      createManyAndReturn: jest.fn(async ({ data }: { data: Payment[] }) =>
        data.map((row, i) => ({ ...row, id: `pay-${i}` })),
      ),
    },
    employee: {
      findUniqueOrThrow: jest.fn().mockResolvedValue(employeeFixture(options.commissionBps ?? 0)),
    },
    therapistPayoutLedger: { create: jest.fn().mockResolvedValue({}) },
    financialAuditLog: { create: jest.fn().mockResolvedValue({}) },
  };

  const prisma = {
    $transaction: jest.fn(async (cb: (client: Tx) => Promise<unknown>) => cb(tx)),
  } as unknown as PrismaService;

  // The real AuditService, so "the audit row goes through the same tx" is
  // asserted rather than assumed.
  return { tx, handler: new CheckInHandler(prisma, new AuditService()), reservation };
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

describe('CheckInHandler — step 1 of the two-step financial workflow', () => {
  describe('rejections', () => {
    it('404s when no such booking exists in this branch', async () => {
      const { handler, tx } = setup({ found: false });

      const { status, body } = await caught(() =>
        handler.checkIn(RESERVATION_ID, splitPayment(), actorFixture(), CTX),
      );

      expect(status).toBe(404);
      expect(body.error.code).toBe(ErrorCode.RESERVATION_NOT_FOUND);
      expect(tx.payment.createManyAndReturn).not.toHaveBeenCalled();
    });

    it('locks the row before reading it, so two receptionists serialise', async () => {
      const { handler, tx } = setup();
      await handler.checkIn(RESERVATION_ID, splitPayment(), actorFixture(), CTX);

      const sql = (tx.$queryRaw.mock.calls[0]![0] as string[]).join('?');
      expect(sql).toContain('FOR UPDATE');
      expect(sql).toContain('branch_id');
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('409s when the booking is not SCHEDULED, naming the status it is in', async () => {
      const { handler } = setup({ reservation: reservationFixture({ status: 'IN_PROGRESS' }) });

      const { status, body } = await caught(() =>
        handler.checkIn(RESERVATION_ID, splitPayment(), actorFixture(), CTX),
      );

      expect(status).toBe(409);
      expect(body.error.code).toBe(ErrorCode.RESERVATION_NOT_SCHEDULED);
      expect(body.error.details).toEqual({ status: 'IN_PROGRESS' });
    });

    it('422s a non-positive line before the total is compared', async () => {
      const { handler, tx } = setup();
      // These two sum to exactly 25 000 — the negative line would reconcile a
      // short payment if the amounts were not checked first.
      const dto: CheckInDto = {
        basePayments: [
          { method: 'CARD', amountFils: 30_000 },
          { method: 'CASH', amountFils: -5_000 },
        ],
        actualArrivalAt: '2026-09-16T19:04:00+04:00',
      };

      const { status, body } = await caught(() =>
        handler.checkIn(RESERVATION_ID, dto, actorFixture(), CTX),
      );

      expect(status).toBe(422);
      expect(body.error.code).toBe(ErrorCode.INVALID_AMOUNT);
      expect(body.error.details).toEqual({ line: 1 });
      expect(tx.payment.createManyAndReturn).not.toHaveBeenCalled();
    });

    it('422s a fractional amount: money is an integer number of fils', async () => {
      const { handler } = setup();
      const dto: CheckInDto = {
        basePayments: [{ method: 'CASH', amountFils: 25_000.5 }],
      };

      const { body } = await caught(() => handler.checkIn(RESERVATION_ID, dto, actorFixture(), CTX));
      expect(body.error.code).toBe(ErrorCode.INVALID_AMOUNT);
    });

    it('403s a RECEPTIONIST trying to comp a treatment', async () => {
      const { handler, tx } = setup();
      const dto: CheckInDto = { basePayments: [{ method: 'COMPLIMENTARY', amountFils: 25_000 }] };

      const { status, body } = await caught(() =>
        handler.checkIn(RESERVATION_ID, dto, actorFixture(UserRole.RECEPTIONIST), CTX),
      );

      expect(status).toBe(403);
      expect(body.error.code).toBe(ErrorCode.INSUFFICIENT_ROLE);
      expect(tx.payment.createManyAndReturn).not.toHaveBeenCalled();
    });

    it('422s a MANAGER comping only part of the bill', async () => {
      const { handler } = setup();
      const dto: CheckInDto = {
        basePayments: [
          { method: 'COMPLIMENTARY', amountFils: 20_000 },
          { method: 'CASH', amountFils: 5_000 },
        ],
      };

      const { status, body } = await caught(() =>
        handler.checkIn(RESERVATION_ID, dto, actorFixture(UserRole.MANAGER), CTX),
      );

      expect(status).toBe(422);
      expect(body.error.message).toMatch(/only line/i);
    });

    it('422s when the collected total does not reconcile, with both figures', async () => {
      const { handler, tx } = setup();
      const dto: CheckInDto = { basePayments: [{ method: 'CASH', amountFils: 20_000 }] };

      const { status, body } = await caught(() =>
        handler.checkIn(RESERVATION_ID, dto, actorFixture(), CTX),
      );

      expect(status).toBe(422);
      expect(body.error.code).toBe(ErrorCode.BASE_PAYMENT_MISMATCH);
      expect(body.error.details).toEqual({ expectedFils: 25_000, receivedFils: 20_000 });
      expect(body.error.message).toContain('200.00');
      expect(body.error.message).toContain('250.00');
      expect(tx.payment.createManyAndReturn).not.toHaveBeenCalled();
    });

    it('422s an over-collection just as firmly as a short payment', async () => {
      const { handler } = setup();
      const dto: CheckInDto = { basePayments: [{ method: 'CASH', amountFils: 30_000 }] };

      const { body } = await caught(() => handler.checkIn(RESERVATION_ID, dto, actorFixture(), CTX));
      expect(body.error.code).toBe(ErrorCode.BASE_PAYMENT_MISMATCH);
      expect(body.error.details).toMatchObject({ receivedFils: 30_000 });
    });

    it.each([
      ['thirteen hours late', '2026-09-17T08:00:00+04:00'],
      ['thirteen hours early', '2026-09-16T06:00:00+04:00'],
    ])('422s an arrival %s', async (_label, actualArrivalAt) => {
      const { handler } = setup();

      const { status, body } = await caught(() =>
        handler.checkIn(
          RESERVATION_ID,
          { ...splitPayment(), actualArrivalAt },
          actorFixture(),
          CTX,
        ),
      );

      expect(status).toBe(422);
      expect(body.error.code).toBe(ErrorCode.ARRIVAL_TIME_IMPLAUSIBLE);
      expect(body.error.details).toMatchObject({ windowHours: 12 });
    });

    it('accepts an arrival one minute inside the window', async () => {
      const { handler, tx } = setup();

      await handler.checkIn(
        RESERVATION_ID,
        { ...splitPayment(), actualArrivalAt: '2026-09-17T06:59:00+04:00' },
        actorFixture(),
        CTX,
      );

      expect(tx.reservation.update).toHaveBeenCalled();
    });
  });

  describe('the happy path', () => {
    it('writes one payment row per line, each with its own derived idempotency key', async () => {
      const { handler, tx } = setup();

      const result = await handler.checkIn(RESERVATION_ID, splitPayment(), actorFixture(), CTX);

      const { data } = tx.payment.createManyAndReturn.mock.calls[0]![0] as { data: Payment[] };
      expect(data).toHaveLength(2);
      expect(data.map((p) => p.idempotencyKey)).toEqual([
        '8f14e45f-ea3b-4f2c-9a1d-7c9b2e5a0d33:base:0',
        '8f14e45f-ea3b-4f2c-9a1d-7c9b2e5a0d33:base:1',
      ]);
      expect(data.every((p) => p.kind === 'BASE')).toBe(true);
      expect(data.every((p) => p.branchId === BRANCH_ID)).toBe(true);
      expect(data.every((p) => p.collectedByUserId === USER_ID)).toBe(true);
      expect(data[0]!.externalRef).toBe('TRM-88213');
      expect(data[1]!.externalRef).toBeNull();
      expect(result.basePaidFils).toBe(25_000);
      expect(result.payments).toHaveLength(2);
    });

    it('leaves the idempotency key null rather than colliding on the literal "undefined"', async () => {
      const { handler, tx } = setup();

      await handler.checkIn(RESERVATION_ID, splitPayment(), actorFixture(), {
        requestId: 'req_no_key',
        branchId: BRANCH_ID,
      });

      const { data } = tx.payment.createManyAndReturn.mock.calls[0]![0] as { data: Payment[] };
      expect(data.map((p) => p.idempotencyKey)).toEqual([null, null]);
    });

    it('moves the booking to IN_PROGRESS and stamps the arrival', async () => {
      const { handler, tx } = setup();

      const result = await handler.checkIn(RESERVATION_ID, splitPayment(), actorFixture(), CTX);

      expect(tx.reservation.update).toHaveBeenCalledWith({
        where: { id: RESERVATION_ID },
        data: {
          status: 'IN_PROGRESS',
          actualArrivalAt: new Date('2026-09-16T19:04:00+04:00'),
        },
      });
      expect(result.status).toBe('IN_PROGRESS');
      expect(result.ref).toBe('BR-2026-0417');
    });

    it('defaults the arrival to now when reception does not type one', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-09-16T19:06:00+04:00'));
      try {
        const { handler, tx } = setup();
        await handler.checkIn(
          RESERVATION_ID,
          { basePayments: [{ method: 'CASH', amountFils: 25_000 }] },
          actorFixture(),
          CTX,
        );
        const { data } = tx.reservation.update.mock.calls[0]![0] as {
          data: { actualArrivalAt: Date };
        };
        expect(data.actualArrivalAt).toEqual(new Date('2026-09-16T19:06:00+04:00'));
      } finally {
        jest.useRealTimers();
      }
    });

    it('books the money against the trading day of the ARRIVAL, not the booking', async () => {
      // Booked for 20:00 on the 16th; the guest turns up at 07:30 the next
      // morning, which is the 17th's trading day. §3.3.
      const { handler, tx } = setup({
        reservation: reservationFixture({ startsAt: new Date('2026-09-16T20:00:00+04:00') }),
      });

      await handler.checkIn(
        RESERVATION_ID,
        { ...splitPayment(), actualArrivalAt: '2026-09-17T07:30:00+04:00' },
        actorFixture(),
        CTX,
      );

      const { data } = tx.payment.createManyAndReturn.mock.calls[0]![0] as { data: Payment[] };
      expect(data[0]!.businessDay).toEqual(new Date('2026-09-17T00:00:00.000Z'));
    });
  });

  describe('the commission accrual', () => {
    it('accrues the therapist their basis points of the base service', async () => {
      const { handler, tx } = setup({ commissionBps: 1_500 });

      await handler.checkIn(RESERVATION_ID, splitPayment(), actorFixture(), CTX);

      expect(tx.therapistPayoutLedger.create).toHaveBeenCalledTimes(1);
      const { data } = tx.therapistPayoutLedger.create.mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(data).toMatchObject({
        branchId: BRANCH_ID,
        employeeId: EMPLOYEE_ID,
        entryType: 'COMMISSION_ACCRUAL',
        amountFils: 3_750, // 15 % of 25 000, to the nearest fils
        reservationId: RESERVATION_ID,
        createdByUserId: USER_ID,
        note: 'Commission 15% on BR-2026-0417',
      });
    });

    it('rounds to the nearest fils rather than carrying a fraction', async () => {
      const { handler, tx } = setup({
        reservation: reservationFixture({ baseCostFils: 24_999 }),
        commissionBps: 1_250,
      });

      await handler.checkIn(
        RESERVATION_ID,
        { basePayments: [{ method: 'CARD', amountFils: 24_999 }] },
        actorFixture(),
        CTX,
      );

      const { data } = tx.therapistPayoutLedger.create.mock.calls[0]![0] as {
        data: { amountFils: number };
      };
      expect(data.amountFils).toBe(3_125); // 24 999 x 0.125 = 3 124.875
      expect(Number.isInteger(data.amountFils)).toBe(true);
    });

    it('writes no ledger row for a therapist who is not on commission', async () => {
      const { handler, tx } = setup({ commissionBps: 0 });

      await handler.checkIn(RESERVATION_ID, splitPayment(), actorFixture(), CTX);

      expect(tx.therapistPayoutLedger.create).not.toHaveBeenCalled();
    });

    it('still accrues on a comped treatment: the therapist did the hour', async () => {
      const { handler, tx } = setup({ commissionBps: 1_000 });

      await handler.checkIn(
        RESERVATION_ID,
        { basePayments: [{ method: 'COMPLIMENTARY', amountFils: 25_000 }] },
        actorFixture(UserRole.MANAGER),
        CTX,
      );

      const { data } = tx.therapistPayoutLedger.create.mock.calls[0]![0] as {
        data: { amountFils: number };
      };
      expect(data.amountFils).toBe(2_500);
    });
  });

  describe('the audit trail', () => {
    it('writes RESERVATION_CHECK_IN through the same transaction as the money', async () => {
      const { handler, tx } = setup();

      await handler.checkIn(RESERVATION_ID, splitPayment(), actorFixture(), CTX);

      expect(tx.financialAuditLog.create).toHaveBeenCalledTimes(1);
      const { data } = tx.financialAuditLog.create.mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(data).toMatchObject({
        action: 'RESERVATION_CHECK_IN',
        entityType: 'Reservation',
        entityId: RESERVATION_ID,
        amountFils: 25_000,
        requestId: 'req_01JBQ7X8',
        actorUserId: USER_ID,
      });
      expect((data.beforeState as Record<string, unknown>).status).toBe('SCHEDULED');
      expect((data.afterState as Record<string, unknown>).status).toBe('IN_PROGRESS');
    });

    it('writes nothing at all when a validation rule rejects the request', async () => {
      const { handler, tx } = setup();

      await caught(() =>
        handler.checkIn(
          RESERVATION_ID,
          { basePayments: [{ method: 'CASH', amountFils: 1 }] },
          actorFixture(),
          CTX,
        ),
      );

      expect(tx.financialAuditLog.create).not.toHaveBeenCalled();
      expect(tx.reservation.update).not.toHaveBeenCalled();
      expect(tx.therapistPayoutLedger.create).not.toHaveBeenCalled();
    });
  });
});

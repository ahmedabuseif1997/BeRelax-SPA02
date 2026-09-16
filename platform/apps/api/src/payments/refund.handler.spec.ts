import { HttpException } from '@nestjs/common';
import type { Payment, Reservation } from '@prisma/client';
import type { ApiErrorBody, CreateAdjustmentDto, RefundPaymentDto } from '@berelax/contracts';
import { ErrorCode, UserRole } from '@berelax/contracts';
import { AuditService } from '../common/audit.service';
import type { AuthUser, RequestContext } from '../common/request-context';
import type { PrismaService } from '../prisma/prisma.service';
import { RefundHandler } from './refund.handler';

/**
 * §13.2 puts the money logic at 100 % of branches, and the branch that matters
 * most here is the one that decides how much is still refundable. Get it wrong
 * in the generous direction and a guest can be refunded twice for the same
 * payment; get it wrong in the mean direction and a manager cannot finish a
 * refund the guest is standing there waiting for.
 *
 * Every assertion below also checks that the ORIGINAL row was never touched:
 * `payments` is append-only and there is no `update` anywhere in the handler,
 * which is the property these tests exist to keep true.
 */

const PAYMENT_ID = '0192aaaa-0000-7000-8000-00000000000a';
const RESERVATION_ID = '0192f8a1-0000-7000-8000-000000000001';
const BRANCH_ID = '0192bbbb-0000-7000-8000-00000000000b';
const USER_ID = '0192dddd-0000-7000-8000-00000000000d';

function paymentFixture(overrides: Partial<Payment> = {}): Payment {
  return {
    id: PAYMENT_ID,
    branchId: BRANCH_ID,
    reservationId: RESERVATION_ID,
    kind: 'BASE',
    method: 'CARD',
    amountFils: 25_000,
    businessDay: new Date('2026-09-16T00:00:00.000Z'),
    collectedByUserId: USER_ID,
    collectedAt: new Date('2026-09-16T15:04:00.000Z'),
    createdAt: new Date('2026-09-16T15:04:00.000Z'),
    externalRef: 'TRM-88213',
    reversesPaymentId: null,
    note: null,
    idempotencyKey: 'check-in-key:base:0',
    ...overrides,
  };
}

function reservationFixture(overrides: Partial<Reservation> = {}): Reservation {
  return {
    id: RESERVATION_ID,
    ref: 'BR-2026-0417',
    branchId: BRANCH_ID,
    guestId: null,
    employeeId: '0192cccc-0000-7000-8000-00000000000c',
    roomId: null,
    serviceId: '0192eeee-0000-7000-8000-00000000000e',
    startsAt: new Date('2026-09-16T15:00:00.000Z'),
    durationMinutes: 60,
    endsAt: new Date('2026-09-16T16:00:00.000Z'),
    blockedUntil: new Date('2026-09-16T16:15:00.000Z'),
    businessDay: new Date('2026-09-16T00:00:00.000Z'),
    status: 'COMPLETED',
    baseCostFils: 25_000,
    sourceChannel: 'WALK_IN',
    attributionId: null,
    actualArrivalAt: new Date('2026-09-16T15:04:00.000Z'),
    completedAt: new Date('2026-09-16T16:12:00.000Z'),
    cancelledAt: null,
    cancellationReason: null,
    notes: null,
    createdByUserId: USER_ID,
    createdAt: new Date('2026-09-10T08:00:00.000Z'),
    updatedAt: new Date('2026-09-16T16:12:00.000Z'),
    ...overrides,
  };
}

function actorFixture(role: UserRole = UserRole.MANAGER): AuthUser {
  return {
    id: USER_ID,
    role,
    branchId: BRANCH_ID,
    email: 'manager@berelax.ae',
    fullName: 'Manager',
  };
}

const CTX: RequestContext = {
  requestId: 'req_01JBQ7X8',
  branchId: BRANCH_ID,
  actorUserId: USER_ID,
  actorRole: UserRole.MANAGER,
  idempotencyKey: 'a1b2c3d4-0000-4000-8000-000000000001',
};

type Tx = {
  $queryRaw: jest.Mock;
  payment: { findUniqueOrThrow: jest.Mock; aggregate: jest.Mock; create: jest.Mock };
  reservation: { findUniqueOrThrow: jest.Mock };
  financialAuditLog: { create: jest.Mock };
};

function setup(
  options: {
    payment?: Payment;
    reservation?: Reservation;
    /** Already refunded against the original, as the negative sum Postgres returns. */
    refundedSum?: number | null;
    /** The settlement total for the booking; null stands for "no rows at all". */
    settledFils?: number | null;
    found?: boolean;
  } = {},
) {
  const payment = options.payment ?? paymentFixture();
  const reservation = options.reservation ?? reservationFixture();
  const created: Record<string, unknown>[] = [];

  const tx: Tx = {
    $queryRaw: jest.fn().mockResolvedValue(options.found === false ? [] : [{ id: payment.id }]),
    payment: {
      findUniqueOrThrow: jest.fn().mockResolvedValue(payment),
      // Two different sums are asked of this table: what has already been
      // refunded against the original, and what the booking has collected in
      // total. They are told apart by their filter, exactly as Postgres does.
      aggregate: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        where.reversesPaymentId
          ? { _sum: { amountFils: options.refundedSum ?? null } }
          : {
              _sum: {
                amountFils:
                  options.settledFils === undefined ? reservation.baseCostFils : options.settledFils,
              },
            },
      ),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { ...paymentFixture(), ...data, id: `payment-${created.length}` };
      }),
    },
    reservation: { findUniqueOrThrow: jest.fn().mockResolvedValue(reservation) },
    financialAuditLog: { create: jest.fn().mockResolvedValue({}) },
  };

  const prisma = {
    $transaction: jest.fn(async (cb: (client: Tx) => Promise<unknown>) => cb(tx)),
  } as unknown as PrismaService;

  return { tx, created, handler: new RefundHandler(prisma, new AuditService()) };
}

function refundDto(overrides: Partial<RefundPaymentDto> = {}): RefundPaymentDto {
  return { reason: 'Guest was charged for the 90 minute treatment', ...overrides };
}

function adjustmentDto(overrides: Partial<CreateAdjustmentDto> = {}): CreateAdjustmentDto {
  return {
    reservationId: RESERVATION_ID,
    amountFils: -5_000,
    method: 'CASH',
    reason: 'Manager discount, late start',
    ...overrides,
  };
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

describe('RefundHandler — refunds', () => {
  describe('rejections', () => {
    it('404s when no such payment exists in this branch', async () => {
      const { handler, tx } = setup({ found: false });

      const { status, body } = await caught(() =>
        handler.refund(PAYMENT_ID, refundDto(), actorFixture(), CTX),
      );

      expect(status).toBe(404);
      expect(body.error.code).toBe(ErrorCode.PAYMENT_NOT_FOUND);
      expect(tx.payment.create).not.toHaveBeenCalled();
    });

    it('locks the original row for update before reading it', async () => {
      const { handler, tx } = setup();
      await handler.refund(PAYMENT_ID, refundDto(), actorFixture(), CTX);

      expect((tx.$queryRaw.mock.calls[0]![0] as string[]).join('?')).toContain('FOR UPDATE');
    });

    it('422s an attempt to refund a REFUND row', async () => {
      const { handler, tx } = setup({
        payment: paymentFixture({ kind: 'REFUND', amountFils: -5_000, reversesPaymentId: 'x' }),
      });

      const { status, body } = await caught(() =>
        handler.refund(PAYMENT_ID, refundDto(), actorFixture(), CTX),
      );

      expect(status).toBe(422);
      expect(body.error.code).toBe(ErrorCode.PAYMENT_NOT_REFUNDABLE);
      expect(tx.payment.create).not.toHaveBeenCalled();
    });

    it('409s a payment that has already been refunded in full', async () => {
      const { handler, tx } = setup({ refundedSum: -25_000 });

      const { status, body } = await caught(() =>
        handler.refund(PAYMENT_ID, refundDto(), actorFixture(), CTX),
      );

      expect(status).toBe(409);
      expect(body.error.code).toBe(ErrorCode.PAYMENT_ALREADY_REFUNDED);
      expect(body.error.details).toEqual({
        paymentId: PAYMENT_ID,
        amountFils: 25_000,
        refundedFils: 25_000,
      });
      expect(tx.payment.create).not.toHaveBeenCalled();
    });

    it('422s a refund larger than what is left, naming what is left', async () => {
      const { handler, tx } = setup({ refundedSum: -20_000 });

      const { status, body } = await caught(() =>
        handler.refund(PAYMENT_ID, refundDto({ amountFils: 10_000 }), actorFixture(), CTX),
      );

      expect(status).toBe(422);
      expect(body.error.code).toBe(ErrorCode.REFUND_EXCEEDS_PAYMENT);
      expect(body.error.details).toEqual({
        paymentId: PAYMENT_ID,
        requestedFils: 10_000,
        originalFils: 25_000,
        refundedFils: 20_000,
        refundableFils: 5_000,
      });
      expect(tx.payment.create).not.toHaveBeenCalled();
    });
  });

  describe('the refund row', () => {
    it('refunds the whole payment when no amount is given', async () => {
      const { handler, created } = setup();

      const view = await handler.refund(PAYMENT_ID, refundDto(), actorFixture(), CTX);

      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({
        kind: 'REFUND',
        amountFils: -25_000, // negative: signed, so SUM() is the net position
        reversesPaymentId: PAYMENT_ID,
        method: 'CARD', // back the way it came in
        note: 'Guest was charged for the 90 minute treatment',
        idempotencyKey: `${CTX.idempotencyKey}:refund`,
      });
      expect(view.original.refundableFils).toBe(0);
      expect(view.original.refundedFils).toBe(25_000);
    });

    it('refunds part of a payment, leaving the rest refundable', async () => {
      const { handler, created } = setup({ refundedSum: -5_000 });

      const view = await handler.refund(
        PAYMENT_ID,
        refundDto({ amountFils: 10_000 }),
        actorFixture(),
        CTX,
      );

      expect(created[0]).toMatchObject({ amountFils: -10_000 });
      expect(view.original.refundedFils).toBe(15_000);
      expect(view.original.refundableFils).toBe(10_000);
    });

    it('lets a manager send the money back by another method, with a slip number', async () => {
      const { handler, created } = setup();

      await handler.refund(
        PAYMENT_ID,
        refundDto({ method: 'CASH', externalRef: 'TILL-0042' }),
        actorFixture(UserRole.OWNER),
        CTX,
      );

      expect(created[0]).toMatchObject({ method: 'CASH', externalRef: 'TILL-0042' });
    });

    it('never updates or deletes the original — there is no such call to make', async () => {
      const { handler, tx } = setup();
      await handler.refund(PAYMENT_ID, refundDto(), actorFixture(), CTX);

      // `payments` is append-only and the database enforces it (§5.4). The
      // handler is given no update or delete delegate at all here, so a future
      // edit that reached for one would fail this suite before it reached CI.
      expect(tx.payment).not.toHaveProperty('update');
      expect(tx.payment).not.toHaveProperty('delete');
    });

    it('writes the audit row on the same transaction, against the booking', async () => {
      const { handler, tx } = setup();
      await handler.refund(PAYMENT_ID, refundDto(), actorFixture(), CTX);

      expect(tx.financialAuditLog.create).toHaveBeenCalledTimes(1);
      const { data } = tx.financialAuditLog.create.mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(data).toMatchObject({
        action: 'PAYMENT_REFUNDED',
        entityType: 'Reservation',
        entityId: RESERVATION_ID,
        amountFils: -25_000,
        requestId: CTX.requestId,
        actorUserId: USER_ID,
      });
      expect(data.beforeState).toMatchObject({ id: PAYMENT_ID, amountFils: 25_000 });
      expect(data.afterState).toMatchObject({
        reversesPaymentId: PAYMENT_ID,
        reason: 'Guest was charged for the 90 minute treatment',
        reservationRef: 'BR-2026-0417',
      });
    });

    it('records no idempotency key when the request carried none', async () => {
      const { handler, created } = setup();
      const { idempotencyKey: _dropped, ...ctxWithoutKey } = CTX;

      await handler.refund(PAYMENT_ID, refundDto(), actorFixture(), ctxWithoutKey);

      expect(created[0]).toMatchObject({ idempotencyKey: null });
    });

    it('reports the booking’s net position, reading zero when nothing is collected', async () => {
      const { handler } = setup({ settledFils: null });

      const view = await handler.refund(PAYMENT_ID, refundDto(), actorFixture(), CTX);

      expect(view.reservation).toEqual({
        id: RESERVATION_ID,
        ref: 'BR-2026-0417',
        baseCostFils: 25_000,
        netCollectedFils: 0,
      });
      expect(view.refund.reversesPaymentId).toBe(PAYMENT_ID);
      expect(view.refund.businessDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });
});

describe('RefundHandler — adjustments', () => {
  it('404s when the booking is not in this branch', async () => {
    const { handler, tx } = setup({ found: false });

    const { status, body } = await caught(() =>
      handler.adjust(adjustmentDto(), actorFixture(), CTX),
    );

    expect(status).toBe(404);
    expect(body.error.code).toBe(ErrorCode.RESERVATION_NOT_FOUND);
    expect(tx.payment.create).not.toHaveBeenCalled();
  });

  it('422s an adjustment of zero rather than recording nothing', async () => {
    const { handler, tx } = setup();

    const { status, body } = await caught(() =>
      handler.adjust(adjustmentDto({ amountFils: 0 }), actorFixture(), CTX),
    );

    expect(status).toBe(422);
    expect(body.error.code).toBe(ErrorCode.INVALID_AMOUNT);
    expect(tx.payment.create).not.toHaveBeenCalled();
  });

  it('records a discount as a negative ADJUSTMENT carrying its reason', async () => {
    const { handler, created } = setup({ settledFils: 20_000 });

    const view = await handler.adjust(adjustmentDto(), actorFixture(), CTX);

    expect(created[0]).toMatchObject({
      kind: 'ADJUSTMENT',
      amountFils: -5_000,
      method: 'CASH',
      note: 'Manager discount, late start',
      reservationId: RESERVATION_ID,
      idempotencyKey: `${CTX.idempotencyKey}:adjustment`,
      externalRef: null,
    });
    expect(view.adjustment.amountFils).toBe(-5_000);
    expect(view.reservation.netCollectedFils).toBe(20_000);
  });

  it('records a correction in the other direction just as happily', async () => {
    const { handler, created } = setup({ settledFils: 30_000 });
    const { idempotencyKey: _dropped, ...ctxWithoutKey } = CTX;

    await handler.adjust(
      adjustmentDto({ amountFils: 5_000, externalRef: 'TRM-88301' }),
      actorFixture(UserRole.OWNER),
      ctxWithoutKey,
    );

    expect(created[0]).toMatchObject({
      amountFils: 5_000,
      externalRef: 'TRM-88301',
      idempotencyKey: null,
    });
  });

  it('audits the adjustment against the booking, with the amount signed', async () => {
    const { handler, tx } = setup();
    await handler.adjust(adjustmentDto(), actorFixture(), CTX);

    const { data } = tx.financialAuditLog.create.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    expect(data).toMatchObject({
      action: 'PAYMENT_ADJUSTED',
      entityType: 'Reservation',
      entityId: RESERVATION_ID,
      amountFils: -5_000,
    });
    expect(data.afterState).toMatchObject({ reason: 'Manager discount, late start' });
  });
});

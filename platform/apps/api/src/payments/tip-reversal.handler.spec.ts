import { HttpException } from '@nestjs/common';
import type { TherapistPayoutLedger, Tip } from '@prisma/client';
import type { ApiErrorBody } from '@berelax/contracts';
import { ErrorCode, UserRole } from '@berelax/contracts';
import { AuditService } from '../common/audit.service';
import type { AuthUser, RequestContext } from '../common/request-context';
import type { PrismaService } from '../prisma/prisma.service';
import { TipReversalHandler } from './tip-reversal.handler';

/**
 * §9.4, and the two modes of §9.1 all over again: reversing a tip the business
 * COLLECTED moves money and cancels a liability; reversing cash the guest handed
 * straight to the therapist moves nothing and cancels nothing. Both are tested
 * here, and the DIRECT_CASH case asserts the ABSENCE of a payment row and of a
 * ledger entry explicitly — conflating the two is how a spa pays a tip twice.
 */

const TIP_ID = '0192aaaa-0000-7000-8000-0000000000a1';
const PAYMENT_ID = '0192aaaa-0000-7000-8000-0000000000a2';
const ACCRUAL_ID = '0192aaaa-0000-7000-8000-0000000000a3';
const BATCH_ID = '0192aaaa-0000-7000-8000-0000000000a4';
const RESERVATION_ID = '0192f8a1-0000-7000-8000-000000000001';
const BRANCH_ID = '0192bbbb-0000-7000-8000-00000000000b';
const EMPLOYEE_ID = '0192cccc-0000-7000-8000-00000000000c';
const USER_ID = '0192dddd-0000-7000-8000-00000000000d';

function tipFixture(overrides: Partial<Tip> = {}): Tip {
  return {
    id: TIP_ID,
    branchId: BRANCH_ID,
    reservationId: RESERVATION_ID,
    employeeId: EMPLOYEE_ID,
    type: 'COLLECTED_BY_BUSINESS',
    amountFils: 5_000,
    method: 'CARD',
    paymentId: PAYMENT_ID,
    businessDay: new Date('2026-09-16T00:00:00.000Z'),
    recordedByUserId: USER_ID,
    recordedAt: new Date('2026-09-16T16:12:00.000Z'),
    reversedByTipId: null,
    note: null,
    ...overrides,
  };
}

function directCashTip(overrides: Partial<Tip> = {}): Tip {
  return tipFixture({ type: 'DIRECT_CASH', method: null, paymentId: null, ...overrides });
}

function accrualFixture(overrides: Partial<TherapistPayoutLedger> = {}): TherapistPayoutLedger {
  return {
    id: ACCRUAL_ID,
    branchId: BRANCH_ID,
    employeeId: EMPLOYEE_ID,
    entryType: 'TIP_ACCRUAL',
    amountFils: 5_000,
    businessDay: new Date('2026-09-16T00:00:00.000Z'),
    reservationId: RESERVATION_ID,
    tipId: TIP_ID,
    payoutBatchId: null,
    reversesEntryId: null,
    createdByUserId: USER_ID,
    createdAt: new Date('2026-09-16T16:12:00.000Z'),
    note: 'Tip collected by business on BR-2026-0417',
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
  idempotencyKey: 'a1b2c3d4-0000-4000-8000-000000000002',
};

const REASON = 'Reception typed 500 where the guest gave 50';

type LedgerRow = {
  entryType: string;
  amountFils: number;
  tipId?: string | null;
  reversesEntryId?: string | null;
};

type Tx = {
  $queryRaw: jest.Mock;
  tip: { findUniqueOrThrow: jest.Mock; create: jest.Mock; update: jest.Mock };
  payment: { create: jest.Mock };
  therapistPayoutLedger: { findFirstOrThrow: jest.Mock; create: jest.Mock; aggregate: jest.Mock };
  financialAuditLog: { create: jest.Mock };
};

function setup(
  options: {
    tip?: Tip;
    accrual?: TherapistPayoutLedger;
    /** The employee's ledger balance before the reversal; null stands for "no rows". */
    balanceBeforeFils?: number | null;
    found?: boolean;
  } = {},
) {
  const tip = options.tip ?? tipFixture();
  const accrual = options.accrual ?? accrualFixture();
  const before = options.balanceBeforeFils === undefined ? 5_000 : options.balanceBeforeFils;
  const ledgerRows: LedgerRow[] = [];
  const payments: Record<string, unknown>[] = [];
  const tips: Record<string, unknown>[] = [];

  const tx: Tx = {
    // Two statements take locks here: the tip, then its accrual. They are told
    // apart by the table they name, which is also what a reader of the handler
    // sees.
    $queryRaw: jest.fn(async (strings: string[]) => {
      const sql = strings.join('?');
      if (sql.includes('FROM tips')) return options.found === false ? [] : [{ id: tip.id }];
      return [{ id: accrual.id }];
    }),
    tip: {
      findUniqueOrThrow: jest.fn().mockResolvedValue(tip),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        tips.push(data);
        return { ...tipFixture(), ...data, id: 'tip-reversal-1' };
      }),
      update: jest.fn(async ({ data }: { data: Partial<Tip> }) => ({ ...tip, ...data })),
    },
    payment: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        payments.push(data);
        return { ...data, id: 'payment-refund-1' };
      }),
    },
    therapistPayoutLedger: {
      findFirstOrThrow: jest.fn().mockResolvedValue(accrual),
      create: jest.fn(async ({ data }: { data: LedgerRow }) => {
        ledgerRows.push(data);
        return { ...data, id: `ledger-${ledgerRows.length}` };
      }),
      // The balance is SUM(amount_fils) over what exists, and Postgres answers
      // NULL over zero rows.
      aggregate: jest.fn(async () => {
        const written = ledgerRows.reduce((sum, row) => sum + row.amountFils, 0);
        if (before === null && ledgerRows.length === 0) return { _sum: { amountFils: null } };
        return { _sum: { amountFils: (before ?? 0) + written } };
      }),
    },
    financialAuditLog: { create: jest.fn().mockResolvedValue({}) },
  };

  const prisma = {
    $transaction: jest.fn(async (cb: (client: Tx) => Promise<unknown>) => cb(tx)),
  } as unknown as PrismaService;

  return { tx, ledgerRows, payments, tips, handler: new TipReversalHandler(prisma, new AuditService()) };
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

describe('TipReversalHandler — corrections are reversals, never edits (§9.4)', () => {
  describe('rejections', () => {
    it('404s when no such tip exists in this branch', async () => {
      const { handler, tx } = setup({ found: false });

      const { status, body } = await caught(() =>
        handler.reverse(TIP_ID, { reason: REASON }, actorFixture(), CTX),
      );

      expect(status).toBe(404);
      expect(body.error.code).toBe(ErrorCode.TIP_NOT_FOUND);
      expect(tx.tip.create).not.toHaveBeenCalled();
    });

    it('locks the tip for update before reading it', async () => {
      const { handler, tx } = setup();
      await handler.reverse(TIP_ID, { reason: REASON }, actorFixture(), CTX);

      expect((tx.$queryRaw.mock.calls[0]![0] as string[]).join('?')).toContain('FOR UPDATE');
    });

    it('409s a tip that has already been reversed', async () => {
      const { handler, tx } = setup({ tip: tipFixture({ reversedByTipId: 'tip-reversal-0' }) });

      const { status, body } = await caught(() =>
        handler.reverse(TIP_ID, { reason: REASON }, actorFixture(), CTX),
      );

      expect(status).toBe(409);
      expect(body.error.code).toBe(ErrorCode.TIP_ALREADY_REVERSED);
      expect(body.error.details).toEqual({ tipId: TIP_ID, reversedByTipId: 'tip-reversal-0' });
      expect(tx.tip.create).not.toHaveBeenCalled();
    });

    it('409s — and writes nothing at all — once the accrual has gone out in a payout', async () => {
      const { handler, tx } = setup({ accrual: accrualFixture({ payoutBatchId: BATCH_ID }) });

      const { status, body } = await caught(() =>
        handler.reverse(TIP_ID, { reason: REASON }, actorFixture(), CTX),
      );

      expect(status).toBe(409);
      expect(body.error.code).toBe(ErrorCode.TIP_ALREADY_PAID_OUT);
      expect(body.error.message).toContain('manual adjustment');
      expect(body.error.details).toEqual({
        payoutBatchId: BATCH_ID,
        tipId: TIP_ID,
        ledgerEntryId: ACCRUAL_ID,
      });
      // A clawback is a human conversation, not a silent write.
      expect(tx.tip.create).not.toHaveBeenCalled();
      expect(tx.tip.update).not.toHaveBeenCalled();
      expect(tx.payment.create).not.toHaveBeenCalled();
      expect(tx.therapistPayoutLedger.create).not.toHaveBeenCalled();
      expect(tx.financialAuditLog.create).not.toHaveBeenCalled();
    });

    it('locks the accrual too, so a payout running in the next connection cannot slip past', async () => {
      const { handler, tx } = setup();
      await handler.reverse(TIP_ID, { reason: REASON }, actorFixture(), CTX);

      const accrualLock = (tx.$queryRaw.mock.calls[1]![0] as string[]).join('?');
      expect(accrualLock).toContain('therapist_payout_ledger');
      expect(accrualLock).toContain('TIP_ACCRUAL');
      expect(accrualLock).toContain('FOR UPDATE');
    });
  });

  describe('a tip the business collected', () => {
    it('writes a mirror row with the negative amount and leaves the original standing', async () => {
      const { handler, tx, tips } = setup();

      const view = await handler.reverse(TIP_ID, { reason: REASON }, actorFixture(), CTX);

      expect(tips).toHaveLength(1);
      expect(tips[0]).toMatchObject({
        reservationId: RESERVATION_ID,
        employeeId: EMPLOYEE_ID,
        type: 'COLLECTED_BY_BUSINESS',
        amountFils: -5_000,
        method: 'CARD',
        recordedByUserId: USER_ID,
        note: `Reversal of ${TIP_ID}: ${REASON}`,
      });
      expect(view.reversal.amountFils).toBe(-5_000);
      // The original is pointed at its reversal and otherwise untouched: the
      // only field this handler may write on an existing tip.
      expect(tx.tip.update).toHaveBeenCalledWith({
        where: { id: TIP_ID },
        data: { reversedByTipId: 'tip-reversal-1' },
      });
    });

    it('marks BOTH halves of the pair as reversed, so earnings and the ledger agree', async () => {
      const { handler, tips } = setup();

      const view = await handler.reverse(TIP_ID, { reason: REASON }, actorFixture(), CTX);

      // §9.2's earnings query and §13.3's first invariant both filter on
      // `reversed_by_tip_id IS NULL`. Leave the mirror unmarked and a reversed
      // 50 AED tip reads as −50 AED earned while the ledger nets to zero.
      expect(tips[0]).toMatchObject({ reversedByTipId: TIP_ID });
      expect(view.original.reversedByTipId).toBe('tip-reversal-1');
      expect(view.reversal.reversedByTipId).toBe(TIP_ID);
    });

    it('sends the money back out as a REFUND pointing at the tip payment', async () => {
      const { handler, payments } = setup();

      const view = await handler.reverse(TIP_ID, { reason: REASON }, actorFixture(), CTX);

      expect(payments).toHaveLength(1);
      expect(payments[0]).toMatchObject({
        kind: 'REFUND',
        method: 'CARD',
        amountFils: -5_000,
        reversesPaymentId: PAYMENT_ID,
        note: REASON,
        idempotencyKey: `${CTX.idempotencyKey}:refund`,
      });
      expect(view.refundPaymentId).toBe('payment-refund-1');
    });

    it('cancels the liability with a REVERSAL entry naming the accrual it undoes', async () => {
      const { handler, ledgerRows } = setup();

      const view = await handler.reverse(TIP_ID, { reason: REASON }, actorFixture(), CTX);

      expect(ledgerRows).toEqual([
        expect.objectContaining({
          entryType: 'REVERSAL',
          amountFils: -5_000,
          tipId: 'tip-reversal-1',
          reversesEntryId: ACCRUAL_ID,
          employeeId: EMPLOYEE_ID,
          reservationId: RESERVATION_ID,
        }),
      ]);
      expect(view.reversalEntryId).toBe('ledger-1');
      // +5 000 accrued, −5 000 reversed: the business owes nothing on this tip.
      expect(view.balanceAfterFils).toBe(0);
    });

    it('audits the reversal against the booking, on the same transaction', async () => {
      const { handler, tx } = setup();
      await handler.reverse(TIP_ID, { reason: REASON }, actorFixture(UserRole.OWNER), CTX);

      expect(tx.financialAuditLog.create).toHaveBeenCalledTimes(1);
      const { data } = tx.financialAuditLog.create.mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(data).toMatchObject({
        action: 'TIP_REVERSED',
        entityType: 'Reservation',
        entityId: RESERVATION_ID,
        amountFils: -5_000,
        requestId: CTX.requestId,
      });
      expect(data.beforeState).toMatchObject({ id: TIP_ID, amountFils: 5_000 });
      expect(data.afterState).toMatchObject({
        reversedTipId: TIP_ID,
        reason: REASON,
        refundPaymentId: 'payment-refund-1',
        reversalEntryId: 'ledger-1',
      });
    });

    it('records no idempotency key on the refund when the request carried none', async () => {
      const { handler, payments } = setup();
      const { idempotencyKey: _dropped, ...ctxWithoutKey } = CTX;

      await handler.reverse(TIP_ID, { reason: REASON }, actorFixture(), ctxWithoutKey);

      expect(payments[0]).toMatchObject({ idempotencyKey: null });
    });
  });

  describe('cash the guest handed straight to the therapist', () => {
    it('records the mirror tip and NOTHING else — no payment, no ledger entry', async () => {
      const { handler, tx, tips, ledgerRows, payments } = setup({
        tip: directCashTip(),
        balanceBeforeFils: null,
      });

      const view = await handler.reverse(TIP_ID, { reason: REASON }, actorFixture(), CTX);

      expect(tips[0]).toMatchObject({
        type: 'DIRECT_CASH',
        amountFils: -5_000,
        method: null,
        reversedByTipId: TIP_ID,
      });
      // The business never held this money, so there is nothing to send back
      // and no liability to cancel. §9.2.
      expect(payments).toEqual([]);
      expect(ledgerRows).toEqual([]);
      expect(view.refundPaymentId).toBeNull();
      expect(view.reversalEntryId).toBeNull();
      // SUM over zero ledger rows is NULL in Postgres, and a balance is a number.
      expect(view.balanceAfterFils).toBe(0);
      expect(tx.therapistPayoutLedger.findFirstOrThrow).not.toHaveBeenCalled();
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('still audits it, because the therapist’s earnings line just changed', async () => {
      const { handler, tx } = setup({ tip: directCashTip() });
      await handler.reverse(TIP_ID, { reason: REASON }, actorFixture(), CTX);

      const { data } = tx.financialAuditLog.create.mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(data).toMatchObject({ action: 'TIP_REVERSED', entityId: RESERVATION_ID });
      expect(data.afterState).toMatchObject({ refundPaymentId: null, reversalEntryId: null });
    });

    it('presents both rows with their trading day and method as stored', async () => {
      const { handler } = setup({ tip: directCashTip() });

      const view = await handler.reverse(TIP_ID, { reason: REASON }, actorFixture(), CTX);

      expect(view.original.method).toBeNull();
      expect(view.original.businessDay).toBe('2026-09-16');
      expect(view.reversal.type).toBe('DIRECT_CASH');
      expect(view.reversal.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });
});

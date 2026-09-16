import { HttpException } from '@nestjs/common';
import type { Employee, PayoutBatch } from '@prisma/client';
import type { ApiErrorBody, CreatePayoutDto } from '@berelax/contracts';
import { ErrorCode, UserRole, formatAed } from '@berelax/contracts';
import { AuditService } from '../common/audit.service';
import type { AuthUser, RequestContext } from '../common/request-context';
import type { PrismaService } from '../prisma/prisma.service';
import { PayoutHandler } from './payout.handler';

/**
 * §9.5, and the one property that has to hold afterwards: the batch total equals
 * the rows it settled, and the negative PAYOUT entry brings the balance to zero.
 *
 * The ledger here is a small simulation rather than a set of canned answers —
 * rows go in, the stamp marks them batched, and the balance is summed back out
 * of them. A mock that simply returns "0" when asked for the balance would pass
 * every test below while proving nothing about the arithmetic.
 */

const BATCH_ID = '0192aaaa-0000-7000-8000-0000000000b1';
const EMPLOYEE_ID = '0192cccc-0000-7000-8000-00000000000c';
const BRANCH_ID = '0192bbbb-0000-7000-8000-00000000000b';
const USER_ID = '0192dddd-0000-7000-8000-00000000000d';
const THERAPIST_USER_ID = '0192dddd-0000-7000-8000-00000000000e';

interface SimulatedRow {
  id: string;
  amountFils: number;
  payoutBatchId: string | null;
}

function employeeFixture(): Employee {
  return {
    id: EMPLOYEE_ID,
    branchId: BRANCH_ID,
    displayName: 'Therapist A',
    legalName: null,
    phone: null,
    status: 'ACTIVE',
    commissionBps: 1_000,
    hiredOn: null,
    photoUrl: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    deletedAt: null,
  };
}

function batchFixture(overrides: Partial<PayoutBatch> = {}): PayoutBatch {
  return {
    id: BATCH_ID,
    branchId: BRANCH_ID,
    employeeId: EMPLOYEE_ID,
    periodStart: new Date('2026-09-01T00:00:00.000Z'),
    periodEnd: new Date('2026-09-30T00:00:00.000Z'),
    totalFils: 38_500,
    method: 'CASH',
    paidAt: new Date('2026-10-01T08:00:00.000Z'),
    approvedByUserId: USER_ID,
    acknowledgedAt: null,
    note: 'September settlement',
    ...overrides,
  };
}

function managerFixture(role: UserRole = UserRole.MANAGER): AuthUser {
  return { id: USER_ID, role, branchId: BRANCH_ID, email: 'manager@berelax.ae', fullName: 'Manager' };
}

function therapistFixture(employeeId: string | null = EMPLOYEE_ID): AuthUser {
  return {
    id: THERAPIST_USER_ID,
    role: UserRole.THERAPIST,
    branchId: BRANCH_ID,
    employeeId,
    email: 'therapist@berelax.ae',
    fullName: 'Therapist A',
  };
}

const CTX: RequestContext = {
  requestId: 'req_01JBQ7X9',
  branchId: BRANCH_ID,
  actorUserId: USER_ID,
  actorRole: UserRole.MANAGER,
  idempotencyKey: 'a1b2c3d4-0000-4000-8000-000000000003',
};

function payoutDto(overrides: Partial<CreatePayoutDto> = {}): CreatePayoutDto {
  return {
    employeeId: EMPLOYEE_ID,
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    method: 'CASH',
    ...overrides,
  };
}

type Tx = {
  $queryRaw: jest.Mock;
  employee: { findFirst: jest.Mock };
  payoutBatch: { create: jest.Mock; update: jest.Mock; findUniqueOrThrow: jest.Mock };
  therapistPayoutLedger: {
    updateMany: jest.Mock;
    create: jest.Mock;
    aggregate: jest.Mock;
    findMany: jest.Mock;
  };
  financialAuditLog: { create: jest.Mock };
};

function setup(
  options: {
    /** What the period SELECT ... FOR UPDATE finds, in order. */
    unbatched?: Array<{ id: string; amountFils: number }>;
    /** Ledger rows that already belong to an earlier batch. */
    alreadyBatched?: number[];
    employee?: Employee | null;
    batch?: PayoutBatch;
    batchFound?: boolean;
    /** Force the stamp to touch fewer rows than were locked. */
    stampedCount?: number;
  } = {},
) {
  const unbatched = options.unbatched ?? [
    { id: 'entry-1', amountFils: 25_000 },
    { id: 'entry-2', amountFils: 13_500 },
  ];
  const batch = options.batch ?? batchFixture();

  const rows: SimulatedRow[] = [
    ...unbatched.map((entry) => ({ ...entry, payoutBatchId: null })),
    ...(options.alreadyBatched ?? []).map((amountFils, i) => ({
      id: `settled-${i}`,
      amountFils,
      payoutBatchId: 'older-batch',
    })),
  ];
  const created: Record<string, unknown>[] = [];

  const tx: Tx = {
    $queryRaw: jest.fn(async (strings: string[]) => {
      const sql = strings.join('?');
      if (sql.includes('payout_batches')) return options.batchFound === false ? [] : [{ id: batch.id }];
      return unbatched;
    }),
    employee: {
      findFirst: jest.fn().mockResolvedValue(
        options.employee === undefined ? employeeFixture() : options.employee,
      ),
    },
    payoutBatch: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...batch,
        ...data,
        id: BATCH_ID,
      })),
      update: jest.fn(async ({ data }: { data: Partial<PayoutBatch> }) => ({ ...batch, ...data })),
      findUniqueOrThrow: jest.fn().mockResolvedValue(batch),
    },
    therapistPayoutLedger: {
      updateMany: jest.fn(async ({ where, data }: { where: { id: { in: string[] } }; data: { payoutBatchId: string } }) => {
        const touched = rows.filter((row) => where.id.in.includes(row.id) && row.payoutBatchId === null);
        for (const row of touched) row.payoutBatchId = data.payoutBatchId;
        return { count: options.stampedCount ?? touched.length };
      }),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        rows.push({
          id: `created-${created.length}`,
          amountFils: data.amountFils as number,
          payoutBatchId: (data.payoutBatchId as string | undefined) ?? null,
        });
        return { ...data, id: `created-${created.length}` };
      }),
      // SUM(amount_fils) over whatever the filter selects — the only way a
      // balance is ever obtained. §9.3.
      aggregate: jest.fn(async ({ where }: { where: { payoutBatchId?: null } }) => {
        const scope = where.payoutBatchId === null ? rows.filter((r) => !r.payoutBatchId) : rows;
        if (scope.length === 0) return { _sum: { amountFils: null } };
        return { _sum: { amountFils: scope.reduce((sum, r) => sum + r.amountFils, 0) } };
      }),
      findMany: jest.fn(async () =>
        rows.filter((row) => row.payoutBatchId === batch.id).map((row) => ({ id: row.id })),
      ),
    },
    financialAuditLog: { create: jest.fn().mockResolvedValue({}) },
  };

  const prisma = {
    $transaction: jest.fn(async (cb: (client: Tx) => Promise<unknown>) => cb(tx)),
  } as unknown as PrismaService;

  return { tx, rows, created, handler: new PayoutHandler(prisma, new AuditService()) };
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

describe('PayoutHandler — settling up (§9.5)', () => {
  describe('rejections', () => {
    it('422s a period that ends before it starts', async () => {
      const { handler, tx } = setup();

      const { status, body } = await caught(() =>
        handler.create(
          payoutDto({ periodStart: '2026-09-30', periodEnd: '2026-09-01' }),
          managerFixture(),
          CTX,
        ),
      );

      expect(status).toBe(422);
      expect(body.error.code).toBe(ErrorCode.VALIDATION_FAILED);
      expect(tx.payoutBatch.create).not.toHaveBeenCalled();
    });

    it('404s an unknown therapist rather than paying out an empty ledger', async () => {
      const { handler, tx } = setup({ employee: null });

      const { status, body } = await caught(() =>
        handler.create(payoutDto(), managerFixture(), CTX),
      );

      expect(status).toBe(404);
      expect(body.error.code).toBe(ErrorCode.NOT_FOUND);
      expect(tx.payoutBatch.create).not.toHaveBeenCalled();
    });

    it('422s PAYOUT_NOT_POSITIVE when nothing is outstanding', async () => {
      const { handler, tx } = setup({ unbatched: [] });

      const { status, body } = await caught(() =>
        handler.create(payoutDto(), managerFixture(), CTX),
      );

      expect(status).toBe(422);
      expect(body.error.code).toBe(ErrorCode.PAYOUT_NOT_POSITIVE);
      expect(body.error.message).toContain('nothing outstanding');
      expect(body.error.details).toMatchObject({ entryCount: 0, totalFils: 0 });
      expect(tx.payoutBatch.create).not.toHaveBeenCalled();
    });

    it('422s PAYOUT_NOT_POSITIVE when the period nets negative, naming the amount', async () => {
      const { handler, tx } = setup({
        unbatched: [
          { id: 'entry-1', amountFils: 5_000 },
          { id: 'entry-2', amountFils: -8_000 },
        ],
      });

      const { status, body } = await caught(() =>
        handler.create(payoutDto(), managerFixture(), CTX),
      );

      expect(status).toBe(422);
      expect(body.error.code).toBe(ErrorCode.PAYOUT_NOT_POSITIVE);
      expect(body.error.message).toContain(formatAed(-3_000));
      expect(body.error.details).toMatchObject({ entryCount: 2, totalFils: -3_000 });
      expect(tx.payoutBatch.create).not.toHaveBeenCalled();
    });

    it('refuses to commit if the stamp did not reach every locked entry', async () => {
      const { handler } = setup({ stampedCount: 1 });

      // Unreachable while the row locks hold — and asserted anyway, because if
      // it ever fires the batch total no longer describes the rows it settled.
      await expect(handler.create(payoutDto(), managerFixture(), CTX)).rejects.toThrow(
        /expected to settle 2 ledger entries, settled 1/,
      );
    });
  });

  describe('the batch', () => {
    it('locks the unbatched entries for update, in the period, in a stable order', async () => {
      const { handler, tx } = setup();
      await handler.create(payoutDto(), managerFixture(), CTX);

      const sql = (tx.$queryRaw.mock.calls[0]![0] as string[]).join('?');
      expect(sql).toContain('payout_batch_id IS NULL');
      expect(sql).toContain('business_day BETWEEN');
      expect(sql).toContain('ORDER BY id');
      expect(sql).toContain('FOR UPDATE');
    });

    it('sums the entries into the batch total', async () => {
      const { handler, tx } = setup();

      const view = await handler.create(payoutDto({ note: 'September settlement' }), managerFixture(), CTX);

      expect(tx.payoutBatch.create).toHaveBeenCalledTimes(1);
      const { data } = tx.payoutBatch.create.mock.calls[0]![0] as { data: Record<string, unknown> };
      expect(data).toMatchObject({
        employeeId: EMPLOYEE_ID,
        totalFils: 38_500,
        method: 'CASH',
        approvedByUserId: USER_ID,
        note: 'September settlement',
      });
      expect(view.totalFils).toBe(38_500);
      expect(view.entryIds).toEqual(['entry-1', 'entry-2']);
    });

    it('stamps each entry, and only ever from NULL', async () => {
      const { handler, tx, rows } = setup();
      await handler.create(payoutDto(), managerFixture(), CTX);

      expect(tx.therapistPayoutLedger.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['entry-1', 'entry-2'] }, payoutBatchId: null },
        data: { payoutBatchId: BATCH_ID },
      });
      expect(rows.filter((row) => row.payoutBatchId === BATCH_ID)).toHaveLength(3);
    });

    it('inserts the negative PAYOUT entry that brings the balance to zero', async () => {
      const { handler, created } = setup();

      const view = await handler.create(payoutDto(), managerFixture(UserRole.OWNER), CTX);

      expect(created).toEqual([
        expect.objectContaining({
          entryType: 'PAYOUT',
          amountFils: -38_500,
          payoutBatchId: BATCH_ID,
          employeeId: EMPLOYEE_ID,
          createdByUserId: USER_ID,
          note: 'Payout batch 2026-09-01 to 2026-09-30',
        }),
      ]);
      expect(view.balanceAfterFils).toBe(0);
      expect(view.unbatchedFils).toBe(0);
    });

    it('leaves accruals outside the period owed, and says so', async () => {
      const { handler, rows } = setup();
      rows.push({ id: 'october-tip', amountFils: 7_500, payoutBatchId: null });

      const view = await handler.create(payoutDto(), managerFixture(), CTX);

      expect(view.balanceAfterFils).toBe(7_500);
      expect(view.unbatchedFils).toBe(7_500);
    });

    it('audits PAYOUT_CREATED with every settled entry id', async () => {
      const { handler, tx } = setup();
      await handler.create(payoutDto(), managerFixture(), CTX);

      const { data } = tx.financialAuditLog.create.mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(data).toMatchObject({
        action: 'PAYOUT_CREATED',
        entityType: 'PayoutBatch',
        entityId: BATCH_ID,
        amountFils: 38_500,
      });
      // "These two accruals, by id, were paid — check them yourself." §9.7.
      expect(data.afterState).toMatchObject({
        entryCount: 2,
        entryIds: ['entry-1', 'entry-2'],
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
        payoutEntryId: 'created-1',
      });
    });

    it('presents the period as trading days and the batch as unacknowledged', async () => {
      const { handler } = setup();

      const view = await handler.create(payoutDto(), managerFixture(), CTX);

      expect(view.periodStart).toBe('2026-09-01');
      expect(view.periodEnd).toBe('2026-09-30');
      expect(view.acknowledgedAt).toBeNull();
      expect(view.paidAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('acknowledgement', () => {
    it('404s a batch that is not in this branch', async () => {
      const { handler, tx } = setup({ batchFound: false });

      const { status, body } = await caught(() =>
        handler.acknowledge(BATCH_ID, therapistFixture(), CTX),
      );

      expect(status).toBe(404);
      expect(body.error.code).toBe(ErrorCode.PAYOUT_BATCH_NOT_FOUND);
      expect(tx.payoutBatch.update).not.toHaveBeenCalled();
    });

    it('403s a therapist signing for somebody else’s money', async () => {
      const { handler, tx } = setup();

      const { status, body } = await caught(() =>
        handler.acknowledge(BATCH_ID, therapistFixture('0192cccc-0000-7000-8000-00000000000f'), CTX),
      );

      expect(status).toBe(403);
      expect(body.error.code).toBe(ErrorCode.INSUFFICIENT_ROLE);
      expect(tx.payoutBatch.update).not.toHaveBeenCalled();
    });

    it('403s a therapist login with no employee record behind it', async () => {
      const { handler } = setup();

      const { status } = await caught(() =>
        handler.acknowledge(BATCH_ID, therapistFixture(null), CTX),
      );

      expect(status).toBe(403);
    });

    it('409s a second confirmation, naming when the first one happened', async () => {
      const acknowledgedAt = new Date('2026-10-02T10:00:00.000Z');
      const { handler, tx } = setup({ batch: batchFixture({ acknowledgedAt }) });

      const { status, body } = await caught(() =>
        handler.acknowledge(BATCH_ID, therapistFixture(), CTX),
      );

      expect(status).toBe(409);
      expect(body.error.code).toBe(ErrorCode.PAYOUT_ALREADY_ACKNOWLEDGED);
      expect(body.error.details).toEqual({
        payoutBatchId: BATCH_ID,
        acknowledgedAt: acknowledgedAt.toISOString(),
      });
      expect(tx.payoutBatch.update).not.toHaveBeenCalled();
    });

    it('records the signature, audits it, and lists what was signed for', async () => {
      const { handler, tx, rows } = setup();
      for (const row of rows) row.payoutBatchId = BATCH_ID;

      const view = await handler.acknowledge(BATCH_ID, therapistFixture(), CTX);

      expect(tx.payoutBatch.update).toHaveBeenCalledWith({
        where: { id: BATCH_ID },
        data: { acknowledgedAt: expect.any(Date) },
      });
      expect(view.acknowledgedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(view.entryIds).toEqual(['entry-1', 'entry-2']);

      const { data } = tx.financialAuditLog.create.mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(data).toMatchObject({
        action: 'PAYOUT_ACKNOWLEDGED',
        entityType: 'PayoutBatch',
        entityId: BATCH_ID,
        amountFils: 38_500,
      });
    });

    it('locks the batch, so two taps on Confirm receipt cannot both write', async () => {
      const { handler, tx } = setup();
      await handler.acknowledge(BATCH_ID, therapistFixture(), CTX);

      expect((tx.$queryRaw.mock.calls[0]![0] as string[]).join('?')).toContain('FOR UPDATE');
    });

    it('reports a balance of zero from an empty ledger without inventing one', async () => {
      const { handler } = setup({ unbatched: [] });

      const view = await handler.acknowledge(BATCH_ID, therapistFixture(), CTX);

      expect(view.balanceAfterFils).toBe(0);
      expect(view.unbatchedFils).toBe(0);
      expect(view.entryIds).toEqual([]);
    });
  });
});

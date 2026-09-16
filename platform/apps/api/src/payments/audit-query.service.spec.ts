import type { FinancialAuditLog } from '@prisma/client';
import { UserRole, businessDayBounds } from '@berelax/contracts';
import type { AuthUser } from '../common/request-context';
import type { PrismaService } from '../prisma/prisma.service';
import { AUDIT_DEFAULT_SPAN_DAYS, AuditQueryService } from './audit-query.service';
import { shiftTradingDay } from './money.support';

/**
 * The log a manager opens when a therapist says September was short. §9.7.
 *
 * Nothing here writes, and nothing here can: `financial_audit_log` is immutable
 * at the database level (§5.4). What these tests hold to account is the reading
 * — that a filter narrows what it says it narrows, and that "who did this"
 * comes back as a name rather than a UUID.
 */

const BRANCH_ID = '0192bbbb-0000-7000-8000-00000000000b';
const MANAGER_ID = '0192dddd-0000-7000-8000-00000000000d';
const RESERVATION_ID = '0192f8a1-0000-7000-8000-000000000001';

function actorFixture(): AuthUser {
  return {
    id: MANAGER_ID,
    role: UserRole.MANAGER,
    branchId: BRANCH_ID,
    email: 'manager@berelax.ae',
    fullName: 'Manager',
  };
}

function logFixture(overrides: Partial<FinancialAuditLog> = {}): FinancialAuditLog {
  return {
    id: 'audit-1',
    branchId: BRANCH_ID,
    actorUserId: MANAGER_ID,
    actorRole: 'MANAGER',
    action: 'TIP_REVERSED',
    entityType: 'Reservation',
    entityId: RESERVATION_ID,
    beforeState: { id: 'tip-1', amountFils: 50_000 },
    afterState: { reason: 'Reception typed 500 where the guest gave 50' },
    amountFils: -50_000,
    ipAddress: '89.211.0.1',
    userAgent: 'iPad',
    requestId: 'req_01JBQ7X8',
    createdAt: new Date('2026-09-17T09:00:00.000Z'),
    ...overrides,
  };
}

function setup(options: { rows?: FinancialAuditLog[]; users?: Array<{ id: string; fullName: string }>; total?: number } = {}) {
  const rows = options.rows ?? [logFixture()];
  const prisma = {
    financialAuditLog: {
      count: jest.fn().mockResolvedValue(options.total ?? rows.length),
      findMany: jest.fn().mockResolvedValue(rows),
    },
    user: {
      findMany: jest
        .fn()
        .mockResolvedValue(options.users ?? [{ id: MANAGER_ID, fullName: 'Rania (manager)' }]),
    },
  } as unknown as PrismaService;

  return { prisma, service: new AuditQueryService(prisma) };
}

const BASE_QUERY = { limit: 50, offset: 0 };

function whereOf(prisma: PrismaService): Record<string, unknown> {
  const call = (prisma.financialAuditLog.findMany as unknown as jest.Mock).mock.calls[0]![0] as {
    where: Record<string, unknown>;
  };
  return call.where;
}

describe('AuditQueryService', () => {
  it('scopes every search to the caller’s branch and nothing else by default', async () => {
    const { service, prisma } = setup();

    const view = await service.find(BASE_QUERY, actorFixture());

    expect(whereOf(prisma)).toEqual({ branchId: BRANCH_ID });
    expect(view.total).toBe(1);
    expect(view.limit).toBe(50);
    expect(view.offset).toBe(0);
  });

  it('filters by entity, actor and action when asked', async () => {
    const { service, prisma } = setup();

    await service.find(
      {
        ...BASE_QUERY,
        entityType: 'PayoutBatch',
        entityId: RESERVATION_ID,
        actorUserId: MANAGER_ID,
        action: 'PAYOUT_CREATED',
      },
      actorFixture(),
    );

    expect(whereOf(prisma)).toEqual({
      branchId: BRANCH_ID,
      entityType: 'PayoutBatch',
      entityId: RESERVATION_ID,
      actorUserId: MANAGER_ID,
      action: 'PAYOUT_CREATED',
    });
  });

  it('applies a date range in TRADING days, so a 01:30 entry lands on the right night', async () => {
    const { service, prisma } = setup();

    await service.find({ ...BASE_QUERY, from: '2026-09-16', to: '2026-09-16' }, actorFixture());

    expect(whereOf(prisma).createdAt).toEqual({
      gte: businessDayBounds('2026-09-16').start,
      lt: businessDayBounds('2026-09-16').end,
    });
  });

  it('fills in the other end of a half-given range', async () => {
    const { service, prisma } = setup();

    await service.find({ ...BASE_QUERY, to: '2026-09-30' }, actorFixture());

    const expectedFrom = shiftTradingDay('2026-09-30', -AUDIT_DEFAULT_SPAN_DAYS);
    expect(whereOf(prisma).createdAt).toEqual({
      gte: businessDayBounds(expectedFrom).start,
      lt: businessDayBounds('2026-09-30').end,
    });
  });

  it('applies NO range when none is asked for, so an entity returns its whole history', async () => {
    const { service, prisma } = setup();

    await service.find({ ...BASE_QUERY, entityId: RESERVATION_ID }, actorFixture());

    expect(whereOf(prisma)).not.toHaveProperty('createdAt');
  });

  it('returns the newest first, paged', async () => {
    const { service, prisma } = setup({ total: 412 });

    const view = await service.find({ limit: 25, offset: 50 }, actorFixture());

    expect((prisma.financialAuditLog.findMany as unknown as jest.Mock).mock.calls[0]![0]).toMatchObject({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 25,
      skip: 50,
    });
    expect(view.total).toBe(412);
  });

  it('resolves the actor to a name, once for the whole page', async () => {
    const { service, prisma } = setup({
      rows: [logFixture(), logFixture({ id: 'audit-2', action: 'PAYOUT_CREATED' })],
    });

    const view = await service.find(BASE_QUERY, actorFixture());

    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    expect((prisma.user.findMany as unknown as jest.Mock).mock.calls[0]![0]).toMatchObject({
      where: { id: { in: [MANAGER_ID] }, branchId: BRANCH_ID },
    });
    expect(view.entries[0]!.actor).toEqual({
      id: MANAGER_ID,
      role: 'MANAGER',
      fullName: 'Rania (manager)',
    });
  });

  it('leaves the name null for a user who no longer exists, and keeps the id', async () => {
    const { service } = setup({ users: [] });

    const view = await service.find(BASE_QUERY, actorFixture());

    // The log stores the id and never the name, so a user renamed or removed
    // later cannot rewrite what the log says happened.
    expect(view.entries[0]!.actor).toEqual({ id: MANAGER_ID, role: 'MANAGER', fullName: null });
  });

  it('handles a system-written row with no actor at all', async () => {
    const { service, prisma } = setup({ rows: [logFixture({ actorUserId: null, actorRole: null })] });

    const view = await service.find(BASE_QUERY, actorFixture());

    expect(view.entries[0]!.actor).toBeNull();
    // Nothing to resolve, so nothing is asked of the users table.
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('presents the money, the states and the request id a dispute needs', async () => {
    const { service } = setup();

    const view = await service.find(BASE_QUERY, actorFixture());

    expect(view.entries[0]).toMatchObject({
      id: 'audit-1',
      createdAt: '2026-09-17T09:00:00.000Z',
      action: 'TIP_REVERSED',
      entityType: 'Reservation',
      entityId: RESERVATION_ID,
      amountFils: -50_000,
      beforeState: { id: 'tip-1', amountFils: 50_000 },
      afterState: { reason: 'Reception typed 500 where the guest gave 50' },
      requestId: 'req_01JBQ7X8',
      ipAddress: '89.211.0.1',
    });
  });
});

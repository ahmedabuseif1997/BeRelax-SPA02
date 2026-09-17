import { HttpException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { ApiErrorBody } from '@berelax/contracts';
import { ErrorCode, UserRole } from '@berelax/contracts';
import type { AuthUser, RequestContext } from '../common/request-context';
import type { PrismaService } from '../prisma/prisma.service';
import type { GuestErasureService } from './guest-erasure.service';
import { RetentionService } from './retention.service';

/**
 * §11.6. The claim under test is not "rows disappear" — it is that retention
 * anonymises a guest through the SAME code path the erasure endpoint uses, so
 * that §11.4 and §11.6 cannot drift into two different meanings of "erased".
 * That is asserted directly: the service must call GuestErasureService and must
 * not reach for `guest.update` itself.
 */

const BRANCH_ID = '0192bbbb-0000-7000-8000-00000000000b';
const USER_ID = '0192dddd-0000-7000-8000-00000000000d';
const LAPSED = ['0192aaaa-0000-7000-8000-00000000001a', '0192aaaa-0000-7000-8000-00000000002a'];

/** Pinned so the three-year cutoff is a fixed date rather than a moving one. */
const NOW = new Date('2026-09-17T09:00:00.000Z');

function actorFixture(role: UserRole = UserRole.OWNER): AuthUser {
  return { id: USER_ID, role, branchId: BRANCH_ID, email: 'owner@berelax.ae', fullName: 'Owner' };
}

const CTX: RequestContext = {
  requestId: 'req_01JBQ7X8',
  branchId: BRANCH_ID,
  actorUserId: USER_ID,
  actorRole: UserRole.OWNER,
};

function setup(
  options: {
    lapsed?: string[];
    /** Rows still past the window before, then after, the prune. */
    due?: { before: number[]; after: number[] };
    pruned?: number;
    functionInstalled?: boolean;
    eraseFails?: boolean;
  } = {},
) {
  const lapsed = options.lapsed ?? LAPSED;
  const due = options.due ?? { before: [3, 12, 5, 7], after: [0, 0, 0, 0] };
  let counted = 0;

  const prisma = {
    guest: {
      count: jest.fn(async () => lapsed.length),
      findMany: jest.fn(async ({ take }: { take: number }) =>
        lapsed.slice(0, take).map((id) => ({ id })),
      ),
      update: jest.fn(),
    },
    attributionSnapshot: { count: jest.fn(async () => pick(0)) },
    outboundClick: { count: jest.fn(async () => pick(1)) },
    idempotencyRecord: { count: jest.fn(async () => pick(2)) },
    refreshToken: { count: jest.fn(async () => pick(3)) },
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('');
      if (sql.includes('to_regprocedure')) {
        return [{ installed: options.functionInstalled ?? true }];
      }
      return [{ pruned: options.pruned ?? 4 }];
    }),
  } as unknown as PrismaService;

  // The first four count() calls are the "before" pass, the next four the "after".
  function pick(index: number): number {
    const pass = counted++ < 4 ? due.before : due.after;
    return pass[index] ?? 0;
  }

  const erasure = {
    erase: jest.fn(async () => {
      if (options.eraseFails) {
        throw Object.assign(new Error('conflict'), {
          response: { error: { code: ErrorCode.GUEST_ALREADY_ERASED } },
        });
      }
      return {};
    }),
  } as unknown as GuestErasureService;

  const config = {
    get: jest.fn((key: string) =>
      key === 'ATTRIBUTION_RETENTION_DAYS' ? 90 : key === 'GUEST_RETENTION_YEARS' ? 3 : undefined,
    ),
  } as unknown as ConfigService;

  return { service: new RetentionService(prisma, erasure, config), prisma, erasure };
}

describe('RetentionService.run', () => {
  it('calls prune_attribution and reports what it pruned', async () => {
    const { service, prisma } = setup({ pruned: 4, due: { before: [4, 12, 5, 7], after: [0, 0, 0, 0] } });

    const report = await service.run({ dryRun: false, limit: 500 }, actorFixture(), CTX, NOW);

    const sql = (prisma.$queryRaw as jest.Mock).mock.calls.map((c) => c[0].join('?')).join(' ');
    expect(sql).toContain('prune_attribution');
    expect(report.attribution).toEqual({
      retentionDays: 90,
      snapshotsPruned: 4,
      outboundClicksDeleted: 12,
      idempotencyRecordsDeleted: 5,
      refreshTokensDeleted: 7,
    });
  });

  it('anonymises a lapsed guest through the erasure service, not by itself', async () => {
    const { service, prisma, erasure } = setup();

    const report = await service.run({ dryRun: false, limit: 500 }, actorFixture(), CTX, NOW);

    // One way a guest is anonymised, and this is not a second one.
    expect(erasure.erase).toHaveBeenCalledTimes(2);
    expect(prisma.guest.update).not.toHaveBeenCalled();
    expect((erasure.erase as jest.Mock).mock.calls[0][0]).toBe(LAPSED[0]);
    expect((erasure.erase as jest.Mock).mock.calls[0][1]).toMatch(/no visit in 3 years/i);
    expect(report.guests.anonymised).toBe(2);
    expect(report.guests.candidates).toBe(2);
    expect(report.guests.remaining).toBe(0);
  });

  it('cuts at GUEST_RETENTION_YEARS before now, counting future bookings as a live relationship', async () => {
    const { service, prisma } = setup();

    const report = await service.run({ dryRun: false, limit: 500 }, actorFixture(), CTX, NOW);

    expect(report.guests.cutoff).toBe('2023-09-17T09:00:00.000Z');
    const where = (prisma.guest.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.branchId).toBe(BRANCH_ID);
    expect(where.anonymisedAt).toBeNull();
    // `none` over ALL reservations, past or future: a booking next month keeps
    // the guest out of the run however long ago they last came in.
    expect(where.reservations.none.startsAt.gte.toISOString()).toBe('2023-09-17T09:00:00.000Z');
  });

  it('a dry run touches nothing and still answers the question', async () => {
    const { service, prisma, erasure } = setup({ due: { before: [6, 2, 1, 0], after: [6, 2, 1, 0] } });

    const report = await service.run({ dryRun: true, limit: 500 }, actorFixture(), CTX, NOW);

    expect(erasure.erase).not.toHaveBeenCalled();
    const sql = (prisma.$queryRaw as jest.Mock).mock.calls.map((c) => c[0].join('?')).join(' ');
    expect(sql).not.toContain('prune_attribution');
    expect(report.dryRun).toBe(true);
    expect(report.attribution.snapshotsPruned).toBe(6);
    // What WOULD be anonymised, named, so the first run against real data is a
    // decision rather than a discovery.
    expect(report.guests.guestIds).toEqual(LAPSED);
    expect(report.guests.anonymised).toBe(0);
  });

  it('honours the limit and reports what is left for the next run', async () => {
    const { service } = setup();

    const report = await service.run({ dryRun: false, limit: 1 }, actorFixture(), CTX, NOW);

    expect(report.guests.anonymised).toBe(1);
    expect(report.guests.remaining).toBe(1);
  });

  it('steps over one failure instead of abandoning the rest', async () => {
    const { service } = setup({ eraseFails: true });

    const report = await service.run({ dryRun: false, limit: 500 }, actorFixture(), CTX, NOW);

    expect(report.guests.anonymised).toBe(0);
    expect(report.guests.failures).toEqual([
      { guestId: LAPSED[0], code: ErrorCode.GUEST_ALREADY_ERASED },
      { guestId: LAPSED[1], code: ErrorCode.GUEST_ALREADY_ERASED },
    ]);
  });

  it('refuses in a readable code when prune_attribution was never installed', async () => {
    const { service } = setup({ functionInstalled: false });

    const error = await service
      .run({ dryRun: false, limit: 500 }, actorFixture(), CTX, NOW)
      .catch((e) => e);

    // "Nothing was due" and "nothing can ever be pruned" must not look the same.
    expect((error as HttpException).getStatus()).toBe(503);
    expect(((error as HttpException).getResponse() as ApiErrorBody).error.code).toBe(
      ErrorCode.RETENTION_FUNCTION_MISSING,
    );
  });

  it('reports a clean run over a database with nothing due', async () => {
    const { service } = setup({ lapsed: [], pruned: 0, due: { before: [0, 0, 0, 0], after: [0, 0, 0, 0] } });

    const report = await service.run({ dryRun: false, limit: 500 }, actorFixture(), CTX, NOW);

    expect(report.guests.candidates).toBe(0);
    expect(report.attribution.snapshotsPruned).toBe(0);
    expect(report.guests.failures).toEqual([]);
  });
});

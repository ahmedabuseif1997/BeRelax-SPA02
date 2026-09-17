import { HttpException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Guest } from '@prisma/client';
import type { ApiErrorBody } from '@berelax/contracts';
import { ErrorCode, UserRole } from '@berelax/contracts';
import { AuditService } from '../common/audit.service';
import type { AuthUser, RequestContext } from '../common/request-context';
import type { PrismaService } from '../prisma/prisma.service';
import {
  ERASED_NAME,
  ERASED_PHONE_PREFIX,
  GuestErasureService,
  NULL_UUID,
  erasedPhoneToken,
} from './guest-erasure.service';

/**
 * §11.4. Two claims are being tested and they pull in opposite directions:
 * the PERSON must be gone, and the MONEY must still be there. A test suite that
 * only asserted the first would pass happily on a `DELETE` cascade that took five
 * years of accounting records with it, so the retention side is asserted just as
 * explicitly as the erasure side.
 */

const GUEST_ID = '0192aaaa-0000-7000-8000-00000000000a';
const OTHER_GUEST_ID = '0192aaaa-0000-7000-8000-00000000000f';
const BRANCH_ID = '0192bbbb-0000-7000-8000-00000000000b';
const USER_ID = '0192dddd-0000-7000-8000-00000000000d';
const RESERVATION_ID = '0192f8a1-0000-7000-8000-000000000001';
const SNAPSHOT_ID = '0192eeee-0000-7000-8000-00000000000e';
const VISITOR_ID = '0192ffff-0000-7000-8000-00000000000f';
const SALT = 'a-test-salt-that-is-never-rotated';
const REASON = 'Guest asked to be erased by phone on the 14th';

function guestFixture(overrides: Partial<Guest> = {}): Guest {
  return {
    id: GUEST_ID,
    branchId: BRANCH_ID,
    fullName: 'Amira Khan',
    phone: '+971501234567',
    email: 'amira@example.ae',
    notes: 'Prefers firm pressure',
    isBlocked: false,
    anonymisedAt: null,
    createdAt: new Date('2026-01-04T08:00:00.000Z'),
    updatedAt: new Date('2026-09-10T08:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

function actorFixture(role: UserRole = UserRole.MANAGER): AuthUser {
  return { id: USER_ID, role, branchId: BRANCH_ID, email: 'manager@berelax.ae', fullName: 'Manager' };
}

const CTX: RequestContext = {
  requestId: 'req_01JBQ7X8',
  branchId: BRANCH_ID,
  actorUserId: USER_ID,
  actorRole: UserRole.MANAGER,
  ipAddress: '10.0.0.8',
};

type Tx = {
  guest: { findFirst: jest.Mock; update: jest.Mock; deleteMany: jest.Mock };
  guestConsent: { deleteMany: jest.Mock };
  attributionSnapshot: { findMany: jest.Mock; update: jest.Mock };
  outboundClick: { deleteMany: jest.Mock };
  bookingRequest: { updateMany: jest.Mock };
  reservation: { updateMany: jest.Mock; findMany: jest.Mock; deleteMany: jest.Mock };
  payment: { count: jest.Mock; deleteMany: jest.Mock };
  tip: { count: jest.Mock; deleteMany: jest.Mock };
  therapistPayoutLedger: { count: jest.Mock; deleteMany: jest.Mock };
  financialAuditLog: { create: jest.Mock };
};

function setup(
  options: {
    guest?: Guest | null;
    /** A guest already holding the token this erasure would write. */
    tokenTaken?: boolean;
    snapshots?: Array<{ id: string; visitorId: string; firstTouch: unknown; lastTouch: unknown }>;
    reservationIds?: string[];
  } = {},
) {
  const guest = options.guest === undefined ? guestFixture() : options.guest;
  const snapshots =
    options.snapshots ??
    [
      {
        id: SNAPSHOT_ID,
        visitorId: VISITOR_ID,
        firstTouch: { source: 'google', medium: 'organic', campaign: null, referrer: 'https://google.ae/?q=amira+khan' },
        lastTouch: { source: 'instagram', medium: 'social', landing: '/offers?ref=amira' },
      },
    ];
  const reservationIds = options.reservationIds ?? [RESERVATION_ID];

  const tx: Tx = {
    guest: {
      findFirst: jest.fn(async (args: { where: Record<string, unknown> }) => {
        // Two different lookups share this mock: the guest itself, then the
        // collision check on the token about to be written.
        const phone = args.where.phone as { startsWith?: string } | undefined;
        if (phone?.startsWith) return options.tokenTaken ? { id: OTHER_GUEST_ID } : null;
        return guest;
      }),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...guest, ...data })),
      deleteMany: jest.fn(),
    },
    guestConsent: { deleteMany: jest.fn(async () => ({ count: 2 })) },
    attributionSnapshot: {
      findMany: jest.fn(async () => snapshots),
      update: jest.fn(async () => ({})),
    },
    outboundClick: { deleteMany: jest.fn(async () => ({ count: 4 })) },
    bookingRequest: { updateMany: jest.fn(async () => ({ count: 1 })) },
    reservation: {
      updateMany: jest.fn(async () => ({ count: 3 })),
      findMany: jest.fn(async () => reservationIds.map((id) => ({ id }))),
      deleteMany: jest.fn(),
    },
    payment: { count: jest.fn(async () => 5), deleteMany: jest.fn() },
    tip: { count: jest.fn(async () => 2), deleteMany: jest.fn() },
    therapistPayoutLedger: { count: jest.fn(async () => 2), deleteMany: jest.fn() },
    financialAuditLog: { create: jest.fn(async () => ({})) },
  };

  const prisma = {
    $transaction: jest.fn(async (cb: (client: Tx) => Promise<unknown>) => cb(tx)),
  } as unknown as PrismaService;

  const config = { getOrThrow: jest.fn(() => SALT) } as unknown as ConfigService;
  const service = new GuestErasureService(prisma, new AuditService(), config);
  return { service, tx, prisma };
}

function codeOf(error: unknown): string {
  return ((error as HttpException).getResponse() as ApiErrorBody).error.code;
}

describe('erasedPhoneToken', () => {
  it('is stable for a number, so a blocked guest stays blocked', () => {
    // The whole mechanism: the number is unrecoverable, but asking "is THIS the
    // number that was erased" still has an answer, for ever.
    expect(erasedPhoneToken('+971501234567', SALT)).toBe(erasedPhoneToken('+971501234567', SALT));
    expect(erasedPhoneToken('+971501234567', SALT)).not.toBe(
      erasedPhoneToken('+971501234568', SALT),
    );
  });

  it('is prefixed and short enough to read, and never contains the number', () => {
    const token = erasedPhoneToken('+971501234567', SALT);
    expect(token.startsWith(ERASED_PHONE_PREFIX)).toBe(true);
    expect(token.slice(ERASED_PHONE_PREFIX.length)).toMatch(/^[0-9a-f]{24}$/);
    expect(token).not.toContain('501234567');
  });

  it('changes completely with the salt — which is why ERASURE_SALT is never rotated', () => {
    // Nothing in the system could repair this: the number needed to re-hash is
    // exactly the thing the erasure destroyed. §12.5.
    expect(erasedPhoneToken('+971501234567', SALT)).not.toBe(
      erasedPhoneToken('+971501234567', 'a-different-salt'),
    );
  });
});

describe('GuestErasureService.erase', () => {
  it('replaces the name, hashes the phone and clears the email and notes', async () => {
    const { service, tx } = setup();

    const view = await service.erase(GUEST_ID, REASON, actorFixture(), CTX);

    const data = tx.guest.update.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.fullName).toBe(ERASED_NAME);
    expect(data.phone).toBe(erasedPhoneToken('+971501234567', SALT));
    expect(data.email).toBeNull();
    expect(data.notes).toBeNull();
    expect(data.anonymisedAt).toBeInstanceOf(Date);
    expect(data.deletedAt).toBeInstanceOf(Date);
    expect(view.phoneToken).toBe(erasedPhoneToken('+971501234567', SALT));
  });

  it('deletes the consent records and severs the attribution snapshots', async () => {
    const { service, tx } = setup();

    const view = await service.erase(GUEST_ID, REASON, actorFixture(), CTX);

    expect(tx.guestConsent.deleteMany).toHaveBeenCalledWith({ where: { guestId: GUEST_ID } });
    expect(view.consentsDeleted).toBe(2);

    // Immediately, inside the 90 days §11.6 would otherwise allow: a visitorId is
    // an identifier tied to behaviour, and it does not outlive the person.
    const severed = tx.attributionSnapshot.update.mock.calls[0][0].data as Record<string, unknown>;
    expect(severed.visitorId).toBe(NULL_UUID);
    expect(severed.touches).toEqual([]);
    expect(severed.landingPath).toBeNull();
    expect(severed.prunedAt).toBeInstanceOf(Date);
    // Channel aggregates survive, the referrer and the landing URL do not —
    // the same reduction prune_attribution() makes at 90 days.
    expect(severed.firstTouch).toEqual({ source: 'google', medium: 'organic', campaign: null });
    expect(severed.lastTouch).toEqual({ source: 'instagram', medium: 'social', campaign: null });
    expect(view.attributionSnapshotsSevered).toBe(1);

    expect(tx.outboundClick.deleteMany).toHaveBeenCalledWith({
      where: { visitorId: { in: [VISITOR_ID] } },
    });
  });

  it('anonymises the enquiry inbox, which keeps the number in columns of its own', async () => {
    const { service, tx } = setup();

    await service.erase(GUEST_ID, REASON, actorFixture(), CTX);

    const [call] = tx.bookingRequest.updateMany.mock.calls;
    expect(call[0].where.OR).toEqual([{ guestId: GUEST_ID }, { guestPhone: '+971501234567' }]);
    expect(call[0].data).toEqual({
      guestName: ERASED_NAME,
      guestPhone: erasedPhoneToken('+971501234567', SALT),
      guestEmail: null,
      message: null,
    });
  });

  it('keeps every financial row, and reports what it kept', async () => {
    const { service, tx } = setup();

    const view = await service.erase(GUEST_ID, REASON, actorFixture(), CTX);

    // The reason this endpoint is an anonymisation at all: UAE tax law requires
    // five years of accounting records, and the right to erasure yields to it.
    expect(tx.payment.deleteMany).not.toHaveBeenCalled();
    expect(tx.tip.deleteMany).not.toHaveBeenCalled();
    expect(tx.therapistPayoutLedger.deleteMany).not.toHaveBeenCalled();
    expect(tx.reservation.deleteMany).not.toHaveBeenCalled();
    expect(tx.guest.deleteMany).not.toHaveBeenCalled();

    expect(view.financialRecordsRetained).toEqual({
      reservations: 1,
      payments: 5,
      tips: 2,
      ledgerEntries: 2,
    });
  });

  it('clears the free text on the bookings it leaves behind', async () => {
    const { service, tx } = setup();

    const view = await service.erase(GUEST_ID, REASON, actorFixture(), CTX);

    const [call] = tx.reservation.updateMany.mock.calls;
    expect(call[0].data).toEqual({ notes: null });
    expect(view.reservationNotesCleared).toBe(3);
  });

  it('audits the erasure on the same transaction, with the reason and no PII', async () => {
    const { service, tx } = setup();

    await service.erase(GUEST_ID, REASON, actorFixture(), CTX);

    const entry = tx.financialAuditLog.create.mock.calls[0][0].data as Record<string, unknown>;
    expect(entry.action).toBe('GUEST_ERASED');
    expect(entry.entityId).toBe(GUEST_ID);
    expect(entry.actorUserId).toBe(USER_ID);
    expect((entry.afterState as { reason: string }).reason).toBe(REASON);

    // The audit log is not the place to keep a copy of the thing we were asked
    // to destroy: it records THAT there was an email, never what it was.
    const serialised = JSON.stringify([entry.beforeState, entry.afterState]);
    expect(serialised).not.toContain('Amira');
    expect(serialised).not.toContain('501234567');
    expect(serialised).not.toContain('amira@example.ae');
    expect((entry.beforeState as { hadEmail: boolean }).hadEmail).toBe(true);
  });

  it('refuses a second erasure rather than hashing the hash', async () => {
    const { service, tx } = setup({
      guest: guestFixture({
        fullName: ERASED_NAME,
        phone: erasedPhoneToken('+971501234567', SALT),
        anonymisedAt: new Date('2026-09-01T10:00:00.000Z'),
        deletedAt: new Date('2026-09-01T10:00:00.000Z'),
      }),
    });

    const error = await service.erase(GUEST_ID, REASON, actorFixture(), CTX).catch((e) => e);

    expect((error as HttpException).getStatus()).toBe(409);
    expect(codeOf(error)).toBe(ErrorCode.GUEST_ALREADY_ERASED);
    // Nothing was written: a second pass would hash the hash, and
    // `erased:sha256("erased:abc..." + salt)` matches no number that ever existed.
    expect(tx.guest.update).not.toHaveBeenCalled();
  });

  it('404s a guest from another branch, exactly as if it never existed', async () => {
    const { service } = setup({ guest: null });

    const error = await service.erase(GUEST_ID, REASON, actorFixture(), CTX).catch((e) => e);
    expect((error as HttpException).getStatus()).toBe(404);
    expect(codeOf(error)).toBe(ErrorCode.NOT_FOUND);
  });

  it('disambiguates rather than refusing when the token is already taken', async () => {
    // The same number given again by a new walk-in, erased a second time. A
    // uniqueness artefact is not a reason to refuse a lawful erasure request.
    const { service, tx } = setup({ tokenTaken: true });

    const view = await service.erase(GUEST_ID, REASON, actorFixture(), CTX);

    const base = erasedPhoneToken('+971501234567', SALT);
    expect(view.phoneToken).toBe(`${base}.${GUEST_ID.slice(0, 8)}`);
    // Still prefix-matches, which is what every lookup uses.
    expect(view.phoneToken.startsWith(base)).toBe(true);
    expect((tx.guest.update.mock.calls[0][0].data as { phone: string }).phone).toBe(view.phoneToken);
  });

  it('does all of it in one transaction', async () => {
    const { service, prisma } = setup();
    await service.erase(GUEST_ID, REASON, actorFixture(), CTX);
    // A half-erased guest — name gone, consents standing — is worse than either end.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('handles a guest with no bookings and no attribution at all', async () => {
    const { service, tx } = setup({ snapshots: [], reservationIds: [] });

    const view = await service.erase(GUEST_ID, REASON, actorFixture(), CTX);

    expect(view.attributionSnapshotsSevered).toBe(0);
    expect(view.outboundClicksDeleted).toBe(0);
    expect(tx.outboundClick.deleteMany).not.toHaveBeenCalled();
    expect(view.financialRecordsRetained).toEqual({
      reservations: 0,
      payments: 0,
      tips: 0,
      ledgerEntries: 0,
    });
  });
});

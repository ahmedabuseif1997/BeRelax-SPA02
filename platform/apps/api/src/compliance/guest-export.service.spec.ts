import { HttpException } from '@nestjs/common';
import type {
  AttributionSnapshot,
  BookingRequest,
  Guest,
  GuestConsent,
  Payment,
  Tip,
} from '@prisma/client';
import type { ApiErrorBody } from '@berelax/contracts';
import { ConsentType, ErrorCode, UserRole } from '@berelax/contracts';
import { AuditService } from '../common/audit.service';
import type { AuthUser, RequestContext } from '../common/request-context';
import type { PrismaService } from '../prisma/prisma.service';
import { EXPORT_FORMAT_VERSION, GuestExportService } from './guest-export.service';

/**
 * §11.4, Arts. 13-15. The assertion that matters is not that the bundle has the
 * right shape — it is that nothing the database holds about this person is
 * missing from it. A partial export is a failed request, so every section is
 * asserted to be populated and the counts are asserted to agree with what was
 * read.
 */

const GUEST_ID = '0192aaaa-0000-7000-8000-00000000000a';
const BRANCH_ID = '0192bbbb-0000-7000-8000-00000000000b';
const USER_ID = '0192dddd-0000-7000-8000-00000000000d';
const RESERVATION_ID = '0192f8a1-0000-7000-8000-000000000001';
const SNAPSHOT_ID = '0192eeee-0000-7000-8000-00000000000e';

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

const CONSENT: GuestConsent = {
  id: '0192cccc-0000-7000-8000-000000000011',
  guestId: GUEST_ID,
  type: ConsentType.MARKETING,
  granted: true,
  grantedAt: new Date('2026-02-01T18:00:00.000Z'),
  withdrawnAt: null,
  source: 'reception-ipad',
  policyVersion: '2026-01',
  ipAddress: '10.0.0.8',
};

const RESERVATION = {
  id: RESERVATION_ID,
  ref: 'BR-2026-0417',
  branchId: BRANCH_ID,
  guestId: GUEST_ID,
  employeeId: '0192cccc-0000-7000-8000-00000000000c',
  roomId: '0192cccc-0000-7000-8000-00000000000r',
  serviceId: '0192cccc-0000-7000-8000-00000000000s',
  startsAt: new Date('2026-09-16T15:00:00.000Z'),
  durationMinutes: 60,
  endsAt: new Date('2026-09-16T16:00:00.000Z'),
  blockedUntil: new Date('2026-09-16T16:15:00.000Z'),
  businessDay: new Date('2026-09-16T00:00:00.000Z'),
  status: 'COMPLETED',
  baseCostFils: 25_000,
  sourceChannel: 'WEBSITE_FORM',
  attributionId: SNAPSHOT_ID,
  actualArrivalAt: new Date('2026-09-16T14:55:00.000Z'),
  completedAt: new Date('2026-09-16T16:02:00.000Z'),
  cancelledAt: null,
  cancellationReason: null,
  notes: 'Requests Maya',
  createdByUserId: USER_ID,
  createdAt: new Date('2026-09-10T08:00:00.000Z'),
  updatedAt: new Date('2026-09-16T16:02:00.000Z'),
  service: { id: '0192cccc-0000-7000-8000-00000000000s', name: 'Normal Massage — 60 min' },
  employee: { displayName: 'Maya' },
  room: { name: 'Suite 1' },
};

const PAYMENT: Payment = {
  id: '0192aaaa-0000-7000-8000-0000000000p1',
  branchId: BRANCH_ID,
  reservationId: RESERVATION_ID,
  kind: 'BASE',
  method: 'CARD',
  amountFils: 25_000,
  businessDay: new Date('2026-09-16T00:00:00.000Z'),
  collectedByUserId: USER_ID,
  collectedAt: new Date('2026-09-16T14:58:00.000Z'),
  createdAt: new Date('2026-09-16T14:58:00.000Z'),
  externalRef: 'TERM-99182',
  reversesPaymentId: null,
  note: null,
  idempotencyKey: null,
};

const TIP: Tip = {
  id: '0192aaaa-0000-7000-8000-0000000000t1',
  branchId: BRANCH_ID,
  reservationId: RESERVATION_ID,
  employeeId: '0192cccc-0000-7000-8000-00000000000c',
  type: 'COLLECTED_BY_BUSINESS',
  amountFils: 5_000,
  method: 'CARD',
  paymentId: '0192aaaa-0000-7000-8000-0000000000p2',
  businessDay: new Date('2026-09-16T00:00:00.000Z'),
  recordedByUserId: USER_ID,
  recordedAt: new Date('2026-09-16T16:05:00.000Z'),
  reversedByTipId: null,
  note: null,
};

const REQUEST_LINKED: BookingRequest = {
  id: '0192aaaa-0000-7000-8000-0000000000r1',
  branchId: BRANCH_ID,
  guestId: GUEST_ID,
  guestName: 'Amira Khan',
  guestPhone: '+971501234567',
  guestEmail: 'amira@example.ae',
  requestedServiceId: null,
  requestedAt: new Date('2026-09-09T12:00:00.000Z'),
  message: 'Any time after 9pm please',
  status: 'CONVERTED',
  sourceChannel: 'WEBSITE_FORM',
  attributionId: null,
  convertedReservationId: RESERVATION_ID,
  handledByUserId: USER_ID,
  handledAt: new Date('2026-09-09T12:30:00.000Z'),
  createdAt: new Date('2026-09-09T12:00:00.000Z'),
};

/** Never linked to the guest row — matched only by the number it carries. */
const REQUEST_BY_PHONE: BookingRequest = {
  ...REQUEST_LINKED,
  id: '0192aaaa-0000-7000-8000-0000000000r2',
  guestId: null,
  status: 'NEW',
  convertedReservationId: null,
  handledByUserId: null,
  handledAt: null,
};

const SNAPSHOT: AttributionSnapshot & {
  reservations: Array<{ id: string }>;
  bookingRequest: { id: string; guestId: string | null } | null;
} = {
  id: SNAPSHOT_ID,
  visitorId: '0192ffff-0000-7000-8000-00000000000f',
  firstTouch: { source: 'google', medium: 'organic' },
  lastTouch: { source: 'instagram', medium: 'social' },
  touches: [{ source: 'google', medium: 'organic' }],
  touchCount: 1,
  firstSeenAt: new Date('2026-09-01T10:00:00.000Z'),
  lastSeenAt: new Date('2026-09-09T11:00:00.000Z'),
  landingPath: '/offers',
  capturedAt: new Date('2026-09-09T12:00:00.000Z'),
  prunedAt: null,
  reservations: [{ id: RESERVATION_ID }],
  bookingRequest: { id: REQUEST_LINKED.id, guestId: GUEST_ID },
};

function actorFixture(role: UserRole = UserRole.MANAGER): AuthUser {
  return { id: USER_ID, role, branchId: BRANCH_ID, email: 'manager@berelax.ae', fullName: 'Manager' };
}

const CTX: RequestContext = {
  requestId: 'req_01JBQ7X8',
  branchId: BRANCH_ID,
  actorUserId: USER_ID,
  actorRole: UserRole.MANAGER,
};

type Tx = {
  guest: { findFirst: jest.Mock };
  guestConsent: { findMany: jest.Mock };
  reservation: { findMany: jest.Mock };
  payment: { findMany: jest.Mock };
  tip: { findMany: jest.Mock };
  bookingRequest: { findMany: jest.Mock };
  attributionSnapshot: { findMany: jest.Mock };
  financialAuditLog: { create: jest.Mock };
};

function setup(options: { guest?: Guest | null; empty?: boolean } = {}) {
  const guest = options.guest === undefined ? guestFixture() : options.guest;
  const empty = options.empty ?? false;

  const tx: Tx = {
    guest: { findFirst: jest.fn(async () => guest) },
    guestConsent: { findMany: jest.fn(async () => (empty ? [] : [CONSENT])) },
    reservation: { findMany: jest.fn(async () => (empty ? [] : [RESERVATION])) },
    payment: { findMany: jest.fn(async () => (empty ? [] : [PAYMENT])) },
    tip: { findMany: jest.fn(async () => (empty ? [] : [TIP])) },
    bookingRequest: {
      findMany: jest.fn(async () => (empty ? [] : [REQUEST_LINKED, REQUEST_BY_PHONE])),
    },
    attributionSnapshot: { findMany: jest.fn(async () => (empty ? [] : [SNAPSHOT])) },
    financialAuditLog: { create: jest.fn(async () => ({})) },
  };

  const prisma = {
    $transaction: jest.fn(async (cb: (client: Tx) => Promise<unknown>) => cb(tx)),
  } as unknown as PrismaService;

  return { service: new GuestExportService(prisma, new AuditService()), tx, prisma };
}

describe('GuestExportService.export', () => {
  it('returns every category the guest is present in, and nothing is empty', async () => {
    const { service } = setup();

    const bundle = await service.export(GUEST_ID, actorFixture(), CTX);

    // The completeness claim, section by section. A bundle missing any one of
    // these is a failed access request, not a smaller one.
    expect(bundle.guest.id).toBe(GUEST_ID);
    expect(bundle.consents).toHaveLength(1);
    expect(bundle.reservations).toHaveLength(1);
    expect(bundle.payments).toHaveLength(1);
    expect(bundle.tips).toHaveLength(1);
    expect(bundle.bookingRequests).toHaveLength(2);
    expect(bundle.attributionSnapshots).toHaveLength(1);
    expect(bundle.counts).toEqual({
      consents: 1,
      reservations: 1,
      payments: 1,
      tips: 1,
      bookingRequests: 2,
      attributionSnapshots: 1,
    });
  });

  it('carries the consent policy version and the timestamps that make it proof', async () => {
    const { service } = setup();

    const [consent] = (await service.export(GUEST_ID, actorFixture(), CTX)).consents;

    expect(consent).toMatchObject({
      type: ConsentType.MARKETING,
      granted: true,
      policyVersion: '2026-01',
      grantedAt: '2026-02-01T18:00:00.000Z',
      withdrawnAt: null,
      source: 'reception-ipad',
    });
  });

  it('is machine-readable: ISO timestamps, integer fils, resolved names', async () => {
    const { service } = setup();

    const bundle = await service.export(GUEST_ID, actorFixture(), CTX);

    expect(bundle.reservations[0]).toMatchObject({
      ref: 'BR-2026-0417',
      serviceName: 'Normal Massage — 60 min',
      // The display name, never `legalName` — that is employee data. §6.4.
      therapist: 'Maya',
      room: 'Suite 1',
      startsAt: '2026-09-16T15:00:00.000Z',
      businessDay: '2026-09-16',
      baseCostFils: 25_000,
    });
    expect(bundle.payments[0]).toMatchObject({ amountFils: 25_000, reservationRef: 'BR-2026-0417' });
    expect(bundle.tips[0]).toMatchObject({ amountFils: 5_000, type: 'COLLECTED_BY_BUSINESS' });
    expect(bundle.meta.formatVersion).toBe(EXPORT_FORMAT_VERSION);
  });

  it('includes an enquiry that carries the number but was never linked, and says so', async () => {
    const { service, tx } = setup();

    const bundle = await service.export(GUEST_ID, actorFixture(), CTX);

    expect(tx.bookingRequest.findMany.mock.calls[0][0].where.OR).toEqual([
      { guestId: GUEST_ID },
      { guestPhone: '+971501234567' },
    ]);
    const byPhone = bundle.bookingRequests.find((r) => r.id === REQUEST_BY_PHONE.id);
    expect(byPhone?.matchedByPhone).toBe(true);
    expect(bundle.bookingRequests.find((r) => r.id === REQUEST_LINKED.id)?.matchedByPhone).toBe(
      false,
    );
  });

  it('links each attribution snapshot back to the bookings it belongs to', async () => {
    const { service } = setup();

    const [snapshot] = (await service.export(GUEST_ID, actorFixture(), CTX)).attributionSnapshots;

    expect(snapshot?.linkedReservationIds).toEqual([RESERVATION_ID]);
    expect(snapshot?.linkedBookingRequestIds).toEqual([REQUEST_LINKED.id]);
    expect(snapshot?.visitorId).toBe(SNAPSHOT.visitorId);
  });

  it('audits the export with counts, never with contents', async () => {
    const { service, tx, prisma } = setup();

    await service.export(GUEST_ID, actorFixture(), CTX);

    const entry = tx.financialAuditLog.create.mock.calls[0][0].data as Record<string, unknown>;
    expect(entry.action).toBe('GUEST_DATA_EXPORTED');
    expect(entry.entityType).toBe('Guest');
    expect(entry.entityId).toBe(GUEST_ID);
    expect(entry.actorUserId).toBe(USER_ID);
    expect(entry.requestId).toBe(CTX.requestId);

    const serialised = JSON.stringify(entry.afterState);
    expect(serialised).not.toContain('Amira');
    expect(serialised).not.toContain('501234567');
    expect(JSON.parse(serialised)).toMatchObject({ reservations: 1, payments: 1 });

    // Reads and audit row on one transaction, so a booking taken mid-export
    // cannot land in one array and miss another.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('says out loud what it does not contain', async () => {
    const { service } = setup();

    const { meta } = await service.export(GUEST_ID, actorFixture(), CTX);

    expect(meta.notIncluded.join(' ')).toMatch(/health/i);
    expect(meta.exportedByUserId).toBe(USER_ID);
    expect(meta.requestId).toBe(CTX.requestId);
  });

  it('exports an already-erased guest as the shell it now is, rather than 404ing', async () => {
    const anonymisedAt = new Date('2026-09-17T09:00:00.000Z');
    const { service } = setup({
      guest: guestFixture({
        fullName: 'Erased guest',
        phone: 'erased:0123456789abcdef01234567',
        email: null,
        notes: null,
        anonymisedAt,
        deletedAt: anonymisedAt,
      }),
      empty: true,
    });

    const bundle = await service.export(GUEST_ID, actorFixture(), CTX);

    // The honest answer to "what do you still hold about this id".
    expect(bundle.guest.anonymisedAt).toBe(anonymisedAt.toISOString());
    expect(bundle.guest.email).toBeNull();
    expect(bundle.counts.consents).toBe(0);
  });

  it('404s a guest from another branch', async () => {
    const { service } = setup({ guest: null });

    const error = await service.export(GUEST_ID, actorFixture(), CTX).catch((e) => e);

    expect((error as HttpException).getStatus()).toBe(404);
    expect(((error as HttpException).getResponse() as ApiErrorBody).error.code).toBe(
      ErrorCode.NOT_FOUND,
    );
  });
});

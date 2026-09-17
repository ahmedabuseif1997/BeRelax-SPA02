import { HttpException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { BookingRequest, Reservation } from '@prisma/client';
import type { ApiErrorBody, ConvertBookingRequestDto } from '@berelax/contracts';
import { ErrorCode, UserRole } from '@berelax/contracts';
import { AuditService } from '../common/audit.service';
import type { AuthUser, RequestContext } from '../common/request-context';
import type { Env } from '../config/env';
import type { PrismaService } from '../prisma/prisma.service';
import { BookingRequestsService, publicReference } from './booking-requests.service';

const REQUEST_ID = '0192aaaa-0000-7000-8000-000000000001';
const OTHER_REQUEST_ID = '0192aaaa-0000-7000-8000-000000000002';
const RESERVATION_ID = '0192f8a1-0000-7000-8000-000000000001';
const BRANCH_ID = '0192bbbb-0000-7000-8000-00000000000b';
const EMPLOYEE_ID = '0192cccc-0000-7000-8000-00000000000c';
const ROOM_ID = '0192ffff-0000-7000-8000-00000000000f';
const SERVICE_ID = '0192eeee-0000-7000-8000-00000000000e';
const OTHER_SERVICE_ID = '0192eeee-0000-7000-8000-000000000011';
const GUEST_ID = '0192dddd-0000-7000-8000-00000000000a';
const USER_ID = '0192dddd-0000-7000-8000-00000000000d';
const ATTRIBUTION_ID = '0192e7e7-0000-7000-8000-000000000007';

const SALT = 'test-erasure-salt-0123456789';

function requestFixture(overrides: Partial<BookingRequest> = {}): BookingRequest {
  return {
    id: REQUEST_ID,
    branchId: BRANCH_ID,
    guestId: null,
    guestName: 'Amira Khan',
    guestPhone: '+971501234567',
    guestEmail: 'amira@example.com',
    requestedServiceId: SERVICE_ID,
    requestedAt: new Date('2026-09-16T19:00:00+04:00'),
    message: 'Prefers a female therapist.',
    status: 'NEW',
    sourceChannel: 'WEBSITE_FORM',
    attributionId: ATTRIBUTION_ID,
    convertedReservationId: null,
    handledByUserId: null,
    handledAt: null,
    createdAt: new Date('2026-09-15T12:00:00.000Z'),
    ...overrides,
  };
}

function reservationFixture(overrides: Partial<Reservation> = {}): Reservation {
  const startsAt = new Date('2026-09-16T19:00:00+04:00');
  return {
    id: RESERVATION_ID,
    ref: 'BR-2026-0417',
    branchId: BRANCH_ID,
    guestId: GUEST_ID,
    employeeId: EMPLOYEE_ID,
    roomId: null,
    serviceId: SERVICE_ID,
    startsAt,
    durationMinutes: 60,
    endsAt: new Date('2026-09-16T20:00:00+04:00'),
    blockedUntil: new Date('2026-09-16T20:15:00+04:00'),
    businessDay: new Date('2026-09-16T00:00:00.000Z'),
    status: 'SCHEDULED',
    baseCostFils: 25_000,
    sourceChannel: 'WEBSITE_FORM',
    attributionId: ATTRIBUTION_ID,
    actualArrivalAt: null,
    completedAt: null,
    cancelledAt: null,
    cancellationReason: null,
    notes: null,
    createdByUserId: USER_ID,
    createdAt: new Date('2026-09-15T12:00:00.000Z'),
    updatedAt: new Date('2026-09-15T12:00:00.000Z'),
    ...overrides,
  };
}

function actorFixture(role: UserRole = UserRole.RECEPTIONIST): AuthUser {
  return {
    id: USER_ID,
    role,
    branchId: BRANCH_ID,
    employeeId: null,
    email: 'reception@berelax.ae',
    fullName: 'Reception',
  };
}

const CTX: RequestContext = {
  requestId: 'req_01JBQ7X8',
  branchId: BRANCH_ID,
  actorUserId: USER_ID,
  actorRole: UserRole.RECEPTIONIST,
};

function convertDto(overrides: Partial<ConvertBookingRequestDto> = {}): ConvertBookingRequestDto {
  return {
    employeeId: EMPLOYEE_ID,
    startsAt: '2026-09-16T19:00:00+04:00',
    ...overrides,
  };
}

type Tx = {
  $queryRaw: jest.Mock;
  service: { findFirst: jest.Mock };
  room: { findFirst: jest.Mock };
  employee: { findFirst: jest.Mock };
  guest: { upsert: jest.Mock };
  bookingRequest: {
    findUniqueOrThrow: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
  };
  reservation: {
    create: jest.Mock;
    findMany: jest.Mock;
    findFirst: jest.Mock;
    count: jest.Mock;
    aggregate: jest.Mock;
  };
  financialAuditLog: { create: jest.Mock };
};

function setup(
  options: {
    request?: BookingRequest;
    /** What the FOR UPDATE lock finds. */
    found?: boolean;
    nextSeq?: number;
    serviceMissing?: boolean;
  roomMissing?: boolean;
    employeeMissing?: boolean;
    servicePriceFils?: number;
    serviceDurationMinutes?: number;
    inboxRows?: (BookingRequest & { service?: unknown })[];
  } = {},
) {
  const request = options.request ?? requestFixture();

  const tx: Tx = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      if (strings.join('').includes('nextval')) return [{ seq: BigInt(options.nextSeq ?? 417) }];
      return options.found === false ? [] : [{ id: request.id }];
    }),
    // The room is resolved in branch and active on this path too — a security
    // review found it was taken straight from the body.
    room: {
      findFirst: jest.fn().mockResolvedValue(
        options.roomMissing ? null : { id: ROOM_ID },
      ),
    },
    service: {
      findFirst: jest.fn().mockResolvedValue(
        options.serviceMissing
          ? null
          : {
              id: SERVICE_ID,
              branchId: BRANCH_ID,
              priceFils: options.servicePriceFils ?? 25_000,
              durationMinutes: options.serviceDurationMinutes ?? 60,
              isActive: true,
            },
      ),
    },
    employee: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          options.employeeMissing ? null : { id: EMPLOYEE_ID, branchId: BRANCH_ID },
        ),
    },
    guest: { upsert: jest.fn().mockResolvedValue({ id: GUEST_ID, branchId: BRANCH_ID }) },
    bookingRequest: {
      findUniqueOrThrow: jest.fn().mockResolvedValue(request),
      findFirst: jest.fn().mockResolvedValue(request),
      findMany: jest.fn().mockResolvedValue(options.inboxRows ?? [request]),
      update: jest.fn(async ({ data }: { data: Partial<BookingRequest> }) => ({
        ...request,
        ...data,
      })),
    },
    reservation: {
      // Stands in for trg_reservations_derive, which overwrites the three
      // placeholder columns before the row lands. §5.3.
      create: jest.fn(async ({ data }: { data: Reservation }) => {
        const startsAt = new Date(data.startsAt);
        const endsAt = new Date(startsAt.getTime() + data.durationMinutes * 60_000);
        return reservationFixture({
          ...data,
          endsAt,
          blockedUntil: new Date(endsAt.getTime() + 15 * 60_000),
          businessDay: new Date('2026-09-16T00:00:00.000Z'),
        });
      }),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      aggregate: jest.fn().mockResolvedValue({ _sum: {} }),
    },
    financialAuditLog: { create: jest.fn().mockResolvedValue({}) },
  };

  const prisma = {
    $transaction: jest.fn(async (cb: (client: Tx) => Promise<unknown>) => cb(tx)),
    bookingRequest: tx.bookingRequest,
  } as unknown as PrismaService;

  const config = { get: () => SALT } as unknown as ConfigService<Env, true>;

  return { tx, prisma, service: new BookingRequestsService(prisma, new AuditService(), config) };
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

/** The exclusion violation the database raises when the therapist is already taken. §5.2. */
function exclusionViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    'conflicting key value violates exclusion constraint "reservations_no_therapist_overlap" (23P01)',
    { code: 'P2010', clientVersion: '5.22.0' },
  );
}

describe('BookingRequestsService', () => {
  describe('the inbox', () => {
    it('lists this branch’s enquiries newest first', async () => {
      const { service, tx } = setup();

      await service.findMany({ limit: 50 }, actorFixture());

      const args = tx.bookingRequest.findMany.mock.calls[0]![0] as {
        where: Record<string, unknown>;
        orderBy: Record<string, string>;
        take: number;
      };
      expect(args.where).toEqual({ branchId: BRANCH_ID });
      expect(args.orderBy).toEqual({ createdAt: 'desc' });
      expect(args.take).toBe(50);
    });

    it('filters by status when reception is working the NEW pile', async () => {
      const { service, tx } = setup();

      await service.findMany({ status: 'NEW', limit: 20 }, actorFixture());

      const { where, take } = tx.bookingRequest.findMany.mock.calls[0]![0] as {
        where: Record<string, unknown>;
        take: number;
      };
      expect(where).toEqual({ branchId: BRANCH_ID, status: 'NEW' });
      expect(take).toBe(20);
    });

    it('shows the guest’s reference beside the row, not the primary key', async () => {
      const { service } = setup();

      const [row] = await service.findMany({ limit: 50 }, actorFixture());

      expect(row!.reference).toBe(publicReference(REQUEST_ID, SALT));
      expect(row!.reference).not.toContain(REQUEST_ID);
      expect(row!.reference).toMatch(/^BRX-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    });

    it('404s on an enquiry from another branch', async () => {
      const { service, tx } = setup();
      tx.bookingRequest.findFirst.mockResolvedValue(null);

      const { status, body } = await caught(() => service.findOne(REQUEST_ID, actorFixture()));

      expect(status).toBe(404);
      expect(body.error.code).toBe(ErrorCode.BOOKING_REQUEST_NOT_FOUND);
    });
  });

  describe('publicReference', () => {
    it('is stable for the same enquiry', () => {
      expect(publicReference(REQUEST_ID, SALT)).toBe(publicReference(REQUEST_ID, SALT));
    });

    it('differs between enquiries', () => {
      expect(publicReference(REQUEST_ID, SALT)).not.toBe(publicReference(OTHER_REQUEST_ID, SALT));
    });

    it('uses an alphabet with no I, L, O or U, so it survives being read aloud', () => {
      const ids = Array.from({ length: 200 }, (_, i) =>
        `0192aaaa-0000-7000-8000-${String(i).padStart(12, '0')}`,
      );
      for (const id of ids) {
        expect(publicReference(id, SALT)).not.toMatch(/[ILOU]/);
      }
    });
  });

  describe('convert — the enquiry becomes a held slot', () => {
    it('carries the attribution snapshot onto the reservation', async () => {
      // Without this the chain touch → request → reservation → payment breaks at
      // the one join the channel ROI report depends on. §10.3.
      const { service, tx } = setup();

      await service.convert(REQUEST_ID, convertDto(), actorFixture(), CTX);

      const { data } = tx.reservation.create.mock.calls[0]![0] as { data: Reservation };
      expect(data.attributionId).toBe(ATTRIBUTION_ID);
    });

    it('marks the request CONVERTED and records who handled it, when', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-09-15T14:30:00.000Z'));
      try {
        const { service, tx } = setup();

        const { request } = await service.convert(REQUEST_ID, convertDto(), actorFixture(), CTX);

        const { data } = tx.bookingRequest.update.mock.calls[0]![0] as {
          data: Record<string, unknown>;
        };
        expect(data.status).toBe('CONVERTED');
        expect(data.convertedReservationId).toBe(RESERVATION_ID);
        expect(data.handledByUserId).toBe(USER_ID);
        expect(data.handledAt).toEqual(new Date('2026-09-15T14:30:00.000Z'));
        expect(request.status).toBe('CONVERTED');
      } finally {
        jest.useRealTimers();
      }
    });

    it('does it all in one transaction', async () => {
      const { service, prisma } = setup();

      await service.convert(REQUEST_ID, convertDto(), actorFixture(), CTX);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('never queries for a conflicting booking before inserting', async () => {
      // The availability grid is a hint; the exclusion constraints decide. §5.5.
      const { service, tx } = setup();

      await service.convert(REQUEST_ID, convertDto(), actorFixture(), CTX);

      expect(tx.reservation.findMany).not.toHaveBeenCalled();
      expect(tx.reservation.findFirst).not.toHaveBeenCalled();
      expect(tx.reservation.count).not.toHaveBeenCalled();
      expect(tx.reservation.aggregate).not.toHaveBeenCalled();
      expect(tx.reservation.create).toHaveBeenCalledTimes(1);
    });

    it('leaves the request NEW when the slot has gone, and lets the 409 through', async () => {
      // The whole transaction rolls back, so the enquiry is still in the inbox
      // for reception to rebook — which is the only reason this is one
      // transaction rather than two.
      const { service, tx } = setup();
      const violation = exclusionViolation();
      tx.reservation.create.mockRejectedValue(violation);

      await expect(
        service.convert(REQUEST_ID, convertDto(), actorFixture(), CTX),
      ).rejects.toBe(violation);

      expect(tx.bookingRequest.update).not.toHaveBeenCalled();
      expect(tx.financialAuditLog.create).not.toHaveBeenCalled();
    });

    it('takes the branch from the token and the price from the catalogue', async () => {
      const { service, tx } = setup({ servicePriceFils: 31_500 });

      await service.convert(REQUEST_ID, convertDto(), actorFixture(), CTX);

      const { data } = tx.reservation.create.mock.calls[0]![0] as { data: Reservation };
      expect(data.branchId).toBe(BRANCH_ID);
      expect(data.baseCostFils).toBe(31_500);
      expect(data.createdByUserId).toBe(USER_ID);
    });

    it('keeps the channel the enquiry arrived on, not the desk that typed it in', async () => {
      // Otherwise every website booking reports as a phone booking and the
      // channel report quietly credits the wrong thing.
      const { service, tx } = setup({
        request: requestFixture({ sourceChannel: 'WHATSAPP' }),
      });

      await service.convert(REQUEST_ID, convertDto(), actorFixture(), CTX);

      const { data } = tx.reservation.create.mock.calls[0]![0] as { data: Reservation };
      expect(data.sourceChannel).toBe('WHATSAPP');
    });

    it('books the service the enquiry asked for when reception does not override it', async () => {
      const { service, tx } = setup();

      await service.convert(REQUEST_ID, convertDto(), actorFixture(), CTX);

      expect(tx.service.findFirst).toHaveBeenCalledWith({
        where: { id: SERVICE_ID, branchId: BRANCH_ID, isActive: true },
      });
    });

    it('lets reception override the treatment the guest picked on the website', async () => {
      const { service, tx } = setup();

      await service.convert(
        REQUEST_ID,
        convertDto({ serviceId: OTHER_SERVICE_ID }),
        actorFixture(),
        CTX,
      );

      expect(tx.service.findFirst).toHaveBeenCalledWith({
        where: { id: OTHER_SERVICE_ID, branchId: BRANCH_ID, isActive: true },
      });
    });

    it('422s on an enquiry that named no treatment and no replacement was given', async () => {
      const { service, tx } = setup({ request: requestFixture({ requestedServiceId: null }) });

      const { status, body } = await caught(() =>
        service.convert(REQUEST_ID, convertDto(), actorFixture(), CTX),
      );

      expect(status).toBe(422);
      expect(body.error.code).toBe(ErrorCode.VALIDATION_FAILED);
      expect(tx.reservation.create).not.toHaveBeenCalled();
    });

    it('carries the room and an explicit duration through', async () => {
      const { service, tx } = setup({ serviceDurationMinutes: 60 });

      await service.convert(
        REQUEST_ID,
        convertDto({ roomId: ROOM_ID, durationMinutes: 90 }),
        actorFixture(),
        CTX,
      );

      const { data } = tx.reservation.create.mock.calls[0]![0] as { data: Reservation };
      expect(data.roomId).toBe(ROOM_ID);
      expect(data.durationMinutes).toBe(90);
    });

    it('falls back to the service duration', async () => {
      const { service, tx } = setup({ serviceDurationMinutes: 90 });

      await service.convert(REQUEST_ID, convertDto(), actorFixture(), CTX);

      const { data } = tx.reservation.create.mock.calls[0]![0] as { data: Reservation };
      expect(data.durationMinutes).toBe(90);
    });

    it('finds the returning guest by phone instead of creating a twin', async () => {
      const { service, tx } = setup();

      await service.convert(REQUEST_ID, convertDto(), actorFixture(), CTX);

      expect(tx.guest.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { branchId_phone: { branchId: BRANCH_ID, phone: '+971501234567' } },
        }),
      );
      const { data } = tx.reservation.create.mock.calls[0]![0] as { data: Reservation };
      expect(data.guestId).toBe(GUEST_ID);
    });

    it('uses the guest the enquiry was already linked to', async () => {
      const { service, tx } = setup({ request: requestFixture({ guestId: GUEST_ID }) });

      await service.convert(REQUEST_ID, convertDto(), actorFixture(), CTX);

      expect(tx.guest.upsert).not.toHaveBeenCalled();
      const { data } = tx.reservation.create.mock.calls[0]![0] as { data: Reservation };
      expect(data.guestId).toBe(GUEST_ID);
    });

    it('links the guest back onto the enquiry, so their history joins up', async () => {
      const { service, tx } = setup();

      await service.convert(REQUEST_ID, convertDto(), actorFixture(), CTX);

      const { data } = tx.bookingRequest.update.mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(data.guestId).toBe(GUEST_ID);
    });

    it('404s on a service that is not on this branch’s menu', async () => {
      const { service, tx } = setup({ serviceMissing: true });

      const { status } = await caught(() =>
        service.convert(REQUEST_ID, convertDto(), actorFixture(), CTX),
      );

      expect(status).toBe(404);
      expect(tx.reservation.create).not.toHaveBeenCalled();
    });

    it('404s on a therapist who does not work at this branch', async () => {
      const { service } = setup({ employeeMissing: true });

      const { status } = await caught(() =>
        service.convert(REQUEST_ID, convertDto(), actorFixture(), CTX),
      );

      expect(status).toBe(404);
    });

    it('404s when the enquiry is not in this branch', async () => {
      const { service } = setup({ found: false });

      const { status, body } = await caught(() =>
        service.convert(REQUEST_ID, convertDto(), actorFixture(), CTX),
      );

      expect(status).toBe(404);
      expect(body.error.code).toBe(ErrorCode.BOOKING_REQUEST_NOT_FOUND);
    });

    it.each(['CONVERTED', 'DECLINED', 'SPAM'] as const)(
      '409s on an enquiry already marked %s',
      async (status) => {
        const { service, tx } = setup({ request: requestFixture({ status }) });

        const result = await caught(() =>
          service.convert(REQUEST_ID, convertDto(), actorFixture(), CTX),
        );

        expect(result.status).toBe(409);
        expect(result.body.error.code).toBe(ErrorCode.BOOKING_REQUEST_ALREADY_HANDLED);
        expect(tx.reservation.create).not.toHaveBeenCalled();
      },
    );

    it('still converts an enquiry reception has already phoned back', async () => {
      const { service, tx } = setup({ request: requestFixture({ status: 'CONTACTED' }) });

      await service.convert(REQUEST_ID, convertDto(), actorFixture(), CTX);

      expect(tx.reservation.create).toHaveBeenCalledTimes(1);
    });

    it('audits the booking it created, with the price it was taken at', async () => {
      const { service, tx } = setup({ servicePriceFils: 31_500 });

      await service.convert(REQUEST_ID, convertDto(), actorFixture(), CTX);

      const { data } = tx.financialAuditLog.create.mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(data).toMatchObject({
        action: 'RESERVATION_CREATED',
        entityType: 'Reservation',
        entityId: RESERVATION_ID,
        amountFils: 31_500,
        requestId: 'req_01JBQ7X8',
      });
    });

    it('mints the human-readable reference off the trading year', async () => {
      const { service, tx } = setup({ nextSeq: 3 });

      await service.convert(
        REQUEST_ID,
        convertDto({ startsAt: '2027-01-01T01:30:00+04:00' }),
        actorFixture(),
        CTX,
      );

      const { data } = tx.reservation.create.mock.calls[0]![0] as { data: Reservation };
      expect(data.ref).toBe('BR-2026-0003');
    });

    it('returns both halves, so the desk sees the booking it just made', async () => {
      const { service } = setup();

      const view = await service.convert(REQUEST_ID, convertDto(), actorFixture(), CTX);

      expect(view.reservation.ref).toBe('BR-2026-0417');
      expect(view.reservation.startsAt).toBe(
        new Date('2026-09-16T19:00:00+04:00').toISOString(),
      );
      expect(view.request.convertedReservationId).toBe(RESERVATION_ID);
    });
  });

  describe('decline and spam', () => {
    it('declines an open enquiry and records who did it', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-09-15T14:30:00.000Z'));
      try {
        const { service, tx } = setup();

        const view = await service.decline(REQUEST_ID, actorFixture());

        expect(tx.bookingRequest.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: {
              status: 'DECLINED',
              handledByUserId: USER_ID,
              handledAt: new Date('2026-09-15T14:30:00.000Z'),
            },
          }),
        );
        expect(view.status).toBe('DECLINED');
      } finally {
        jest.useRealTimers();
      }
    });

    it('marks junk as SPAM rather than DECLINED, so the lead count stays honest', async () => {
      const { service, tx } = setup();

      const view = await service.markSpam(REQUEST_ID, actorFixture());

      const { data } = tx.bookingRequest.update.mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(data.status).toBe('SPAM');
      expect(view.status).toBe('SPAM');
    });

    it('writes no audit entry: closing an enquiry moves no money', async () => {
      const { service, tx } = setup();

      await service.decline(REQUEST_ID, actorFixture());

      expect(tx.financialAuditLog.create).not.toHaveBeenCalled();
    });

    it('409s on an enquiry that has already become a booking', async () => {
      const { service, tx } = setup({ request: requestFixture({ status: 'CONVERTED' }) });

      const { status, body } = await caught(() => service.decline(REQUEST_ID, actorFixture()));

      expect(status).toBe(409);
      expect(body.error.code).toBe(ErrorCode.BOOKING_REQUEST_ALREADY_HANDLED);
      expect(tx.bookingRequest.update).not.toHaveBeenCalled();
    });

    it('404s when the enquiry is not in this branch', async () => {
      const { service } = setup({ found: false });

      const { status } = await caught(() => service.markSpam(REQUEST_ID, actorFixture()));

      expect(status).toBe(404);
    });
  });

  describe('a request holds no resource', () => {
    it('never touches the reservations table while merely closing one', async () => {
      // Nothing in the inbox can conflict with anything, so there is nothing to
      // check and nothing to release. §1.1.
      const { service, tx } = setup();

      await service.decline(REQUEST_ID, actorFixture());
      await service.findMany({ limit: 50 }, actorFixture());

      expect(tx.reservation.create).not.toHaveBeenCalled();
      expect(tx.reservation.findMany).not.toHaveBeenCalled();
    });
  });
});

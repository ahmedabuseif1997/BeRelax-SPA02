import { HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Reservation } from '@prisma/client';
import type { ApiErrorBody, CreateReservationDto } from '@berelax/contracts';
import { ErrorCode, UserRole } from '@berelax/contracts';
import { AuditService } from '../common/audit.service';
import type { AuthUser, RequestContext } from '../common/request-context';
import type { PrismaService } from '../prisma/prisma.service';
import { ReservationsService } from './reservations.service';

const RESERVATION_ID = '0192f8a1-0000-7000-8000-000000000001';
const BRANCH_ID = '0192bbbb-0000-7000-8000-00000000000b';
const OTHER_BRANCH_ID = '0192bbbb-0000-7000-8000-00000000000f';
const EMPLOYEE_ID = '0192cccc-0000-7000-8000-00000000000c';
const OTHER_EMPLOYEE_ID = '0192cccc-0000-7000-8000-00000000000f';
const SERVICE_ID = '0192eeee-0000-7000-8000-00000000000e';
const GUEST_ID = '0192aaaa-0000-7000-8000-00000000000a';
const USER_ID = '0192dddd-0000-7000-8000-00000000000d';

function reservationFixture(overrides: Partial<Reservation> = {}): Reservation {
  return {
    id: RESERVATION_ID,
    ref: 'BR-2026-0417',
    branchId: BRANCH_ID,
    guestId: null,
    employeeId: EMPLOYEE_ID,
    roomId: null,
    serviceId: SERVICE_ID,
    startsAt: new Date('2026-09-16T19:00:00+04:00'),
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

/** The relations the grid loads alongside a booking. */
const RELATIONS = {
  guest: { id: GUEST_ID, fullName: 'Amira Khan', phone: '+971501234567' },
  employee: { id: EMPLOYEE_ID, displayName: 'Layla' },
  service: { id: SERVICE_ID, name: 'Balinese Massage', durationMinutes: 60 },
  room: null,
};

function actorFixture(role: UserRole = UserRole.RECEPTIONIST, employeeId?: string): AuthUser {
  return {
    id: USER_ID,
    role,
    branchId: BRANCH_ID,
    employeeId: employeeId ?? null,
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

function createDto(overrides: Partial<CreateReservationDto> = {}): CreateReservationDto {
  return {
    employeeId: EMPLOYEE_ID,
    serviceId: SERVICE_ID,
    startsAt: '2026-09-16T19:00:00+04:00',
    sourceChannel: 'WALK_IN',
    ...overrides,
  };
}

type Tx = {
  $queryRaw: jest.Mock;
  service: { findFirst: jest.Mock };
  employee: { findFirst: jest.Mock };
  guest: { findFirst: jest.Mock; upsert: jest.Mock };
  reservation: {
    create: jest.Mock;
    update: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    aggregate: jest.Mock;
  };
  financialAuditLog: { create: jest.Mock };
};

function setup(
  options: {
    reservation?: Reservation;
    /** What the FOR UPDATE lock finds. */
    found?: boolean;
    nextSeq?: number;
    servicePriceFils?: number;
    serviceDurationMinutes?: number;
    serviceMissing?: boolean;
    employeeMissing?: boolean;
  } = {},
) {
  const reservation = options.reservation ?? reservationFixture();

  const tx: Tx = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      // The one raw statement that returns a value is nextval; the other is the
      // FOR UPDATE lock, which returns the id or nothing.
      if (strings.join('').includes('nextval')) return [{ seq: BigInt(options.nextSeq ?? 417) }];
      return options.found === false ? [] : [{ id: reservation.id }];
    }),
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
    guest: {
      findFirst: jest.fn().mockResolvedValue({ id: GUEST_ID, branchId: BRANCH_ID }),
      upsert: jest.fn().mockResolvedValue({ id: GUEST_ID, branchId: BRANCH_ID }),
    },
    reservation: {
      // Stands in for trg_reservations_derive: whatever the application sends
      // for endsAt, blockedUntil and businessDay is overwritten here, exactly as
      // the database overwrites it.
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
      update: jest.fn(async ({ data }: { data: Partial<Reservation> }) =>
        reservationFixture({ ...reservation, ...data }),
      ),
      findUniqueOrThrow: jest.fn().mockResolvedValue(reservation),
      // What Prisma hands back for the read paths, which ask for `include`.
      findFirst: jest.fn().mockResolvedValue({ ...reservation, ...RELATIONS }),
      findMany: jest.fn().mockResolvedValue([{ ...reservation, ...RELATIONS }]),
      count: jest.fn().mockResolvedValue(0),
      aggregate: jest.fn().mockResolvedValue({ _sum: {} }),
    },
    financialAuditLog: { create: jest.fn().mockResolvedValue({}) },
  };

  const prisma = {
    $transaction: jest.fn(async (cb: (client: Tx) => Promise<unknown>) => cb(tx)),
    reservation: tx.reservation,
  } as unknown as PrismaService;

  return { tx, service: new ReservationsService(prisma, new AuditService()) };
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

describe('ReservationsService', () => {
  describe('create — the constraint arbitrates, not a pre-check', () => {
    it('never queries for a conflicting booking before inserting', async () => {
      // A check-then-insert has a race window and will double-book on a busy
      // Friday when two receptionists tap Confirm in the same second. §5.5.
      const { service, tx } = setup();

      await service.create(createDto(), actorFixture(), CTX);

      expect(tx.reservation.findMany).not.toHaveBeenCalled();
      expect(tx.reservation.findFirst).not.toHaveBeenCalled();
      expect(tx.reservation.count).not.toHaveBeenCalled();
      expect(tx.reservation.aggregate).not.toHaveBeenCalled();
      expect(tx.reservation.create).toHaveBeenCalledTimes(1);
    });

    it('lets an exclusion violation out untouched, for the filter to translate', async () => {
      const { service, tx } = setup();
      const violation = new Prisma.PrismaClientKnownRequestError(
        'conflicting key value violates exclusion constraint "reservations_no_therapist_overlap" (23P01)',
        { code: 'P2010', clientVersion: '5.22.0' },
      );
      tx.reservation.create.mockRejectedValue(violation);

      await expect(service.create(createDto(), actorFixture(), CTX)).rejects.toBe(violation);
      expect(tx.financialAuditLog.create).not.toHaveBeenCalled();
    });

    it('takes branchId from the token and the price from the service catalogue', async () => {
      const { service, tx } = setup({ servicePriceFils: 31_500 });

      await service.create(
        // A body claiming another branch changes nothing: it is not read.
        { ...createDto(), branchId: OTHER_BRANCH_ID } as CreateReservationDto,
        actorFixture(),
        CTX,
      );

      const { data } = tx.reservation.create.mock.calls[0]![0] as { data: Reservation };
      expect(data.branchId).toBe(BRANCH_ID);
      expect(data.baseCostFils).toBe(31_500);
      expect(data.createdByUserId).toBe(USER_ID);
    });

    it('sends placeholders for the three trigger-maintained columns', async () => {
      const { service, tx } = setup();

      const view = await service.create(createDto(), actorFixture(), CTX);

      const { data } = tx.reservation.create.mock.calls[0]![0] as { data: Reservation };
      const startsAt = new Date('2026-09-16T19:00:00+04:00');
      expect(data.endsAt).toEqual(startsAt);
      expect(data.blockedUntil).toEqual(startsAt);
      expect(data.businessDay).toEqual(startsAt);
      // ...and reads back what the trigger actually wrote.
      expect(view.endsAt).toBe(new Date('2026-09-16T20:00:00+04:00').toISOString());
      expect(view.blockedUntil).toBe(new Date('2026-09-16T20:15:00+04:00').toISOString());
      expect(view.businessDay).toBe('2026-09-16');
    });

    it('falls back to the service duration when reception does not override it', async () => {
      const { service, tx } = setup({ serviceDurationMinutes: 90 });

      await service.create(createDto(), actorFixture(), CTX);

      const { data } = tx.reservation.create.mock.calls[0]![0] as { data: Reservation };
      expect(data.durationMinutes).toBe(90);
    });

    it('honours an explicit duration', async () => {
      const { service, tx } = setup({ serviceDurationMinutes: 90 });

      await service.create(createDto({ durationMinutes: 45 }), actorFixture(), CTX);

      const { data } = tx.reservation.create.mock.calls[0]![0] as { data: Reservation };
      expect(data.durationMinutes).toBe(45);
    });

    it('404s on a service that is not on this branch’s menu', async () => {
      const { service, tx } = setup({ serviceMissing: true });

      const { status } = await caught(() => service.create(createDto(), actorFixture(), CTX));

      expect(status).toBe(404);
      expect(tx.reservation.create).not.toHaveBeenCalled();
    });

    it('404s on a therapist who does not work at this branch', async () => {
      const { service } = setup({ employeeMissing: true });

      const { status } = await caught(() => service.create(createDto(), actorFixture(), CTX));

      expect(status).toBe(404);
    });

    it('books an anonymous walk-in with no guest row at all', async () => {
      const { service, tx } = setup();

      await service.create(createDto(), actorFixture(), CTX);

      const { data } = tx.reservation.create.mock.calls[0]![0] as { data: Reservation };
      expect(data.guestId).toBeNull();
      expect(tx.guest.upsert).not.toHaveBeenCalled();
    });

    it('finds the returning guest by phone instead of creating a twin', async () => {
      const { service, tx } = setup();

      await service.create(
        createDto({ guestName: 'Amira Khan', guestPhone: '+971501234567' }),
        actorFixture(),
        CTX,
      );

      expect(tx.guest.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { branchId_phone: { branchId: BRANCH_ID, phone: '+971501234567' } },
        }),
      );
      const { data } = tx.reservation.create.mock.calls[0]![0] as { data: Reservation };
      expect(data.guestId).toBe(GUEST_ID);
    });

    it('books an existing guest by id, scoped to this branch', async () => {
      const { service, tx } = setup();

      await service.create(createDto({ guestId: GUEST_ID }), actorFixture(), CTX);

      expect(tx.guest.findFirst).toHaveBeenCalledWith({
        where: { id: GUEST_ID, branchId: BRANCH_ID, deletedAt: null },
      });
      expect(tx.guest.upsert).not.toHaveBeenCalled();
      const { data } = tx.reservation.create.mock.calls[0]![0] as { data: Reservation };
      expect(data.guestId).toBe(GUEST_ID);
    });

    it('404s on a guest id from another branch', async () => {
      const { service, tx } = setup();
      tx.guest.findFirst.mockResolvedValue(null);

      const { status } = await caught(() =>
        service.create(createDto({ guestId: GUEST_ID }), actorFixture(), CTX),
      );

      expect(status).toBe(404);
    });

    it('audits the booking with the price it was taken at', async () => {
      const { service, tx } = setup({ servicePriceFils: 31_500 });

      await service.create(createDto(), actorFixture(), CTX);

      const { data } = tx.financialAuditLog.create.mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(data).toMatchObject({
        action: 'RESERVATION_CREATED',
        entityType: 'Reservation',
        amountFils: 31_500,
        requestId: 'req_01JBQ7X8',
      });
    });
  });

  describe('the human-readable reference', () => {
    it('pads the sequence to four digits behind the trading year', async () => {
      const { service, tx } = setup({ nextSeq: 417 });

      await service.create(createDto(), actorFixture(), CTX);

      const { data } = tx.reservation.create.mock.calls[0]![0] as { data: Reservation };
      expect(data.ref).toBe('BR-2026-0417');
    });

    it('takes the year from the trading day, so 01:30 on 1 January is last year’s', async () => {
      const { service, tx } = setup({ nextSeq: 3 });

      await service.create(
        createDto({ startsAt: '2027-01-01T01:30:00+04:00' }),
        actorFixture(),
        CTX,
      );

      const { data } = tx.reservation.create.mock.calls[0]![0] as { data: Reservation };
      expect(data.ref).toBe('BR-2026-0003');
    });

    it('fails loudly if the sequence is missing rather than minting a blank ref', async () => {
      const { service, tx } = setup();
      tx.$queryRaw.mockResolvedValue([]);

      await expect(service.create(createDto(), actorFixture(), CTX)).rejects.toThrow(
        /reservation_ref_seq/,
      );
      expect(tx.reservation.create).not.toHaveBeenCalled();
    });

    it('grows past four digits rather than truncating', async () => {
      const { service, tx } = setup({ nextSeq: 12_345 });

      await service.create(createDto(), actorFixture(), CTX);

      const { data } = tx.reservation.create.mock.calls[0]![0] as { data: Reservation };
      expect(data.ref).toBe('BR-2026-12345');
    });
  });

  describe('findMany — the booking grid', () => {
    it('defaults to today’s trading day', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-09-17T01:30:00+04:00'));
      try {
        const { service, tx } = setup();
        await service.findMany({}, actorFixture(UserRole.MANAGER));

        const { where } = tx.reservation.findMany.mock.calls[0]![0] as {
          where: Record<string, unknown>;
        };
        // 01:30 on the 17th still belongs to the 16th's trading day. §3.3.
        expect(where.businessDay).toEqual(new Date('2026-09-16T00:00:00.000Z'));
        expect(where.branchId).toBe(BRANCH_ID);
      } finally {
        jest.useRealTimers();
      }
    });

    it('carries the guest, therapist and service the grid needs, and no legal name', async () => {
      const { service } = setup();

      const [row] = await service.findMany({ businessDay: '2026-09-16' }, actorFixture());

      expect(row!.guest).toEqual(RELATIONS.guest);
      expect(row!.employee).toEqual({ id: EMPLOYEE_ID, displayName: 'Layla' });
      expect(row!.service).toEqual(RELATIONS.service);
      expect(row!.room).toBeNull();
    });

    it('passes a status filter straight through', async () => {
      const { service, tx } = setup();

      await service.findMany(
        { businessDay: '2026-09-16', status: 'IN_PROGRESS' },
        actorFixture(UserRole.MANAGER),
      );

      const { where } = tx.reservation.findMany.mock.calls[0]![0] as {
        where: Record<string, unknown>;
      };
      expect(where.status).toBe('IN_PROGRESS');
    });

    it('bounds an employee-filtered query by startsAt so it rides the index', async () => {
      const { service, tx } = setup();

      await service.findMany(
        { businessDay: '2026-09-16', employeeId: EMPLOYEE_ID },
        actorFixture(UserRole.MANAGER),
      );

      const { where } = tx.reservation.findMany.mock.calls[0]![0] as {
        where: { startsAt: { gte: Date; lt: Date } };
      };
      // The trading day runs 06:00 Dubai to 06:00 Dubai, i.e. 02:00Z to 02:00Z.
      expect(where.startsAt.gte).toEqual(new Date('2026-09-16T02:00:00.000Z'));
      expect(where.startsAt.lt).toEqual(new Date('2026-09-17T02:00:00.000Z'));
    });

    it('narrows a THERAPIST to their own bookings, whatever they ask for', async () => {
      const { service, tx } = setup();

      await service.findMany(
        { businessDay: '2026-09-16', employeeId: OTHER_EMPLOYEE_ID },
        actorFixture(UserRole.THERAPIST, EMPLOYEE_ID),
      );

      const { where } = tx.reservation.findMany.mock.calls[0]![0] as {
        where: { employeeId: string };
      };
      expect(where.employeeId).toBe(EMPLOYEE_ID);
    });

    it('shows a therapist login with no linked employee nothing, not everything', async () => {
      const { service, tx } = setup();

      const rows = await service.findMany({}, actorFixture(UserRole.THERAPIST));

      expect(rows).toEqual([]);
      expect(tx.reservation.findMany).not.toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    it('returns the booking for a manager', async () => {
      const { service } = setup();

      const view = await service.findOne(RESERVATION_ID, actorFixture(UserRole.MANAGER));

      expect(view.id).toBe(RESERVATION_ID);
      expect(view.ref).toBe('BR-2026-0417');
    });

    it('404s rather than 403s on another therapist’s booking', async () => {
      // 403 would confirm the booking exists. A therapist walking ids learns nothing.
      const { service } = setup();

      const { status, body } = await caught(() =>
        service.findOne(RESERVATION_ID, actorFixture(UserRole.THERAPIST, OTHER_EMPLOYEE_ID)),
      );

      expect(status).toBe(404);
      expect(body.error.code).toBe(ErrorCode.RESERVATION_NOT_FOUND);
    });

    it('lets a therapist read their own', async () => {
      const { service } = setup();

      const view = await service.findOne(
        RESERVATION_ID,
        actorFixture(UserRole.THERAPIST, EMPLOYEE_ID),
      );

      expect(view.id).toBe(RESERVATION_ID);
    });
  });

  describe('cancel', () => {
    it('lets reception cancel a scheduled booking, releasing the slot', async () => {
      const { service, tx } = setup();

      const view = await service.cancel(
        RESERVATION_ID,
        { reason: 'guest called' },
        actorFixture(),
        CTX,
      );

      const { data } = tx.reservation.update.mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(data.status).toBe('CANCELLED');
      expect(data.cancellationReason).toBe('guest called');
      expect(view.status).toBe('CANCELLED');
    });

    it('403s reception cancelling a treatment already under way', async () => {
      const { service, tx } = setup({ reservation: reservationFixture({ status: 'IN_PROGRESS' }) });

      const { status, body } = await caught(() =>
        service.cancel(RESERVATION_ID, { reason: 'guest unwell' }, actorFixture(), CTX),
      );

      expect(status).toBe(403);
      expect(body.error.code).toBe(ErrorCode.INSUFFICIENT_ROLE);
      expect(tx.reservation.update).not.toHaveBeenCalled();
    });

    it.each([UserRole.MANAGER, UserRole.OWNER])('lets a %s cancel one that is under way', async (role) => {
      const { service, tx } = setup({ reservation: reservationFixture({ status: 'IN_PROGRESS' }) });

      await service.cancel(RESERVATION_ID, { reason: 'guest unwell' }, actorFixture(role), CTX);

      expect(tx.reservation.update).toHaveBeenCalled();
    });

    it('refunds nothing on its own: a reversal is a separate, signed decision', async () => {
      const { service, tx } = setup({ reservation: reservationFixture({ status: 'IN_PROGRESS' }) });

      await service.cancel(
        RESERVATION_ID,
        { reason: 'guest unwell' },
        actorFixture(UserRole.MANAGER),
        CTX,
      );

      // Only the status write and the audit row. No payment, no ledger entry. §9.4.
      expect(tx.reservation.update).toHaveBeenCalledTimes(1);
      expect(tx.financialAuditLog.create).toHaveBeenCalledTimes(1);
    });

    it.each(['COMPLETED', 'CANCELLED', 'NO_SHOW'] as const)(
      '409s on a %s booking, which is terminal',
      async (status) => {
        const { service } = setup({ reservation: reservationFixture({ status }) });

        const result = await caught(() =>
          service.cancel(
            RESERVATION_ID,
            { reason: 'too late' },
            actorFixture(UserRole.OWNER),
            CTX,
          ),
        );

        expect(result.status).toBe(409);
        expect(result.body.error.code).toBe(ErrorCode.ILLEGAL_STATUS_TRANSITION);
        expect(result.body.error.details).toEqual({ from: status, to: 'CANCELLED' });
      },
    );

    it('404s when the booking is not in this branch', async () => {
      const { service } = setup({ found: false });

      const { status, body } = await caught(() =>
        service.cancel(RESERVATION_ID, { reason: 'guest called' }, actorFixture(), CTX),
      );

      expect(status).toBe(404);
      expect(body.error.code).toBe(ErrorCode.RESERVATION_NOT_FOUND);
    });

    it('audits the cancellation', async () => {
      const { service, tx } = setup();

      await service.cancel(RESERVATION_ID, { reason: 'guest called' }, actorFixture(), CTX);

      const { data } = tx.financialAuditLog.create.mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(data).toMatchObject({ action: 'RESERVATION_CANCELLED', entityId: RESERVATION_ID });
      expect((data.afterState as Record<string, unknown>).status).toBe('CANCELLED');
    });
  });

  describe('markNoShow', () => {
    it('moves a scheduled booking to NO_SHOW and audits it', async () => {
      const { service, tx } = setup();

      const view = await service.markNoShow(RESERVATION_ID, actorFixture(), CTX);

      expect(tx.reservation.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'NO_SHOW' } }),
      );
      expect(view.status).toBe('NO_SHOW');
      const { data } = tx.financialAuditLog.create.mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(data).toMatchObject({ action: 'RESERVATION_NO_SHOW' });
    });

    it.each(['IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW'] as const)(
      '409s on a %s booking: the guest plainly did show',
      async (status) => {
        const { service, tx } = setup({ reservation: reservationFixture({ status }) });

        const result = await caught(() =>
          service.markNoShow(RESERVATION_ID, actorFixture(), CTX),
        );

        expect(result.status).toBe(409);
        expect(result.body.error.code).toBe(ErrorCode.ILLEGAL_STATUS_TRANSITION);
        expect(tx.reservation.update).not.toHaveBeenCalled();
      },
    );

    it('404s when the booking is not in this branch', async () => {
      const { service } = setup({ found: false });

      const { status } = await caught(() =>
        service.markNoShow(RESERVATION_ID, actorFixture(), CTX),
      );

      expect(status).toBe(404);
    });
  });
});

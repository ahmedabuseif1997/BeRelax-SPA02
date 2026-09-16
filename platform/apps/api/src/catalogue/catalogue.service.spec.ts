import { HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Reservation, Room, Service, ServiceCategory } from '@prisma/client';
import type { ApiErrorBody } from '@berelax/contracts';
import { ErrorCode, UserRole } from '@berelax/contracts';
import { AuditService } from '../common/audit.service';
import type { AuthUser, RequestContext } from '../common/request-context';
import type { PrismaService } from '../prisma/prisma.service';
import { CatalogueService } from './catalogue.service';

const SERVICE_ID = '0192eeee-0000-7000-8000-00000000000e';
const CATEGORY_ID = '0192eeee-0000-7000-8000-000000000021';
const ROOM_ID = '0192eeee-0000-7000-8000-000000000031';
const RESERVATION_ID = '0192f8a1-0000-7000-8000-000000000001';
const BRANCH_ID = '0192bbbb-0000-7000-8000-00000000000b';
const USER_ID = '0192dddd-0000-7000-8000-00000000000d';

function categoryFixture(overrides: Partial<ServiceCategory> = {}): ServiceCategory {
  return { id: CATEGORY_ID, name: 'Massage', sortOrder: 0, isActive: true, ...overrides };
}

function serviceFixture(overrides: Partial<Service> = {}): Service {
  return {
    id: SERVICE_ID,
    branchId: BRANCH_ID,
    categoryId: CATEGORY_ID,
    name: 'Balinese Massage',
    durationMinutes: 60,
    priceFils: 25_000,
    description: null,
    requiresRoom: true,
    isActive: true,
    sortOrder: 0,
    ...overrides,
  };
}

function roomFixture(overrides: Partial<Room> = {}): Room {
  return { id: ROOM_ID, branchId: BRANCH_ID, name: 'Room 1', capacity: 1, isActive: true, ...overrides };
}

/** A booking taken at the OLD price. Its `baseCostFils` is a snapshot, not a lookup. */
function reservationFixture(overrides: Partial<Reservation> = {}): Reservation {
  return {
    id: RESERVATION_ID,
    ref: 'BR-2026-0417',
    branchId: BRANCH_ID,
    guestId: null,
    employeeId: '0192cccc-0000-7000-8000-00000000000c',
    roomId: ROOM_ID,
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

function actorFixture(role: UserRole = UserRole.MANAGER): AuthUser {
  return {
    id: USER_ID,
    role,
    branchId: BRANCH_ID,
    employeeId: null,
    email: 'manager@berelax.ae',
    fullName: 'Manager',
  };
}

const CTX: RequestContext = {
  requestId: 'req_01JBQ7X8',
  branchId: BRANCH_ID,
  actorUserId: USER_ID,
  actorRole: UserRole.MANAGER,
};

type Tx = {
  service: { findMany: jest.Mock; findFirst: jest.Mock; create: jest.Mock; update: jest.Mock };
  serviceCategory: {
    findMany: jest.Mock;
    findUnique: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  room: { findMany: jest.Mock; findFirst: jest.Mock; create: jest.Mock; update: jest.Mock };
  reservation: { findMany: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
  financialAuditLog: { create: jest.Mock };
};

function setup(
  options: {
    service?: Service | null;
    category?: ServiceCategory | null;
    room?: Room | null;
    bookings?: Reservation[];
  } = {},
) {
  const service = options.service === undefined ? serviceFixture() : options.service;
  const category = options.category === undefined ? categoryFixture() : options.category;
  const room = options.room === undefined ? roomFixture() : options.room;
  const bookings = options.bookings ?? [reservationFixture()];

  const tx: Tx = {
    service: {
      findMany: jest.fn().mockResolvedValue([{ ...serviceFixture(), category: categoryFixture() }]),
      findFirst: jest.fn().mockResolvedValue(service),
      create: jest.fn(async ({ data }: { data: Service }) => serviceFixture(data)),
      update: jest.fn(async ({ data }: { data: Partial<Service> }) =>
        serviceFixture({ ...(service ?? {}), ...data }),
      ),
    },
    serviceCategory: {
      findMany: jest.fn().mockResolvedValue([categoryFixture()]),
      findUnique: jest.fn().mockResolvedValue(category),
      create: jest.fn(async ({ data }: { data: ServiceCategory }) => categoryFixture(data)),
      update: jest.fn(async ({ data }: { data: Partial<ServiceCategory> }) =>
        categoryFixture({ ...(category ?? {}), ...data }),
      ),
    },
    room: {
      findMany: jest.fn().mockResolvedValue([roomFixture()]),
      findFirst: jest.fn().mockResolvedValue(room),
      create: jest.fn(async ({ data }: { data: Room }) => roomFixture(data)),
      update: jest.fn(async ({ data }: { data: Partial<Room> }) =>
        roomFixture({ ...(room ?? {}), ...data }),
      ),
    },
    // Stands in for the bookings already on the grid. Nothing in this module may
    // write to them.
    reservation: {
      findMany: jest.fn().mockResolvedValue(bookings),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    financialAuditLog: { create: jest.fn().mockResolvedValue({}) },
  };

  const prisma = {
    $transaction: jest.fn(async (cb: (client: Tx) => Promise<unknown>) => cb(tx)),
    service: tx.service,
    serviceCategory: tx.serviceCategory,
    room: tx.room,
    reservation: tx.reservation,
  } as unknown as PrismaService;

  return { tx, service: new CatalogueService(prisma, new AuditService()) };
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

describe('CatalogueService', () => {
  describe('a price change is a price change, and nothing else', () => {
    it('leaves every existing booking at the price it was taken at', async () => {
      // The real guarantee is the column: `Reservation.baseCostFils` is copied
      // from the menu when the booking is made and never read back off it. A
      // price rise tonight must not rewrite what a guest was quoted last week.
      const { service, tx } = setup();
      const before = (await tx.reservation.findMany()) as Reservation[];
      expect(before[0]!.baseCostFils).toBe(25_000);

      await service.updateService(SERVICE_ID, { priceFils: 31_500 }, actorFixture(), CTX);

      expect(tx.reservation.update).not.toHaveBeenCalled();
      expect(tx.reservation.updateMany).not.toHaveBeenCalled();
      const after = (await tx.reservation.findMany()) as Reservation[];
      expect(after[0]!.baseCostFils).toBe(25_000);
    });

    it('audits SERVICE_PRICE_CHANGED with the old price and the new one', async () => {
      const { service, tx } = setup();

      await service.updateService(SERVICE_ID, { priceFils: 31_500 }, actorFixture(), CTX);

      const { data } = tx.financialAuditLog.create.mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(data).toMatchObject({
        action: 'SERVICE_PRICE_CHANGED',
        entityType: 'Service',
        entityId: SERVICE_ID,
        amountFils: 31_500,
        requestId: 'req_01JBQ7X8',
      });
      expect((data.beforeState as Record<string, unknown>).priceFils).toBe(25_000);
      expect((data.afterState as Record<string, unknown>).priceFils).toBe(31_500);
    });

    it('audits in the same transaction as the write', async () => {
      const { service, tx } = setup();

      await service.updateService(SERVICE_ID, { priceFils: 31_500 }, actorFixture(), CTX);

      expect(tx.service.update).toHaveBeenCalledTimes(1);
      expect(tx.financialAuditLog.create).toHaveBeenCalledTimes(1);
    });

    it('writes no audit row when the price is sent unchanged', async () => {
      const { service, tx } = setup();

      await service.updateService(
        SERVICE_ID,
        { priceFils: 25_000, name: 'Balinese Massage (60)' },
        actorFixture(),
        CTX,
      );

      expect(tx.service.update).toHaveBeenCalledTimes(1);
      expect(tx.financialAuditLog.create).not.toHaveBeenCalled();
    });

    it('writes no audit row for a rename that leaves the price alone', async () => {
      const { service, tx } = setup();

      await service.updateService(SERVICE_ID, { name: 'Balinese 60' }, actorFixture(), CTX);

      expect(tx.financialAuditLog.create).not.toHaveBeenCalled();
    });

    it('404s on a service from another branch, writing nothing', async () => {
      const { service, tx } = setup({ service: null });

      const { status, body } = await caught(() =>
        service.updateService(SERVICE_ID, { priceFils: 31_500 }, actorFixture(), CTX),
      );

      expect(status).toBe(404);
      expect(body.error.code).toBe(ErrorCode.NOT_FOUND);
      expect(tx.service.update).not.toHaveBeenCalled();
    });
  });

  describe('services', () => {
    it('lists the live menu and scopes it to the branch', async () => {
      const { service, tx } = setup();

      await service.findServices({ includeInactive: false }, actorFixture());

      const { where } = tx.service.findMany.mock.calls[0]![0] as {
        where: Record<string, unknown>;
      };
      expect(where).toEqual({ branchId: BRANCH_ID, isActive: true });
    });

    it('includes retired lines only when asked', async () => {
      const { service, tx } = setup();

      await service.findServices({ includeInactive: true }, actorFixture());

      const { where } = tx.service.findMany.mock.calls[0]![0] as {
        where: Record<string, unknown>;
      };
      expect(where).toEqual({ branchId: BRANCH_ID });
    });

    it('takes branchId from the token, never from the body', async () => {
      const { service, tx } = setup();

      await service.createService(
        {
          categoryId: CATEGORY_ID,
          name: 'Hot Stone',
          durationMinutes: 90,
          priceFils: 40_000,
          branchId: 'not-this-one',
        } as never,
        actorFixture(),
      );

      const { data } = tx.service.create.mock.calls[0]![0] as { data: Service };
      expect(data.branchId).toBe(BRANCH_ID);
      expect(data.requiresRoom).toBe(true);
    });

    it('422s on a category that does not exist, before creating anything', async () => {
      const { service, tx } = setup({ category: null });

      const { status, body } = await caught(() =>
        service.createService(
          { categoryId: CATEGORY_ID, name: 'Hot Stone', durationMinutes: 90, priceFils: 40_000 },
          actorFixture(),
        ),
      );

      expect(status).toBe(422);
      expect(body.error.code).toBe(ErrorCode.VALIDATION_FAILED);
      expect(tx.service.create).not.toHaveBeenCalled();
    });

    it('carries the category alongside the service for the booking screen', async () => {
      const { service } = setup();

      const [row] = await service.findServices({ includeInactive: false }, actorFixture());

      expect(row!.category).toEqual({
        id: CATEGORY_ID,
        name: 'Massage',
        sortOrder: 0,
        isActive: true,
      });
      expect(row!.priceFils).toBe(25_000);
    });
  });

  describe('categories', () => {
    it('turns the unique name violation into a readable 409', async () => {
      const { service, tx } = setup();
      tx.serviceCategory.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '5.22.0',
        }),
      );

      const { status, body } = await caught(() => service.createCategory({ name: 'Massage' }));

      expect(status).toBe(409);
      expect(body.error.code).toBe(ErrorCode.CATEGORY_NAME_TAKEN);
    });

    it('404s on a category that does not exist', async () => {
      const { service } = setup({ category: null });

      const { status } = await caught(() => service.updateCategory(CATEGORY_ID, { name: 'Scrubs' }));

      expect(status).toBe(404);
    });

    it('lists only active headings by default', async () => {
      const { service, tx } = setup();

      await service.findCategories({ includeInactive: false });

      const { where } = tx.serviceCategory.findMany.mock.calls[0]![0] as {
        where: Record<string, unknown>;
      };
      expect(where).toEqual({ isActive: true });
    });
  });

  describe('rooms', () => {
    it('takes branchId from the token and defaults capacity to one', async () => {
      const { service, tx } = setup();

      await service.createRoom({ name: 'Room 4' }, actorFixture());

      const { data } = tx.room.create.mock.calls[0]![0] as { data: Room };
      expect(data.branchId).toBe(BRANCH_ID);
      expect(data.capacity).toBe(1);
    });

    it('turns the (branch, name) unique violation into a readable 409', async () => {
      const { service, tx } = setup();
      tx.room.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '5.22.0',
        }),
      );

      const { status, body } = await caught(() =>
        service.createRoom({ name: 'Room 1' }, actorFixture()),
      );

      expect(status).toBe(409);
      expect(body.error.code).toBe(ErrorCode.ROOM_NAME_TAKEN);
    });

    it('deactivates a room without touching the bookings that hold it', async () => {
      const { service, tx } = setup();

      const view = await service.updateRoom(ROOM_ID, { isActive: false }, actorFixture());

      expect(view.isActive).toBe(false);
      expect(tx.reservation.update).not.toHaveBeenCalled();
      expect(tx.reservation.updateMany).not.toHaveBeenCalled();
    });

    it('404s on a room from another branch', async () => {
      const { service } = setup({ room: null });

      const { status } = await caught(() =>
        service.updateRoom(ROOM_ID, { name: 'Room 9' }, actorFixture()),
      );

      expect(status).toBe(404);
    });
  });
});

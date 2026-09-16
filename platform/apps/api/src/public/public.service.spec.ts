import { HttpException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { ApiErrorBody, AttributionPayload, PublicBookingRequestDto } from '@berelax/contracts';
import { ErrorCode, formatAed } from '@berelax/contracts';
import { publicReference } from '../booking-requests/booking-requests.service';
import type { Env } from '../config/env';
import type { PrismaService } from '../prisma/prisma.service';
import { PublicService } from './public.service';

const BRANCH_ID = '0192bbbb-0000-7000-8000-00000000000b';
const OTHER_BRANCH_ID = '0192bbbb-0000-7000-8000-00000000000f';
const REQUEST_ID = '0192aaaa-0000-7000-8000-000000000001';
const SERVICE_ID = '0192eeee-0000-7000-8000-00000000000e';
const CATEGORY_ID = '0192cafe-0000-7000-8000-00000000000a';
const SNAPSHOT_ID = '0192e7e7-0000-7000-8000-000000000007';
const VISITOR_ID = '0192d0d0-0000-7000-8000-000000000001';

const SALT = 'test-erasure-salt-0123456789';

function attributionFixture(overrides: Partial<AttributionPayload> = {}): AttributionPayload {
  const touch = {
    ts: '2026-09-10T09:00:00+04:00',
    source: 'google',
    medium: 'cpc',
    campaign: 'ramadan-offers',
    gclid: 'Cj0KCQ',
    landing: '/massage/balinese',
  };
  return {
    v: 1,
    visitorId: VISITOR_ID,
    first: touch,
    last: { ...touch, ts: '2026-09-15T21:00:00+04:00', medium: 'organic', landing: '/pricing' },
    touches: [touch, { ...touch, ts: '2026-09-15T21:00:00+04:00' }],
    createdAt: '2026-09-10T09:00:00+04:00',
    updatedAt: '2026-09-15T21:00:00+04:00',
    ...overrides,
  };
}

function formFixture(overrides: Partial<PublicBookingRequestDto> = {}): PublicBookingRequestDto {
  return {
    guestName: 'Amira Khan',
    guestPhone: '+971501234567',
    guestEmail: 'amira@example.com',
    requestedServiceId: SERVICE_ID,
    requestedAt: '2026-09-16T19:00:00+04:00',
    message: 'Prefers a female therapist.',
    attribution: attributionFixture(),
    ...overrides,
  };
}

type Tx = {
  attributionSnapshot: { create: jest.Mock };
  service: { findFirst: jest.Mock };
  bookingRequest: { create: jest.Mock };
};

function setup(
  options: {
    defaultBranchId?: string;
    branches?: { id: string }[];
    categories?: unknown[];
    serviceMissing?: boolean;
    openSnapshot?: { id: string } | null;
  } = {},
) {
  const tx: Tx = {
    attributionSnapshot: { create: jest.fn().mockResolvedValue({ id: SNAPSHOT_ID }) },
    service: {
      findFirst: jest.fn().mockResolvedValue(options.serviceMissing ? null : { id: SERVICE_ID }),
    },
    bookingRequest: { create: jest.fn().mockResolvedValue({ id: REQUEST_ID }) },
  };

  const prisma = {
    $transaction: jest.fn(async (cb: (client: Tx) => Promise<unknown>) => cb(tx)),
    branch: {
      findMany: jest.fn().mockResolvedValue(options.branches ?? [{ id: BRANCH_ID }]),
    },
    serviceCategory: { findMany: jest.fn().mockResolvedValue(options.categories ?? []) },
    attributionSnapshot: {
      findFirst: jest.fn().mockResolvedValue(options.openSnapshot ?? null),
      update: jest.fn().mockResolvedValue({ id: SNAPSHOT_ID }),
      create: jest.fn().mockResolvedValue({ id: SNAPSHOT_ID }),
    },
  } as unknown as PrismaService;

  const config = {
    get: (key: string) => (key === 'ERASURE_SALT' ? SALT : options.defaultBranchId),
  } as unknown as ConfigService<Env, true>;

  return { tx, prisma, service: new PublicService(prisma, config) };
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

describe('PublicService', () => {
  describe('which branch an anonymous caller is talking to', () => {
    it('uses DEFAULT_BRANCH_ID when it is set, without asking the database', async () => {
      const { service, prisma } = setup({ defaultBranchId: OTHER_BRANCH_ID });

      await service.menu();

      expect(prisma.branch.findMany).not.toHaveBeenCalled();
      const { where } = (prisma.serviceCategory.findMany as jest.Mock).mock.calls[0]![0] as {
        where: { services: { some: { branchId: string } } };
      };
      expect(where.services.some.branchId).toBe(OTHER_BRANCH_ID);
    });

    it('falls back to the only branch there is, because v1 has exactly one', async () => {
      const { service, prisma } = setup();

      await service.menu();

      const { where } = (prisma.serviceCategory.findMany as jest.Mock).mock.calls[0]![0] as {
        where: { services: { some: { branchId: string } } };
      };
      expect(where.services.some.branchId).toBe(BRANCH_ID);
    });

    it('resolves the fallback once and caches it: it is configuration, not data', async () => {
      const { service, prisma } = setup();

      await service.menu();
      await service.menu();

      expect(prisma.branch.findMany).toHaveBeenCalledTimes(1);
    });

    it('refuses to guess once a second branch exists', async () => {
      // Guessing would file an Abu Dhabi enquiry against a Dubai inbox.
      const { service } = setup({ branches: [{ id: BRANCH_ID }, { id: OTHER_BRANCH_ID }] });

      const { status, body } = await caught(() => service.menu());

      expect(status).toBe(500);
      expect(body.error.code).toBe(ErrorCode.BRANCH_NOT_CONFIGURED);
    });

    it('refuses on an empty database rather than inventing a branch', async () => {
      const { service } = setup({ branches: [] });

      const { status } = await caught(() => service.menu());

      expect(status).toBe(500);
    });
  });

  describe('the live menu', () => {
    const categories = [
      {
        id: CATEGORY_ID,
        name: 'Asian',
        services: [
          {
            id: SERVICE_ID,
            name: 'Balinese Massage — 60 min',
            description: 'Firm, rhythmic pressure.',
            durationMinutes: 60,
            priceFils: 25_000,
          },
        ],
      },
    ];

    it('groups services under their category and formats the price once', async () => {
      const { service } = setup({ categories });

      const menu = await service.menu();

      expect(menu.categories).toHaveLength(1);
      expect(menu.categories[0]!.name).toBe('Asian');
      expect(menu.categories[0]!.services[0]).toEqual({
        id: SERVICE_ID,
        name: 'Balinese Massage — 60 min',
        description: 'Firm, rhythmic pressure.',
        durationMinutes: 60,
        // Integer fils on the wire, the string beside it for the pricing table. §3.1.
        priceFils: 25_000,
        // Not a literal: Intl puts a non-breaking space after the currency, and
        // a test that hard-codes the separator asserts the wrong thing.
        priceFormatted: formatAed(25_000),
      });
      expect(menu.categories[0]!.services[0]!.priceFormatted).toMatch(/AED\s250\.00/);
    });

    it('asks for active services only, and drops categories left with none', async () => {
      const { service, prisma } = setup({ categories });

      await service.menu();

      const args = (prisma.serviceCategory.findMany as jest.Mock).mock.calls[0]![0] as {
        where: Record<string, unknown>;
        select: { services: { where: Record<string, unknown> } };
      };
      expect(args.where).toMatchObject({
        isActive: true,
        services: { some: { isActive: true } },
      });
      expect(args.select.services.where).toMatchObject({ isActive: true });
    });

    it('builds the whole menu from one query', async () => {
      const { service, prisma } = setup({ categories, defaultBranchId: BRANCH_ID });

      await service.menu();

      expect(prisma.serviceCategory.findMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('the website booking form', () => {
    it('tells the caller nothing but ok and a reference', async () => {
      const { service } = setup();

      const receipt = await service.createBookingRequest(formFixture());

      expect(receipt).toEqual({ ok: true, reference: publicReference(REQUEST_ID, SALT) });
      // No id, no guest id, no snapshot id, nothing to enumerate.
      expect(JSON.stringify(receipt)).not.toContain(REQUEST_ID);
      expect(JSON.stringify(receipt)).not.toContain(SNAPSHOT_ID);
    });

    it('answers identically whether or not the phone is already a guest', async () => {
      // A form that says "welcome back" is a phone-number oracle.
      const { service, tx } = setup();

      const first = await service.createBookingRequest(formFixture());
      const second = await service.createBookingRequest(formFixture());

      expect(first).toEqual(second);
      // ...and it never looked the guest up in the first place.
      expect(tx.bookingRequest.create.mock.calls[0]![0]).toMatchObject({
        data: { guestId: null },
      });
    });

    it('writes the attribution snapshot and links it, in one transaction', async () => {
      const { service, tx, prisma } = setup();

      await service.createBookingRequest(formFixture());

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const snapshot = tx.attributionSnapshot.create.mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(snapshot.data).toMatchObject({
        visitorId: VISITOR_ID,
        touchCount: 2,
        firstSeenAt: new Date('2026-09-10T09:00:00+04:00'),
        lastSeenAt: new Date('2026-09-15T21:00:00+04:00'),
        landingPath: '/pricing',
      });
      const { data } = tx.bookingRequest.create.mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(data.attributionId).toBe(SNAPSHOT_ID);
    });

    it('still takes the enquiry from a visitor who declined the consent gate', async () => {
      const { service, tx } = setup();

      await service.createBookingRequest(formFixture({ attribution: null }));

      expect(tx.attributionSnapshot.create).not.toHaveBeenCalled();
      const { data } = tx.bookingRequest.create.mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(data.attributionId).toBeNull();
    });

    it('files the enquiry as WEBSITE_FORM', async () => {
      const { service, tx } = setup();

      await service.createBookingRequest(formFixture());

      const { data } = tx.bookingRequest.create.mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(data.sourceChannel).toBe('WEBSITE_FORM');
      expect(data.branchId).toBe(BRANCH_ID);
      expect(data.guestPhone).toBe('+971501234567');
    });

    it('drops an unknown service id rather than confirming which ids exist', async () => {
      const { service, tx } = setup({ serviceMissing: true });

      const receipt = await service.createBookingRequest(formFixture());

      expect(receipt.ok).toBe(true);
      const { data } = tx.bookingRequest.create.mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(data.requestedServiceId).toBeNull();
    });

    it('scopes the service lookup to this branch', async () => {
      const { service, tx } = setup();

      await service.createBookingRequest(formFixture());

      expect(tx.service.findFirst).toHaveBeenCalledWith({
        where: { id: SERVICE_ID, branchId: BRANCH_ID, isActive: true },
        select: { id: true },
      });
    });

    it('holds no resource: it never touches reservations', async () => {
      // A form submission cannot conflict with anything, because it commits
      // nobody's evening. §1.1.
      const { service, tx } = setup();

      await service.createBookingRequest(formFixture());

      expect(tx).not.toHaveProperty('reservation');
    });
  });

  describe('the attribution beacon', () => {
    it('updates the visitor’s open snapshot rather than piling up rows', async () => {
      const { service, prisma } = setup({ openSnapshot: { id: SNAPSHOT_ID } });

      await service.recordTouch(attributionFixture());

      expect(prisma.attributionSnapshot.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: SNAPSHOT_ID } }),
      );
      expect(prisma.attributionSnapshot.create).not.toHaveBeenCalled();
    });

    it('creates the first snapshot for a visitor nobody has seen', async () => {
      const { service, prisma } = setup({ openSnapshot: null });

      await service.recordTouch(attributionFixture());

      expect(prisma.attributionSnapshot.create).toHaveBeenCalledTimes(1);
      expect(prisma.attributionSnapshot.update).not.toHaveBeenCalled();
    });

    it('never rewrites a snapshot that is already evidence behind a conversion', async () => {
      const { service, prisma } = setup();

      await service.recordTouch(attributionFixture());

      const { where } = (prisma.attributionSnapshot.findFirst as jest.Mock).mock
        .calls[0]![0] as { where: Record<string, unknown> };
      expect(where).toEqual({
        visitorId: VISITOR_ID,
        bookingRequest: { is: null },
        reservations: { none: {} },
        // A pruned row has had its identifiers stripped at 90 days. §11.6.
        prunedAt: null,
      });
    });

    it('keeps only the path of the landing page, never the query string', async () => {
      const { service, prisma } = setup();

      await service.recordTouch(attributionFixture());

      const { data } = (prisma.attributionSnapshot.create as jest.Mock).mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(data.landingPath).toBe('/pricing');
    });

    it('falls back to the first touch’s landing page when the last has none', async () => {
      const base = attributionFixture();
      const { service, prisma } = setup();

      await service.recordTouch({ ...base, last: { ...base.last, landing: undefined } });

      const { data } = (prisma.attributionSnapshot.create as jest.Mock).mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(data.landingPath).toBe('/massage/balinese');
    });
  });
});

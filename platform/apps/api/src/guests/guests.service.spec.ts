import { HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Guest, GuestConsent } from '@prisma/client';
import type { ApiErrorBody } from '@berelax/contracts';
import { ConsentType, ErrorCode, UserRole, createGuestSchema } from '@berelax/contracts';
import type { AuthUser, RequestContext } from '../common/request-context';
import type { PrismaService } from '../prisma/prisma.service';
import { GuestsService, assertNotMedical } from './guests.service';

const GUEST_ID = '0192aaaa-0000-7000-8000-00000000000a';
const BRANCH_ID = '0192bbbb-0000-7000-8000-00000000000b';
const USER_ID = '0192dddd-0000-7000-8000-00000000000d';

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

function consentFixture(overrides: Partial<GuestConsent> = {}): GuestConsent {
  return {
    id: '0192cccc-0000-7000-8000-000000000011',
    guestId: GUEST_ID,
    type: ConsentType.MARKETING,
    granted: true,
    grantedAt: new Date('2026-09-16T18:00:00.000Z'),
    withdrawnAt: null,
    source: 'reception-ipad',
    policyVersion: '2026-01',
    ipAddress: '10.0.0.8',
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
  ipAddress: '10.0.0.8',
};

type Db = {
  guest: { findMany: jest.Mock; findFirst: jest.Mock; create: jest.Mock; update: jest.Mock };
  guestConsent: {
    create: jest.Mock;
    findMany: jest.Mock;
    updateMany: jest.Mock;
    deleteMany: jest.Mock;
  };
  reservation: { findMany: jest.Mock };
  $transaction: jest.Mock;
};

function setup(
  options: {
    guest?: Guest | null;
    visits?: Array<{ status: string; startsAt: Date }>;
    /** The consent rows on file, newest first — as the service reads them. */
    consents?: GuestConsent[];
  } = {},
) {
  const guest = options.guest === undefined ? guestFixture() : options.guest;
  const consents = options.consents ?? [];

  const db: Db = {
    guest: {
      findMany: jest.fn().mockResolvedValue([guestFixture()]),
      findFirst: jest.fn().mockResolvedValue(guest),
      create: jest.fn(async ({ data }: { data: Guest }) => guestFixture(data)),
      update: jest.fn(async ({ data }: { data: Partial<Guest> }) =>
        guestFixture({ ...(guest ?? {}), ...data }),
      ),
    },
    guestConsent: {
      create: jest.fn(async ({ data }: { data: GuestConsent }) => consentFixture(data)),
      findMany: jest.fn(async ({ where }: { where: { type?: string } }) =>
        where.type ? consents.filter((c) => c.type === where.type) : consents,
      ),
      updateMany: jest.fn(async () => ({ count: 1 })),
      deleteMany: jest.fn(async () => ({ count: consents.length })),
    },
    reservation: { findMany: jest.fn().mockResolvedValue(options.visits ?? []) },
    $transaction: jest.fn(async (cb: (client: Db) => Promise<unknown>) => cb(db)),
  };

  return { db, service: new GuestsService(db as unknown as PrismaService) };
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

describe('GuestsService', () => {
  describe('the health-data screen — §11.5', () => {
    it.each([
      ['pregnancy', 'Guest is pregnant, avoid deep pressure'],
      ['diabetes', 'diabetic — careful with foot work'],
      ['hypertension', 'has hypertension'],
      ['blood pressure', 'watch her blood pressure'],
      ['medication', 'on medication for her back'],
      ['surgery', 'shoulder surgery in March'],
      ['epilepsy', 'epileptic, keep lights low'],
      ['asthma', 'asthma — no strong scents'],
      ['heart condition', 'heart condition, gentle only'],
    ])('refuses %s and tells reception to keep it on paper', async (term, notes) => {
      const { service, db } = setup();

      const { status, body } = await caught(() =>
        service.create(
          { fullName: 'Amira Khan', phone: '+971501234567', notes },
          actorFixture(),
        ),
      );

      expect(status).toBe(422);
      expect(body.error.code).toBe(ErrorCode.GUEST_NOTES_MEDICAL_CONTENT);
      expect(body.error.message).toMatch(/on paper/i);
      expect(body.error.details).toEqual({ term });
      // Refused before it reaches the database, so the term is never stored.
      expect(db.guest.create).not.toHaveBeenCalled();
    });

    it.each([
      'no jasmine oil',
      'Prefers firm pressure',
      'requests Maya, female therapist only',
      'allergic to nothing — likes the warm room',
      'heartfelt thank-you note left last visit',
    ])('lets a genuine preference through: %s', (notes) => {
      expect(() => assertNotMedical(notes)).not.toThrow();
    });

    it('passes over an empty or absent note without inventing a match', () => {
      expect(() => assertNotMedical(null)).not.toThrow();
      expect(() => assertNotMedical(undefined)).not.toThrow();
      expect(() => assertNotMedical('')).not.toThrow();
    });

    it('screens a patch as well as a create, before the row is read', async () => {
      const { service, db } = setup();

      const { status, body } = await caught(() =>
        service.update(GUEST_ID, { notes: 'takes medication daily' }, actorFixture()),
      );

      expect(status).toBe(422);
      expect(body.error.code).toBe(ErrorCode.GUEST_NOTES_MEDICAL_CONTENT);
      expect(db.guest.update).not.toHaveBeenCalled();
      expect(db.guest.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('phone normalisation — one guest, however it is typed', () => {
    it.each([
      '+971 50 123 4567',
      '+971501234567',
      '+971-50-123-4567',
      '0501234567',
      '050 123 4567',
      '00971501234567',
      '971501234567',
    ])('stores %s as +971501234567', (typed) => {
      const parsed = createGuestSchema.parse({ fullName: 'Amira Khan', phone: typed });

      expect(parsed.phone).toBe('+971501234567');
    });

    it('still rejects a number that is not a UAE mobile', () => {
      const result = createGuestSchema.safeParse({ fullName: 'Amira Khan', phone: '+4477009000' });

      expect(result.success).toBe(false);
    });

    it('writes the number through untouched, because the schema already normalised it', async () => {
      const { service, db } = setup();

      await service.create(
        { fullName: 'Amira Khan', phone: '+971501234567' },
        actorFixture(),
      );

      const { data } = db.guest.create.mock.calls[0]![0] as { data: Guest };
      expect(data.phone).toBe('+971501234567');
    });

    it('normalises the search box the same way, so "050 123" finds the guest', async () => {
      const { service, db } = setup();

      await service.findMany({ search: '050 123' }, actorFixture());

      const { where } = db.guest.findMany.mock.calls[0]![0] as {
        where: { OR: Array<Record<string, unknown>> };
      };
      expect(where.OR).toEqual([
        { fullName: { contains: '050 123', mode: 'insensitive' } },
        { phone: { contains: '+97150123' } },
      ]);
    });
  });

  describe('create', () => {
    it('takes branchId from the token, never from the body', async () => {
      const { service, db } = setup();

      await service.create(
        { fullName: 'Amira Khan', phone: '+971501234567', branchId: 'not-this-one' } as never,
        actorFixture(),
      );

      const { data } = db.guest.create.mock.calls[0]![0] as { data: Guest };
      expect(data.branchId).toBe(BRANCH_ID);
    });

    it('turns the (branch, phone) unique violation into a readable 409', async () => {
      const { service, db } = setup();
      db.guest.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '5.22.0',
        }),
      );

      const { status, body } = await caught(() =>
        service.create({ fullName: 'Amira Khan', phone: '+971501234567' }, actorFixture()),
      );

      expect(status).toBe(409);
      expect(body.error.code).toBe(ErrorCode.GUEST_PHONE_TAKEN);
      expect(body.error.details).toEqual({ phone: '+971501234567' });
    });
  });

  describe('findMany', () => {
    it('leaves soft-deleted guests out and scopes to the branch', async () => {
      const { service, db } = setup();

      await service.findMany({}, actorFixture());

      const { where, take } = db.guest.findMany.mock.calls[0]![0] as {
        where: Record<string, unknown>;
        take: number;
      };
      expect(where).toEqual({ branchId: BRANCH_ID, deletedAt: null });
      expect(take).toBe(50);
    });

    it('honours an explicit limit', async () => {
      const { service, db } = setup();

      await service.findMany({ limit: 5 }, actorFixture());

      const { take } = db.guest.findMany.mock.calls[0]![0] as { take: number };
      expect(take).toBe(5);
    });

    it('returns a blocked guest rather than hiding them — reception needs to know', async () => {
      const { service, db } = setup();
      db.guest.findMany.mockResolvedValue([guestFixture({ isBlocked: true })]);

      const [row] = await service.findMany({}, actorFixture());

      expect(row!.isBlocked).toBe(true);
    });
  });

  describe('findOne — the visit history summary', () => {
    it('counts the visits and finds the last one and the next', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-09-16T12:00:00.000Z'));
      try {
        const { service } = setup({
          visits: [
            { status: 'COMPLETED', startsAt: new Date('2026-02-01T15:00:00.000Z') },
            { status: 'NO_SHOW', startsAt: new Date('2026-03-01T15:00:00.000Z') },
            { status: 'COMPLETED', startsAt: new Date('2026-08-01T15:00:00.000Z') },
            { status: 'CANCELLED', startsAt: new Date('2026-09-01T15:00:00.000Z') },
            { status: 'SCHEDULED', startsAt: new Date('2026-09-20T15:00:00.000Z') },
          ],
        });

        const view = await service.findOne(GUEST_ID, actorFixture());

        expect(view.visits).toEqual({
          total: 5,
          completed: 2,
          cancelled: 1,
          noShow: 1,
          firstVisitAt: '2026-02-01T15:00:00.000Z',
          lastVisitAt: '2026-08-01T15:00:00.000Z',
          nextVisitAt: '2026-09-20T15:00:00.000Z',
        });
      } finally {
        jest.useRealTimers();
      }
    });

    it('carries no money: a lifetime total is a total, and §6.4 keeps those off the desk', async () => {
      const { service } = setup({
        visits: [{ status: 'COMPLETED', startsAt: new Date('2026-08-01T15:00:00.000Z') }],
      });

      const view = await service.findOne(GUEST_ID, actorFixture());

      expect(JSON.stringify(view)).not.toMatch(/fils/i);
    });

    it('summarises a guest who has never been in without inventing dates', async () => {
      const { service } = setup({ visits: [] });

      const view = await service.findOne(GUEST_ID, actorFixture());

      expect(view.visits).toMatchObject({ total: 0, firstVisitAt: null, nextVisitAt: null });
    });

    it('404s on a guest from another branch', async () => {
      const { service } = setup({ guest: null });

      const { status, body } = await caught(() => service.findOne(GUEST_ID, actorFixture()));

      expect(status).toBe(404);
      expect(body.error.code).toBe(ErrorCode.NOT_FOUND);
    });
  });

  describe('block and unblock', () => {
    it('sets the flag without deleting anything', async () => {
      const { service, db } = setup();

      const view = await service.setBlocked(GUEST_ID, true, actorFixture());

      expect(db.guest.update).toHaveBeenCalledWith({
        where: { id: GUEST_ID },
        data: { isBlocked: true },
      });
      expect(view.isBlocked).toBe(true);
    });

    it('unblocks again', async () => {
      const { service } = setup({ guest: guestFixture({ isBlocked: true }) });

      const view = await service.setBlocked(GUEST_ID, false, actorFixture());

      expect(view.isBlocked).toBe(false);
    });

    it('404s on a guest from another branch', async () => {
      const { service } = setup({ guest: null });

      const { status } = await caught(() => service.setBlocked(GUEST_ID, true, actorFixture()));

      expect(status).toBe(404);
    });
  });

  describe('recordConsent — §11.3', () => {
    it('stamps the IP from the request context, not from the body', async () => {
      const { service, db } = setup();

      await service.recordConsent(
        GUEST_ID,
        {
          type: ConsentType.MARKETING,
          granted: true,
          source: 'reception-ipad',
          policyVersion: '2026-01',
          ipAddress: '1.2.3.4',
        } as never,
        actorFixture(),
        CTX,
      );

      const { data } = db.guestConsent.create.mock.calls[0]![0] as { data: GuestConsent };
      expect(data.ipAddress).toBe('10.0.0.8');
      expect(data.policyVersion).toBe('2026-01');
      expect(data.withdrawnAt).toBeNull();
    });

    it('stamps withdrawnAt when consent is refused or withdrawn', async () => {
      const { service, db } = setup();

      const view = await service.recordConsent(
        GUEST_ID,
        {
          type: ConsentType.PHOTO,
          granted: false,
          source: 'reception-ipad',
          policyVersion: '2026-01',
        },
        actorFixture(),
        CTX,
      );

      const { data } = db.guestConsent.create.mock.calls[0]![0] as { data: GuestConsent };
      expect(data.withdrawnAt).toBeInstanceOf(Date);
      expect(view.granted).toBe(false);
    });

    it('records nothing against a guest from another branch', async () => {
      const { service, db } = setup({ guest: null });

      const { status } = await caught(() =>
        service.recordConsent(
          GUEST_ID,
          {
            type: ConsentType.DATA_PROCESSING,
            granted: true,
            source: 'reception-ipad',
            policyVersion: '2026-01',
          },
          actorFixture(),
          CTX,
        ),
      );

      expect(status).toBe(404);
      expect(db.guestConsent.create).not.toHaveBeenCalled();
    });
  });

  /* ───────── the consent ledger and its withdrawal — §11.4, PDPL Art. 6 ───────── */

  describe('listConsents', () => {
    it('answers what stands today as well as everything that ever did', async () => {
      const { service } = setup({
        consents: [
          consentFixture({ id: 'c2', type: ConsentType.MARKETING, granted: true, withdrawnAt: null }),
          consentFixture({
            id: 'c1',
            type: ConsentType.PHOTO,
            granted: true,
            withdrawnAt: new Date('2026-09-14T10:00:00.000Z'),
          }),
        ],
      });

      const ledger = await service.listConsents(GUEST_ID, actorFixture());

      expect(ledger.current.MARKETING.granted).toBe(true);
      expect(ledger.current.MARKETING.policyVersion).toBe('2026-01');
      // Withdrawn, so it no longer stands — and the row is still there.
      expect(ledger.current.PHOTO.granted).toBe(false);
      expect(ledger.current.PHOTO.since).toBe('2026-09-14T10:00:00.000Z');
      // Never asked is not refused, but it has the same effect.
      expect(ledger.current.DATA_PROCESSING).toEqual({
        granted: false,
        since: null,
        policyVersion: null,
        source: null,
      });
      expect(ledger.history).toHaveLength(2);
    });

    it('404s a guest from another branch', async () => {
      const { service } = setup({ guest: null });
      const { status } = await caught(() => service.listConsents(GUEST_ID, actorFixture()));
      expect(status).toBe(404);
    });
  });

  describe('withdrawConsent', () => {
    it('stops the marketing and keeps the proof that it was ever allowed', async () => {
      const { service, db } = setup({
        consents: [consentFixture({ type: ConsentType.MARKETING, granted: true, withdrawnAt: null })],
      });

      await service.withdrawConsent(GUEST_ID, ConsentType.MARKETING, actorFixture());

      const [call] = db.guestConsent.updateMany.mock.calls as Array<
        [{ where: Record<string, unknown>; data: { withdrawnAt: Date } }]
      >;
      expect(call[0].where).toEqual({
        guestId: GUEST_ID,
        type: ConsentType.MARKETING,
        granted: true,
        withdrawnAt: null,
      });
      expect(call[0].data.withdrawnAt).toBeInstanceOf(Date);
      // §11.6: the record survives the withdrawal, because proof that consent
      // existed is what answers a complaint about what was already sent.
      expect(db.guestConsent.deleteMany).not.toHaveBeenCalled();
    });

    it('withdraws EVERY standing grant of that type, not just the newest', async () => {
      // One taken at the desk, one off the website form. Leaving the second
      // standing is how a guest who asked to be left alone keeps hearing from us.
      const { service, db } = setup({
        consents: [
          consentFixture({ id: 'c2', type: ConsentType.MARKETING, granted: true, source: 'website' }),
          consentFixture({ id: 'c1', type: ConsentType.MARKETING, granted: true, source: 'reception-ipad' }),
        ],
      });

      await service.withdrawConsent(GUEST_ID, ConsentType.MARKETING, actorFixture());

      expect(db.guestConsent.updateMany).toHaveBeenCalledTimes(1);
      expect(db.guestConsent.updateMany.mock.calls[0]![0].where.withdrawnAt).toBeNull();
    });

    it('is as easy as granting: no reason, no body, the same role', async () => {
      const { service } = setup({
        consents: [consentFixture({ type: ConsentType.MARKETING, granted: true })],
      });
      // PDPL Art. 6. The signature is the assertion — there is nothing else to pass.
      await expect(
        service.withdrawConsent(GUEST_ID, ConsentType.MARKETING, actorFixture(UserRole.RECEPTIONIST)),
      ).resolves.toBeDefined();
    });

    it('404s when no consent of that type was ever recorded', async () => {
      const { service, db } = setup({ consents: [] });

      const { status, body } = await caught(() =>
        service.withdrawConsent(GUEST_ID, ConsentType.MARKETING, actorFixture()),
      );

      expect(status).toBe(404);
      expect(body.error.code).toBe(ErrorCode.CONSENT_NOT_FOUND);
      expect(db.guestConsent.updateMany).not.toHaveBeenCalled();
    });

    it('409s when it is already withdrawn, so the desk knows the click did nothing', async () => {
      const { service, db } = setup({
        consents: [
          consentFixture({
            type: ConsentType.MARKETING,
            granted: true,
            withdrawnAt: new Date('2026-09-14T10:00:00.000Z'),
          }),
        ],
      });

      const { status, body } = await caught(() =>
        service.withdrawConsent(GUEST_ID, ConsentType.MARKETING, actorFixture()),
      );

      expect(status).toBe(409);
      expect(body.error.code).toBe(ErrorCode.CONSENT_ALREADY_WITHDRAWN);
      expect(db.guestConsent.updateMany).not.toHaveBeenCalled();
    });
  });
});

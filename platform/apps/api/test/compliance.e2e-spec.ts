/**
 * §11 — UAE PDPL, asserted against a real database holding a real fixture.
 *
 * The two claims this suite exists to hold apart:
 *
 *   THE PERSON IS GONE.   After an erasure, the name and the number are not in
 *                         `guests`, not in `booking_requests`, not in the
 *                         attribution snapshots and not in the audit log.
 *   THE MONEY IS NOT.     Every payment, tip and ledger row the guest's bookings
 *                         produced is still there, and the seven financial
 *                         invariants of §13.3 still hold over the whole database
 *                         afterwards. UAE tax law requires five years of
 *                         accounting records and the right to erasure yields to
 *                         it; the transaction is retained while the person is
 *                         severed from it. §11.4.
 *
 * A mocked database would prove neither. `prune_attribution()` is a Postgres
 * function, the erasure is one transaction across seven tables, and the
 * invariants are SQL — so this runs against the same PostgreSQL the concurrency
 * suite does.
 */

import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import request from 'supertest';
import { ConsentType, ErrorCode } from '@berelax/contracts';

import { seed } from '../prisma/seed';
import { bootstrapTestApp, getPrisma, resetDatabase, route } from './setup-e2e';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { INestApplication } from '@nestjs/common';

/** Pinned, for the same reason the invariant suite pins it: a fixture that moves with the clock fails once a quarter. */
const SEED_ANCHOR_DAY = '2026-09-16';

/**
 * The salt the application booted with. `validateEnv` supplies this default
 * outside production, and reading it the same way here is what lets the suite
 * recompute a token the API wrote — which is the whole stability claim.
 */
const ERASURE_SALT = process.env.ERASURE_SALT ?? 'dev-only-erasure-salt-change-me';

function expectedToken(phone: string): string {
  return `erased:${createHash('sha256').update(`${phone}${ERASURE_SALT}`).digest('hex').slice(0, 24)}`;
}

const CREDENTIALS = {
  owner: { email: 'owner@berelax.ae', password: 'BeRelaxOwner2026!' },
  manager: { email: 'manager@berelax.ae', password: 'BeRelaxManager2026!' },
  reception: { email: 'reception@berelax.ae', password: 'BeRelaxReception2026!' },
};

let app: INestApplication;
let http: Server;
let prisma: PrismaService;
let tokens: Record<keyof typeof CREDENTIALS, string>;

/** Guests picked out of the fixture, each with bookings, payments and tips behind them. */
let exportGuest: { id: string; phone: string; fullName: string };
let eraseGuest: { id: string; phone: string; fullName: string };
let consentGuest: { id: string };
/** The visitor behind the erased guest's bookings, captured before it is severed. */
let erasedVisitorId: string;

function query<T>(sql: string): Promise<T[]> {
  return prisma.$queryRawUnsafe<T[]>(sql);
}

async function signIn(who: keyof typeof CREDENTIALS): Promise<string> {
  const res = await request(http).post(route('/auth/login')).send(CREDENTIALS[who]);
  if (res.status !== 200) throw new Error(`login failed for ${who}: ${res.status}`);
  return res.body.accessToken as string;
}

/** Guests carrying every kind of row the export has to find, most-connected first. */
async function richGuests(limit: number): Promise<Array<{ id: string; phone: string; full_name: string }>> {
  return query(`
    SELECT g.id::text, g.phone, g.full_name
      FROM guests g
     WHERE EXISTS (SELECT 1 FROM reservations r JOIN payments p ON p.reservation_id = r.id
                    WHERE r.guest_id = g.id)
       AND EXISTS (SELECT 1 FROM reservations r JOIN tips t ON t.reservation_id = r.id
                    WHERE r.guest_id = g.id)
       AND EXISTS (SELECT 1 FROM reservations r
                    WHERE r.guest_id = g.id AND r.attribution_id IS NOT NULL)
     ORDER BY (SELECT count(*) FROM reservations r WHERE r.guest_id = g.id) DESC, g.id
     LIMIT ${limit}`);
}

beforeAll(async () => {
  prisma = getPrisma();
  await resetDatabase();
  await seed(prisma, { quiet: true, anchorDay: SEED_ANCHOR_DAY });

  const [first, second, third] = await richGuests(3);
  if (!first || !second || !third) throw new Error('the seed produced too few connected guests');
  exportGuest = { id: first.id, phone: first.phone, fullName: first.full_name };
  eraseGuest = { id: second.id, phone: second.phone, fullName: second.full_name };
  consentGuest = { id: third.id };

  // The seed writes no enquiries and no click-outs, and both hold guest identity
  // in columns of their own — so the fixture gets one of each, including the case
  // that matters most: a website enquiry that was never linked to a guest row and
  // carries the number anyway.
  erasedVisitorId = (
    await query<{ visitor_id: string }>(`
      SELECT a.visitor_id::text FROM attribution_snapshots a
        JOIN reservations r ON r.attribution_id = a.id
       WHERE r.guest_id = '${eraseGuest.id}'::uuid LIMIT 1`)
  )[0]!.visitor_id;

  const branchId = (await query<{ id: string }>(`SELECT id::text FROM branches LIMIT 1`))[0]!.id;

  for (const guest of [exportGuest, eraseGuest]) {
    await prisma.bookingRequest.create({
      data: {
        branchId,
        guestId: guest.id,
        guestName: guest.fullName,
        guestPhone: guest.phone,
        guestEmail: 'linked@example.ae',
        message: 'Any time after 9pm please',
        sourceChannel: 'WEBSITE_FORM',
      },
    });
    await prisma.bookingRequest.create({
      data: {
        branchId,
        guestName: guest.fullName,
        guestPhone: guest.phone,
        message: 'Called the number on Instagram',
        sourceChannel: 'WHATSAPP',
      },
    });
  }

  await prisma.outboundClick.createMany({
    data: [
      { visitorId: erasedVisitorId, target: 'whatsapp', context: 'hero', landingPath: '/' },
      { visitorId: erasedVisitorId, target: 'call', context: 'footer', landingPath: '/offers' },
    ],
  });

  // Blocked, because "a blocked guest stays blocked" is the reason the phone is
  // hashed rather than nulled, and it cannot be asserted on a guest who was
  // welcome in the first place.
  await prisma.guest.update({ where: { id: eraseGuest.id }, data: { isBlocked: true } });

  ({ app, http } = await bootstrapTestApp());
  tokens = {
    owner: await signIn('owner'),
    manager: await signIn('manager'),
    reception: await signIn('reception'),
  };
}, 180_000);

afterAll(async () => {
  await app?.close();
});

/* ─────────────────────── A. access and portability ─────────────────────── */

describe('GET /guests/:id/export — §11.4, PDPL Arts. 13-15', () => {
  it('returns a bundle that matches the database row for row', async () => {
    const res = await request(http)
      .get(route(`/guests/${exportGuest.id}/export`))
      .set('Authorization', `Bearer ${tokens.manager}`);

    expect(res.status).toBe(200);
    const bundle = res.body;

    // Counted independently of the endpoint. A partial export is a failed
    // request, so "complete" is asserted against the database, not against a
    // snapshot of what the exporter happened to return.
    const reservations = await prisma.reservation.findMany({
      where: { guestId: exportGuest.id },
      select: { id: true },
    });
    const reservationIds = reservations.map((r) => r.id);
    const [consents, payments, tips, bookingRequests] = await Promise.all([
      prisma.guestConsent.count({ where: { guestId: exportGuest.id } }),
      prisma.payment.count({ where: { reservationId: { in: reservationIds } } }),
      prisma.tip.count({ where: { reservationId: { in: reservationIds } } }),
      prisma.bookingRequest.count({
        where: { OR: [{ guestId: exportGuest.id }, { guestPhone: exportGuest.phone }] },
      }),
    ]);
    const snapshots = await prisma.attributionSnapshot.count({
      where: {
        OR: [
          { reservations: { some: { guestId: exportGuest.id } } },
          { bookingRequest: { is: { guestId: exportGuest.id } } },
        ],
      },
    });

    expect(bundle.counts).toEqual({
      consents,
      reservations: reservations.length,
      payments,
      tips,
      bookingRequests,
      attributionSnapshots: snapshots,
    });

    // Every count is non-trivial, or the equality above proves nothing.
    expect(consents).toBeGreaterThan(0);
    expect(reservations.length).toBeGreaterThan(0);
    expect(payments).toBeGreaterThan(0);
    expect(tips).toBeGreaterThan(0);
    expect(bookingRequests).toBe(2);
    expect(snapshots).toBeGreaterThan(0);

    expect(bundle.guest).toMatchObject({ id: exportGuest.id, phone: exportGuest.phone });
    expect(bundle.consents[0]).toMatchObject({ policyVersion: expect.any(String) });
    expect(bundle.reservations[0]).toMatchObject({
      ref: expect.stringMatching(/^BR-/),
      baseCostFils: expect.any(Number),
      businessDay: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    expect(bundle.payments[0].amountFils).toEqual(expect.any(Number));
    expect(bundle.attributionSnapshots[0].linkedReservationIds.length).toBeGreaterThan(0);
    // The enquiry that was never linked is in there, and says how it was found.
    expect(bundle.bookingRequests.some((r: { matchedByPhone: boolean }) => r.matchedByPhone)).toBe(
      true,
    );
  });

  it('records GUEST_DATA_EXPORTED against the manager who pulled it', async () => {
    const entries = await prisma.financialAuditLog.findMany({
      where: { action: 'GUEST_DATA_EXPORTED', entityId: exportGuest.id },
      orderBy: { createdAt: 'desc' },
    });

    expect(entries.length).toBeGreaterThan(0);
    const [entry] = entries;
    expect(entry!.actorRole).toBe('MANAGER');
    expect(entry!.actorUserId).not.toBeNull();
    expect(entry!.requestId).toEqual(expect.any(String));
    // Counts, never contents.
    expect(JSON.stringify(entry!.afterState)).not.toContain(exportGuest.phone);
  });

  it('is not reception’s to call', async () => {
    const res = await request(http)
      .get(route(`/guests/${exportGuest.id}/export`))
      .set('Authorization', `Bearer ${tokens.reception}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(ErrorCode.INSUFFICIENT_ROLE);
  });
});

/* ─────────────────────────── B. erasure ─────────────────────────── */

describe('POST /guests/:id/erase — §11.4', () => {
  /** Captured before the erasure, so "still there afterwards" has something to mean. */
  let moneyBefore: { payments: number; tips: number; ledger: number; reservations: number };
  let reservationIds: string[];

  beforeAll(async () => {
    const rows = await prisma.reservation.findMany({
      where: { guestId: eraseGuest.id },
      select: { id: true },
    });
    reservationIds = rows.map((r) => r.id);
    moneyBefore = {
      reservations: rows.length,
      payments: await prisma.payment.count({ where: { reservationId: { in: reservationIds } } }),
      tips: await prisma.tip.count({ where: { reservationId: { in: reservationIds } } }),
      ledger: await prisma.therapistPayoutLedger.count({
        where: { reservationId: { in: reservationIds } },
      }),
    };
    expect(moneyBefore.payments).toBeGreaterThan(0);
    expect(moneyBefore.tips).toBeGreaterThan(0);
  });

  it('requires a reason', async () => {
    const res = await request(http)
      .post(route(`/guests/${eraseGuest.id}/erase`))
      .set('Authorization', `Bearer ${tokens.manager}`)
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it('is not reception’s to call', async () => {
    const res = await request(http)
      .post(route(`/guests/${eraseGuest.id}/erase`))
      .set('Authorization', `Bearer ${tokens.reception}`)
      .send({ reason: 'Guest asked at the desk' });

    expect(res.status).toBe(403);
    const still = await prisma.guest.findUniqueOrThrow({ where: { id: eraseGuest.id } });
    expect(still.anonymisedAt).toBeNull();
  });

  it('severs the person from every table that named them', async () => {
    const res = await request(http)
      .post(route(`/guests/${eraseGuest.id}/erase`))
      .set('Authorization', `Bearer ${tokens.manager}`)
      .send({ reason: 'Guest asked to be erased by phone on the 14th' });

    expect(res.status).toBe(200);
    expect(res.body.phoneToken).toBe(expectedToken(eraseGuest.phone));

    const guest = await prisma.guest.findUniqueOrThrow({ where: { id: eraseGuest.id } });
    expect(guest.fullName).toBe('Erased guest');
    expect(guest.phone).toBe(expectedToken(eraseGuest.phone));
    expect(guest.email).toBeNull();
    expect(guest.notes).toBeNull();
    expect(guest.anonymisedAt).not.toBeNull();
    expect(guest.deletedAt).not.toBeNull();

    // Consents gone, attribution severed inside the 90 days, click log cleared.
    expect(await prisma.guestConsent.count({ where: { guestId: eraseGuest.id } })).toBe(0);
    const snapshots = await prisma.attributionSnapshot.findMany({
      where: { reservations: { some: { guestId: eraseGuest.id } } },
    });
    expect(snapshots.length).toBeGreaterThan(0);
    for (const snapshot of snapshots) {
      expect(snapshot.visitorId).toBe('00000000-0000-0000-0000-000000000000');
      expect(snapshot.touches).toEqual([]);
      expect(snapshot.landingPath).toBeNull();
      expect(snapshot.prunedAt).not.toBeNull();
    }

    // The NUMBER is nowhere in the database any more — including the enquiry
    // inbox, which keeps it in a column of its own. The phone is the unambiguous
    // identifier here; the fixture's names repeat across its guest pool, so the
    // name is asserted against the rows that belonged to this person.
    const [leaks] = await query<{ by_phone: number; requests_by_phone: number; named: number }>(`
      SELECT (SELECT count(*)::int FROM guests
               WHERE phone = '${eraseGuest.phone}')                            AS by_phone,
             (SELECT count(*)::int FROM booking_requests
               WHERE guest_phone = '${eraseGuest.phone}')                      AS requests_by_phone,
             (SELECT count(*)::int FROM booking_requests
               WHERE guest_name = '${eraseGuest.fullName.replace(/'/g, "''")}') AS named`);
    expect(leaks!.by_phone).toBe(0);
    expect(leaks!.requests_by_phone).toBe(0);
    expect(leaks!.named).toBe(0);
    expect(await prisma.outboundClick.count({ where: { visitorId: erasedVisitorId } })).toBe(0);

    // And the shell has left reception's guest book entirely: typing the number
    // the guest used to give finds nobody. (Searched by number rather than by
    // name because the fixture's name pool repeats across two hundred guests.)
    const search = await request(http)
      .get(route('/guests'))
      .query({ search: eraseGuest.phone })
      .set('Authorization', `Bearer ${tokens.reception}`);
    expect(search.status).toBe(200);
    expect(search.body).toEqual([]);
  });

  it('keeps every financial row the bookings produced', async () => {
    // The reason "delete" did not delete. UAE tax law requires five years of
    // accounting records, and the right to erasure yields to another legal
    // obligation — so the transaction is retained and the person severed from it.
    const after = {
      reservations: await prisma.reservation.count({ where: { guestId: eraseGuest.id } }),
      payments: await prisma.payment.count({ where: { reservationId: { in: reservationIds } } }),
      tips: await prisma.tip.count({ where: { reservationId: { in: reservationIds } } }),
      ledger: await prisma.therapistPayoutLedger.count({
        where: { reservationId: { in: reservationIds } },
      }),
    };

    expect(after).toEqual(moneyBefore);

    // Amounts, dates and the therapist are untouched: the row still balances.
    const [sums] = await query<{ payments_fils: number; tips_fils: number }>(`
      SELECT COALESCE(SUM(p.amount_fils), 0)::int AS payments_fils,
             (SELECT COALESCE(SUM(t.amount_fils), 0)::int FROM tips t
               WHERE t.reservation_id IN (SELECT id FROM reservations WHERE guest_id = '${eraseGuest.id}'::uuid)) AS tips_fils
        FROM payments p
       WHERE p.reservation_id IN (SELECT id FROM reservations WHERE guest_id = '${eraseGuest.id}'::uuid)`);
    expect(sums!.payments_fils).toBeGreaterThan(0);
    expect(sums!.tips_fils).toBeGreaterThan(0);
  });

  it('leaves the financial invariants of §13.3 intact across the whole database', async () => {
    // The canary. If an erasure ever starts taking money with it, this is where
    // it surfaces — over every row in the fixture, not just the erased guest's.
    const ledgerOffenders = await query(`
      SELECT e.display_name AS employee,
             b.ledger_sum - (b.tips_collected + b.commissions - b.payouts) AS delta_fils
        FROM employees e
        CROSS JOIN LATERAL (
          SELECT (SELECT COALESCE(SUM(amount_fils), 0)::int FROM therapist_payout_ledger
                   WHERE employee_id = e.id)                                        AS ledger_sum,
                 (SELECT COALESCE(SUM(amount_fils), 0)::int FROM tips
                   WHERE employee_id = e.id AND type = 'COLLECTED_BY_BUSINESS'
                     AND reversed_by_tip_id IS NULL)                                AS tips_collected,
                 (SELECT COALESCE(SUM(amount_fils), 0)::int FROM therapist_payout_ledger
                   WHERE employee_id = e.id AND entry_type = 'COMMISSION_ACCRUAL')  AS commissions,
                 (SELECT COALESCE(SUM(-amount_fils), 0)::int FROM therapist_payout_ledger
                   WHERE employee_id = e.id AND entry_type = 'PAYOUT')              AS payouts
        ) b
       WHERE b.ledger_sum <> b.tips_collected + b.commissions - b.payouts`);
    expect(ledgerOffenders).toEqual([]);

    const directCashAccrued = await query(`
      SELECT l.id FROM therapist_payout_ledger l JOIN tips t ON t.id = l.tip_id
       WHERE t.type = 'DIRECT_CASH'`);
    expect(directCashAccrued).toEqual([]);

    const malformedTips = await query(`
      SELECT t.id FROM tips t
       WHERE t.type = 'COLLECTED_BY_BUSINESS' AND t.amount_fils > 0
         AND ((SELECT count(*) FROM payments p WHERE p.id = t.payment_id AND p.kind = 'TIP') <> 1
           OR (SELECT count(*) FROM therapist_payout_ledger l
                WHERE l.tip_id = t.id AND l.entry_type = 'TIP_ACCRUAL') <> 1)`);
    expect(malformedTips).toEqual([]);

    const underCollected = await query(`
      SELECT r.ref FROM reservations r
       WHERE r.status = 'COMPLETED'
         AND (SELECT COALESCE(SUM(p.amount_fils), 0) FROM payments p
               WHERE p.reservation_id = r.id AND p.kind IN ('BASE', 'ADJUSTMENT', 'REFUND'))
             <> r.base_cost_fils`);
    expect(underCollected).toEqual([]);

    const brokenLifecycle = await query(`
      SELECT id FROM reservations
       WHERE (status = 'COMPLETED'   AND completed_at IS NULL)
          OR (status = 'IN_PROGRESS' AND actual_arrival_at IS NULL)`);
    expect(brokenLifecycle).toEqual([]);

    // And the exclusion constraints are still installed — an erasure has no
    // business dropping one, and this is where it would be noticed.
    const [constraints] = await query<{ n: number }>(`
      SELECT count(*)::int AS n FROM pg_constraint
       WHERE conrelid = 'reservations'::regclass AND contype = 'x'`);
    expect(constraints!.n).toBeGreaterThanOrEqual(3);
  });

  it('writes GUEST_ERASED with the reason, and no name or number in it', async () => {
    const [entry] = await prisma.financialAuditLog.findMany({
      where: { action: 'GUEST_ERASED', entityId: eraseGuest.id },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });

    expect(entry).toBeDefined();
    expect(entry!.actorRole).toBe('MANAGER');
    const serialised = JSON.stringify([entry!.beforeState, entry!.afterState]);
    expect(serialised).toContain('Guest asked to be erased by phone on the 14th');
    expect(serialised).not.toContain(eraseGuest.phone);
    expect(serialised).not.toContain(eraseGuest.fullName);
  });

  it('409s a second erasure rather than hashing the hash', async () => {
    const res = await request(http)
      .post(route(`/guests/${eraseGuest.id}/erase`))
      .set('Authorization', `Bearer ${tokens.manager}`)
      .send({ reason: 'Asked again' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(ErrorCode.GUEST_ALREADY_ERASED);

    // Unchanged: a second pass would write erased:sha256("erased:..." + salt),
    // which matches no number that ever existed and unblocks a blocked guest.
    const guest = await prisma.guest.findUniqueOrThrow({ where: { id: eraseGuest.id } });
    expect(guest.phone).toBe(expectedToken(eraseGuest.phone));
  });

  it('keeps the phone hash stable, so a blocked guest stays blocked', async () => {
    // The number is unrecoverable. Asking "is THIS the number that was erased"
    // still has an answer — which is the entire point of hashing rather than
    // nulling. Recomputed here exactly as the desk would recompute it from a
    // number a walk-in gives.
    const token = expectedToken(eraseGuest.phone);

    const shell = await prisma.guest.findFirst({
      where: { phone: { startsWith: token } },
      select: { id: true, isBlocked: true, phone: true, anonymisedAt: true },
    });

    expect(shell?.id).toBe(eraseGuest.id);
    expect(shell?.isBlocked).toBe(true);
    expect(shell?.anonymisedAt).not.toBeNull();
    // A different number does not find them, so the match is the number and not
    // merely the prefix.
    expect(
      await prisma.guest.findFirst({ where: { phone: { startsWith: expectedToken('+971500000000') } } }),
    ).toBeNull();
  });
});

/* ───────────────────── C. consent and its withdrawal ───────────────────── */

describe('consent — PDPL Art. 6', () => {
  it('reads the ledger: what stands today and everything that ever did', async () => {
    const res = await request(http)
      .get(route(`/guests/${consentGuest.id}/consents`))
      .set('Authorization', `Bearer ${tokens.reception}`);

    expect(res.status).toBe(200);
    expect(res.body.current.DATA_PROCESSING.granted).toBe(true);
    expect(res.body.history.length).toBeGreaterThan(0);
  });

  it('withdrawing is one call at the same desk that granted it', async () => {
    // Granted here first, so the test does not depend on which guests the seed
    // happened to give marketing consent to.
    const granted = await request(http)
      .post(route(`/guests/${consentGuest.id}/consents`))
      .set('Authorization', `Bearer ${tokens.reception}`)
      .send({
        type: ConsentType.MARKETING,
        granted: true,
        source: 'reception-ipad',
        policyVersion: '2026-01',
      });
    expect(granted.status).toBe(201);

    const res = await request(http)
      .post(route(`/guests/${consentGuest.id}/consents/MARKETING/withdraw`))
      .set('Authorization', `Bearer ${tokens.reception}`)
      .send();

    expect(res.status).toBe(200);
    // Marketing has stopped...
    expect(res.body.current.MARKETING.granted).toBe(false);
    // ...and the proof that it was ever allowed is retained. §11.6.
    const rows = await prisma.guestConsent.findMany({
      where: { guestId: consentGuest.id, type: ConsentType.MARKETING },
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.withdrawnAt !== null)).toBe(true);
    expect(rows.some((r) => r.granted)).toBe(true);
  });

  it('409s a second withdrawal, so the desk knows the click did nothing', async () => {
    const res = await request(http)
      .post(route(`/guests/${consentGuest.id}/consents/MARKETING/withdraw`))
      .set('Authorization', `Bearer ${tokens.reception}`)
      .send();

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(ErrorCode.CONSENT_ALREADY_WITHDRAWN);
  });

  it('404s a type that was never recorded', async () => {
    const res = await request(http)
      .post(route(`/guests/${consentGuest.id}/consents/PHOTO/withdraw`))
      .set('Authorization', `Bearer ${tokens.reception}`)
      .send();

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe(ErrorCode.CONSENT_NOT_FOUND);
  });

  it('rejects a consent type that is not one', async () => {
    const res = await request(http)
      .post(route(`/guests/${consentGuest.id}/consents/NEWSLETTER/withdraw`))
      .set('Authorization', `Bearer ${tokens.reception}`)
      .send();

    expect(res.status).toBe(422);
  });
});

/* ───────────────────────── D. retention ───────────────────────── */

describe('POST /compliance/retention/run — §11.6', () => {
  let lapsedGuestId: string;

  beforeAll(async () => {
    // A guest whose last contact with the business is four years old, and an
    // attribution snapshot and a click past the 90-day window. The seed's own
    // history is sixty days deep, so without these the run would be a no-op and
    // would prove nothing.
    const branchId = (await query<{ id: string }>(`SELECT id::text FROM branches LIMIT 1`))[0]!.id;
    const lapsed = await prisma.guest.create({
      data: {
        branchId,
        fullName: 'Long Departed',
        phone: '+971509990001',
        email: 'departed@example.ae',
        notes: 'Prefers the quiet room',
      },
    });
    lapsedGuestId = lapsed.id;
    await query(
      `UPDATE guests SET created_at = now() - interval '4 years' WHERE id = '${lapsed.id}'::uuid`,
    );

    await query(`
      UPDATE attribution_snapshots
         SET captured_at = now() - interval '200 days'
       WHERE id = (SELECT id FROM attribution_snapshots WHERE pruned_at IS NULL ORDER BY id LIMIT 1)`);
    await prisma.outboundClick.create({ data: { target: 'whatsapp', context: 'hero' } });
    await query(`UPDATE outbound_clicks SET created_at = now() - interval '200 days'
                  WHERE created_at > now() - interval '1 day'`);
  });

  it('is the owner’s call, not a manager’s', async () => {
    const res = await request(http)
      .post(route('/compliance/retention/run'))
      .set('Authorization', `Bearer ${tokens.manager}`)
      .send({ dryRun: true });

    expect(res.status).toBe(403);
  });

  it('a dry run says what it would do and does none of it', async () => {
    const res = await request(http)
      .post(route('/compliance/retention/run'))
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({ dryRun: true });

    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.attribution.snapshotsPruned).toBeGreaterThan(0);
    expect(res.body.guests.guestIds).toContain(lapsedGuestId);
    expect(res.body.guests.anonymised).toBe(0);

    const untouched = await prisma.guest.findUniqueOrThrow({ where: { id: lapsedGuestId } });
    expect(untouched.anonymisedAt).toBeNull();
    expect(
      await prisma.attributionSnapshot.count({
        where: { prunedAt: null, capturedAt: { lt: new Date(Date.now() - 90 * 86_400_000) } },
      }),
    ).toBeGreaterThan(0);
  });

  it('prunes attribution through the database function and reports what it pruned', async () => {
    const res = await request(http)
      .post(route('/compliance/retention/run'))
      .set('Authorization', `Bearer ${tokens.owner}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.attribution.retentionDays).toBe(90);
    expect(res.body.attribution.snapshotsPruned).toBeGreaterThan(0);
    expect(res.body.attribution.outboundClicksDeleted).toBeGreaterThan(0);

    // Nothing past the window is left unpruned, and the aggregate channel data
    // that reporting reads survived. §5.6.
    const stale = await prisma.attributionSnapshot.findMany({
      where: { prunedAt: null, capturedAt: { lt: new Date(Date.now() - 90 * 86_400_000) } },
    });
    expect(stale).toEqual([]);
    const [pruned] = await query<{ first_touch: Record<string, unknown> }>(`
      SELECT first_touch FROM attribution_snapshots WHERE pruned_at IS NOT NULL
         AND visitor_id = '00000000-0000-0000-0000-000000000000' LIMIT 1`);
    expect(pruned!.first_touch).toHaveProperty('source');
  });

  it('anonymises a lapsed guest down the same path as the erasure endpoint', async () => {
    const guest = await prisma.guest.findUniqueOrThrow({ where: { id: lapsedGuestId } });

    expect(guest.fullName).toBe('Erased guest');
    expect(guest.phone).toBe(expectedToken('+971509990001'));
    expect(guest.email).toBeNull();
    expect(guest.anonymisedAt).not.toBeNull();

    // The same audit action, with retention named as the reason — one meaning of
    // "erased", reached two ways.
    const [entry] = await prisma.financialAuditLog.findMany({
      where: { action: 'GUEST_ERASED', entityId: lapsedGuestId },
      take: 1,
    });
    expect(entry).toBeDefined();
    expect(entry!.actorRole).toBe('OWNER');
    expect(JSON.stringify(entry!.afterState)).toMatch(/no visit in 3 years/i);
  });
});

/* ──────────────────── E. the record of processing ──────────────────── */

describe('GET /compliance/processing-register — PDPL Art. 7', () => {
  beforeAll(async () => {
    // `approximateRows` reads pg_class.reltuples — planner statistics, which are
    // empty until something analyses the table. On a production database
    // autovacuum keeps them current; on a database seeded four seconds ago
    // nothing has looked yet, so the register would report zero of everything.
    await prisma.$executeRawUnsafe('ANALYZE');
  });

  it('is the owner’s document', async () => {
    const res = await request(http)
      .get(route('/compliance/processing-register'))
      .set('Authorization', `Bearer ${tokens.manager}`);

    expect(res.status).toBe(403);
  });

  it('derives itself from the live schema and reports no drift', async () => {
    const res = await request(http)
      .get(route('/compliance/processing-register'))
      .set('Authorization', `Bearer ${tokens.owner}`);

    expect(res.status).toBe(200);
    const register = res.body;

    // The assertion that keeps this honest: if somebody adds a table holding
    // guest data and does not describe it, this fails here rather than in front
    // of a regulator.
    expect(register.drift).toEqual({
      clean: true,
      undeclaredTables: [],
      missingTables: [],
      missingColumns: [],
    });

    // And the columns really did come out of the database.
    const guests = register.activities
      .find((a: { id: string }) => a.id === 'bookings')
      .data.find((d: { table: string }) => d.table === 'guests');
    expect(guests.columns.map((c: { name: string }) => c.name)).toEqual(
      expect.arrayContaining(['full_name', 'phone', 'email', 'notes', 'anonymised_at']),
    );
    expect(guests.approximateRows).toBeGreaterThan(0);

    expect(register.retentionJob.functionInstalled).toBe(true);
    expect(register.retentionJob.configured).toMatchObject({
      attributionRetentionDays: 90,
      guestRetentionYears: 3,
      financialRetentionYears: 5,
    });
    expect(register.healthData.stored).toBe(false);
    expect(register.crossBorderTransfer.dataLeavesTheUae).toBe(true);
  });
});

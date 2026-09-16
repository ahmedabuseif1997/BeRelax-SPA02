/**
 * The test that matters most. Spec §13.1, and the exit criterion for phase 0.
 *
 * Everything else in this system is ordinary CRUD. This is the one that has to
 * pass, and it has to pass against a REAL PostgreSQL — the guarantee under test
 * is an exclusion constraint on a GiST index, which no mock has.
 *
 * Three claims, one per test:
 *
 *   1. Twenty-five receptionists tapping Confirm in the same second produce
 *      exactly one booking. Not "usually one". One.
 *   2. `blocked_until` is `ends_at + turnaround`, and the range is half-open, so
 *      a session may start at the exact minute the previous one frees and not
 *      one minute sooner.
 *   3. Cancelling releases the slot immediately, because the constraints carry a
 *      partial predicate rather than a delete.
 */

import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { ErrorCode, SourceChannel } from '@berelax/contracts';

import {
  authTokenFor,
  bootstrapTestApp,
  createFixtures,
  resetDatabase,
  route,
  type Fixtures,
  type TestApp,
} from './setup-e2e';

/**
 * 19:00 on a Friday evening, inside the 11:00–02:00 trading window. The literal
 * +04:00 offset is exact: Dubai has no daylight saving (§3.2).
 */
const SLOT_START = '2026-09-20T19:00:00+04:00';
/** 19:00 + 60 minutes of treatment. */
const SLOT_END = '2026-09-20T20:00:00+04:00';
/** …+ the branch's 15-minute turnaround. The therapist is free from this instant. */
const BLOCKED_UNTIL = '2026-09-20T20:15:00+04:00';
/** One minute inside the turnaround. */
const ONE_MINUTE_EARLY = '2026-09-20T20:14:00+04:00';

let ctx: TestApp;
let fixtures: Fixtures;
let token: string;
let guestSeq = 0;

/** E.164 as the contract demands: `+9715` followed by exactly eight digits. */
const nextGuestPhone = (): string => `+97150${String(1_000_000 + guestSeq).slice(-7)}`;

/**
 * One booking attempt.
 *
 * `roomId` is deliberately left unset. A NULL room can never collide (NULL = NULL
 * is never true, §5.2), which leaves the therapist constraint as the ONLY one that
 * can fire — so `THERAPIST_ALREADY_BOOKED` is the code under test rather than
 * whichever of two constraints Postgres happened to evaluate first.
 */
function book(startsAt: string, employeeId: string = fixtures.employeeIds[0]): request.Test {
  const n = guestSeq++;
  return request(ctx.http)
    .post(route('/reservations'))
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', randomUUID())
    .send({
      employeeId,
      serviceId: fixtures.serviceId,
      startsAt,
      sourceChannel: SourceChannel.PHONE,
      guestName: `Guest ${n}`,
      guestPhone: nextGuestPhone(),
    });
}

/**
 * Collapse a response to the pair that matters. `expect(outcome(res)).toEqual(...)`
 * prints the actual status AND error code on failure, where `expect(res.status)`
 * would print `500` and leave you guessing.
 */
function outcome(res: request.Response): { status: number; code?: string } {
  const code = (res.body as { error?: { code?: string } } | undefined)?.error?.code;
  return code ? { status: res.status, code } : { status: res.status };
}

beforeAll(async () => {
  ctx = await bootstrapTestApp();
});

afterAll(async () => {
  await ctx.app.close();
});

beforeEach(async () => {
  await resetDatabase();
  fixtures = await createFixtures(ctx.prisma);
  token = await authTokenFor(ctx.http, fixtures.users.receptionist.email);
  guestSeq = 0;
});

describe('double-booking prevention', () => {
  it('admits exactly one of 25 simultaneous bookings for the same therapist and slot', async () => {
    const N = 25;
    const employeeId = fixtures.employeeIds[0];

    // Fired without awaiting in between: every request is in flight before the
    // first one commits, which is the only way the race is real.
    const settled = await Promise.allSettled(
      Array.from({ length: N }, () => book(SLOT_START, employeeId)),
    );

    // A dropped connection would quietly shrink the denominator and could make a
    // later assertion pass for the wrong reason. Name them first.
    const transportFailures = settled
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => String(r.reason));
    expect(transportFailures).toEqual([]);

    const responses = settled
      .filter((r): r is PromiseFulfilledResult<request.Response> => r.status === 'fulfilled')
      .map((r) => r.value);

    const tally: Record<number, number> = {};
    for (const res of responses) tally[res.status] = (tally[res.status] ?? 0) + 1;
    // A bare `expected {201:1, 409:24}, got {...500: 8}` sends you hunting. Print
    // the bodies of anything that is neither the winner nor a clean conflict, so
    // a failure names its own cause — a throttle, a pool timeout, a real bug.
    const unexpected = responses.filter((r) => r.status !== 201 && r.status !== 409);
    if (unexpected.length > 0) {
       
      console.log(
        'Neither accepted nor conflicted:\n' +
          unexpected.map((r) => `  ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`).join('\n'),
      );
    }

    expect(tally).toEqual({ 201: 1, 409: N - 1 });

    const conflictCodes = [
      ...new Set(responses.filter((r) => r.status === 409).map((r) => outcome(r).code)),
    ];
    expect(conflictCodes).toEqual([ErrorCode.THERAPIST_ALREADY_BOOKED]);

    // The database is the arbiter, so ask it rather than trusting the HTTP tally.
    const live = await ctx.prisma.reservation.count({
      where: {
        employeeId,
        startsAt: new Date(SLOT_START),
        status: { in: ['SCHEDULED', 'IN_PROGRESS'] },
      },
    });
    expect(live).toBe(1);

    // Not merely one LIVE row — one row, full stop. Nothing was written and then
    // abandoned in some other status.
    const total = await ctx.prisma.reservation.count({
      where: { employeeId, startsAt: new Date(SLOT_START) },
    });
    expect(total).toBe(1);

    // Each attempt upserts its guest inside the same transaction as the booking,
    // so twenty-four rolled-back transactions must have taken their guests with
    // them. This is the assertion that proves the failures were atomic.
    expect(await ctx.prisma.guest.count()).toBe(1);
  });

  it('allows a back-to-back booking that starts exactly when the previous slot frees', async () => {
    const blocker = await book(SLOT_START);
    expect(outcome(blocker)).toEqual({ status: 201 });

    // The derive trigger's arithmetic, read straight off the response: 60 minutes
    // of treatment, then 15 minutes of turnaround (§5.3).
    expect(blocker.body.endsAt).toBe(new Date(SLOT_END).toISOString());
    expect(blocker.body.blockedUntil).toBe(new Date(BLOCKED_UNTIL).toISOString());

    // 20:14 is attempted FIRST, while the 19:00 booking is the only thing on the
    // grid. Doing it the other way round — 20:15 then 20:14 — would see 20:14
    // rejected by the 20:15 booking and prove nothing about the turnaround.
    const tooEarly = await book(ONE_MINUTE_EARLY);
    expect(outcome(tooEarly)).toEqual({
      status: 409,
      code: ErrorCode.THERAPIST_ALREADY_BOOKED,
    });

    // …and one minute later it fits exactly, because the range is '[)'. With the
    // default '[]' this would fail and reception could never book back-to-back.
    const backToBack = await book(BLOCKED_UNTIL);
    expect(outcome(backToBack)).toEqual({ status: 201 });

    const live = await ctx.prisma.reservation.count({
      where: { employeeId: fixtures.employeeIds[0], status: 'SCHEDULED' },
    });
    expect(live).toBe(2);
  });

  it('frees the slot the instant the blocking reservation is cancelled', async () => {
    const first = await book(SLOT_START);
    expect(outcome(first)).toEqual({ status: 201 });

    // The slot really is held — otherwise the rebooking below would prove nothing.
    const blocked = await book(SLOT_START);
    expect(outcome(blocked)).toEqual({
      status: 409,
      code: ErrorCode.THERAPIST_ALREADY_BOOKED,
    });

    const cancelled = await request(ctx.http)
      .post(route(`/reservations/${first.body.id}/cancel`))
      .set('Authorization', `Bearer ${token}`)
      .send({ reason: 'guest called' });
    expect(outcome(cancelled)).toEqual({ status: 200 });
    expect(cancelled.body.status).toBe('CANCELLED');

    const rebooked = await book(SLOT_START);
    expect(outcome(rebooked)).toEqual({ status: 201 });
    expect(rebooked.body.id).not.toBe(first.body.id);

    // Both rows are still there. The slot was freed by the constraints' partial
    // predicate — `WHERE status IN ('SCHEDULED','IN_PROGRESS')` — not by deleting
    // history, which a spa must never do to a booking somebody paid a deposit on.
    const rows = await ctx.prisma.reservation.findMany({
      where: { startsAt: new Date(SLOT_START) },
      select: { status: true },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((r) => r.status)).toEqual(['CANCELLED', 'SCHEDULED']);
  });
});

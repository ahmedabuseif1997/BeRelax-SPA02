/**
 * Moving a booking. Spec §7.3.
 *
 * The interesting claim is not that a `PATCH` updates a row — it is that moving
 * a booking into an occupied window is refused by the same exclusion constraints
 * that refuse an insert. A reschedule is a second way to double-book, and it
 * would be an easy one to leave unguarded: the obvious implementation checks
 * availability first, which reopens exactly the race the constraints exist to
 * close (§5.5).
 *
 * The rest of the file pins the boundaries: a booking that has started cannot be
 * moved, a changed treatment re-snapshots its price, and the derive trigger
 * recomputes the window rather than trusting whatever the caller sent.
 */

import request from 'supertest';
import { randomUUID } from 'node:crypto';
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

/** Inside the 11:00–02:00 trading window; +04:00 is exact, Dubai has no DST. */
const EVENING = '2026-10-02T19:00:00+04:00';
/** Far enough away that the two never touch, even with turnaround. */
const LATER = '2026-10-02T22:00:00+04:00';

describe('rescheduling a booking', () => {
  let app: TestApp;
  let fx: Fixtures;
  let reception: string;

  beforeAll(async () => {
    app = await bootstrapTestApp();
  });

  afterAll(async () => {
    await app.app.close();
  });

  beforeEach(async () => {
    await resetDatabase();
    fx = await createFixtures();
    reception = await authTokenFor(app.http, fx.users.receptionist.email);
  });

  const book = (overrides: Record<string, unknown> = {}) =>
    request(app.http)
      .post(route('/reservations'))
      .set('Authorization', `Bearer ${reception}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        employeeId: fx.employeeIds[0],
        serviceId: fx.serviceId,
        startsAt: EVENING,
        guestName: 'Reschedule Guest',
        guestPhone: `+9715${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
        sourceChannel: SourceChannel.PHONE,
        ...overrides,
      });

  const patch = (id: string, body: Record<string, unknown>) =>
    request(app.http)
      .patch(route(`/reservations/${id}`))
      .set('Authorization', `Bearer ${reception}`)
      .send({ reason: 'guest called to change', ...body });

  it('refuses a move into a window another booking already holds', async () => {
    const blocker = await book({ startsAt: LATER });
    expect(blocker.status).toBe(201);

    const mover = await book({ startsAt: EVENING, employeeId: fx.employeeIds[0] });
    expect(mover.status).toBe(201);

    // The same therapist, onto the slot the blocker holds. The constraint, not
    // a pre-check, is what says no.
    const res = await patch(mover.body.id, { startsAt: LATER });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(ErrorCode.THERAPIST_ALREADY_BOOKED);

    // And the booking did not move.
    const after = await request(app.http)
      .get(route(`/reservations/${mover.body.id}`))
      .set('Authorization', `Bearer ${reception}`);
    expect(new Date(after.body.startsAt).toISOString()).toBe(new Date(EVENING).toISOString());
  });

  it('allows the same move once the blocking booking is out of the way', async () => {
    const blocker = await book({ startsAt: LATER });
    const mover = await book({ startsAt: EVENING });

    await request(app.http)
      .post(route(`/reservations/${blocker.body.id}/cancel`))
      .set('Authorization', `Bearer ${reception}`)
      .send({ reason: 'guest cancelled' })
      .expect(200);

    const res = await patch(mover.body.id, { startsAt: LATER });
    expect(res.status).toBe(200);
    expect(new Date(res.body.startsAt).toISOString()).toBe(new Date(LATER).toISOString());
  });

  it('recomputes the window from the trigger rather than trusting the caller', async () => {
    const created = await book();
    const res = await patch(created.body.id, { serviceId: fx.longServiceId });

    expect(res.status).toBe(200);
    expect(res.body.durationMinutes).toBe(90);
    // 19:00 + 90 minutes of treatment, then the branch's 15-minute turnaround.
    expect(new Date(res.body.endsAt).toISOString())
      .toBe(new Date('2026-10-02T20:30:00+04:00').toISOString());
    expect(new Date(res.body.blockedUntil).toISOString())
      .toBe(new Date('2026-10-02T20:45:00+04:00').toISOString());
  });

  it('re-snapshots the price when the treatment changes', async () => {
    const created = await book();
    expect(created.body.baseCostFils).toBe(25_000);

    const res = await patch(created.body.id, { serviceId: fx.longServiceId });
    expect(res.status).toBe(200);
    expect(res.body.baseCostFils).toBe(35_000);
  });

  it('moves a booking to a different therapist who is free', async () => {
    const created = await book();
    const res = await patch(created.body.id, { employeeId: fx.employeeIds[1] });

    expect(res.status).toBe(200);
    expect(res.body.employee?.id ?? res.body.employeeId).toBe(fx.employeeIds[1]);
  });

  it('refuses to move a treatment that has already started', async () => {
    const created = await book();
    await request(app.http)
      .post(route(`/reservations/${created.body.id}/check-in`))
      .set('Authorization', `Bearer ${reception}`)
      .set('Idempotency-Key', randomUUID())
      .send({
        actualArrivalAt: EVENING,
        basePayments: [{ method: 'CARD', amountFils: 25_000 }],
      })
      .expect(200);

    const res = await patch(created.body.id, { startsAt: LATER });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(ErrorCode.RESERVATION_NOT_SCHEDULED);
  });

  it('rejects a patch that asks for nothing', async () => {
    const created = await book();
    const res = await patch(created.body.id, {});
    expect(res.status).toBe(422);
  });

  it('records the move, and what it was before, in the audit log', async () => {
    const created = await book();
    await patch(created.body.id, { startsAt: LATER, employeeId: fx.employeeIds[1] });

    const manager = await authTokenFor(app.http, fx.users.manager.email);
    const audit = await request(app.http)
      .get(route(`/audit?entityId=${created.body.id}`))
      .set('Authorization', `Bearer ${manager}`);

    const rows = audit.body.entries as Array<{ action: string; beforeState: unknown }>;
    const move = rows.find((r) => r.action === 'RESERVATION_RESCHEDULED');
    expect(move).toBeDefined();
    // The point of the audit row is answering "what was it before?" — a row that
    // only records the new state cannot settle an argument.
    expect(move?.beforeState).toMatchObject({ employeeId: fx.employeeIds[0] });
  });
});

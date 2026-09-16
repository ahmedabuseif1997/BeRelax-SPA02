/**
 * An evening of trading, then everything that goes wrong afterwards — driven
 * through the real API against a real PostgreSQL. §9.
 *
 * Four bookings are taken, paid for and checked out. Then a tip is reversed, a
 * base payment is refunded, a discount is recorded, the month is settled into a
 * payout batch and the therapist signs for it. Every assertion is made from the
 * outside — the HTTP response, or the rows the database actually holds — because
 * the claim under test is not "the handler called create" but "the ledger lands
 * where it should and the audit trail is complete".
 *
 * The final describe re-runs §13.3's invariants over the data THIS suite made.
 * The seeded invariant suite never sees a reversal or a refund; this is where
 * corrections are proven not to break the ledger identity.
 */

import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  ErrorCode,
  PaymentMethod,
  SourceChannel,
  TipType,
  businessDay,
} from '@berelax/contracts';

import {
  authTokenFor,
  bootstrapTestApp,
  createFixtures,
  resetDatabase,
  route,
  type Fixtures,
  type TestApp,
} from './setup-e2e';

const BASE_COST_FILS = 25_000;

/**
 * The slots hang off the moment the suite runs rather than a literal date.
 *
 * Check-in stamps `payments.collected_at` with the arrival time reception gives
 * it, and §13.3's seventh invariant compares that against the audit row written
 * in the same transaction. A retro-dated arrival would put the two hours apart
 * and make this suite fail for a reason that has nothing to do with money moving
 * — so the guests here arrive when the test says they do, which is now.
 */
const SUITE_START = new Date();
const slotAt = (minutesFromNow: number): string =>
  new Date(SUITE_START.getTime() + minutesFromNow * 60_000).toISOString();

/**
 * A payout period wide enough to hold the whole run. Three trading days, because
 * a suite that starts at 05:55 Dubai puts its first booking on one trading day
 * and its last on the next — the 06:00 cutover is real and the test respects it
 * rather than pretending office hours. §3.3.
 */
const PERIOD = {
  periodStart: shiftDay(businessDay(SUITE_START), -1),
  periodEnd: shiftDay(businessDay(SUITE_START), +1),
};

function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

let ctx: TestApp;
let fixtures: Fixtures;
let managerToken: string;
let receptionToken: string;
let therapistToken: string;
let guestSeq = 0;

interface Booking {
  id: string;
  ref: string;
  basePaymentId: string;
}

const bookings: Record<'collected' | 'reversed' | 'directCash' | 'commission', Booking> =
  {} as never;

const nextGuestPhone = (): string => `+97150${String(2_000_000 + guestSeq++).slice(-7)}`;

function as(token: string, req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${token}`).set('Idempotency-Key', randomUUID());
}

/** Collapses a response to the pair worth printing when an expectation fails. */
function outcome(res: request.Response): { status: number; code?: string } {
  const code = (res.body as { error?: { code?: string } } | undefined)?.error?.code;
  return code ? { status: res.status, code } : { status: res.status };
}

/**
 * One guest, start to finish: booked, arrived, paid, treated, checked out.
 * Reception does all of it — no manager is involved in taking money. §6.4.
 */
async function trade(options: {
  employeeId: string;
  roomId: string;
  startsAt: string;
  tip?: { amountFils: number; type: TipType; method?: PaymentMethod };
}): Promise<Booking> {
  const created = await as(
    receptionToken,
    request(ctx.http).post(route('/reservations')),
  ).send({
    employeeId: options.employeeId,
    roomId: options.roomId,
    serviceId: fixtures.serviceId,
    startsAt: options.startsAt,
    sourceChannel: SourceChannel.PHONE,
    guestName: `Guest ${guestSeq}`,
    guestPhone: nextGuestPhone(),
  });
  expect(outcome(created)).toEqual({ status: 201 });

  const id = created.body.id as string;
  const checkedIn = await as(
    receptionToken,
    request(ctx.http).post(route(`/reservations/${id}/check-in`)),
  ).send({
    // No `actualArrivalAt`: the guest is arriving now, so the payment's
    // `collected_at` and the audit row written beside it share an instant.
    // See SUITE_START above.
    basePayments: [{ method: PaymentMethod.CARD, amountFils: BASE_COST_FILS }],
  });
  expect(outcome(checkedIn)).toEqual({ status: 200 });

  const checkedOut = await as(
    receptionToken,
    request(ctx.http).post(route(`/reservations/${id}/checkout`)),
  ).send({ tip: options.tip ?? null });
  expect(outcome(checkedOut)).toEqual({ status: 200 });

  return {
    id,
    ref: created.body.ref as string,
    basePaymentId: checkedIn.body.payments[0].id as string,
  };
}

/** The tip row a booking produced, read straight from the table. */
async function tipOf(reservationId: string) {
  return ctx.prisma.tip.findFirstOrThrow({
    where: { reservationId, amountFils: { gt: 0 } },
  });
}

function ledgerOf(employeeId: string) {
  return ctx.prisma.therapistPayoutLedger.findMany({
    where: { employeeId },
    orderBy: { createdAt: 'asc' },
  });
}

/** Every statement below is a static literal — nothing interpolates input. */
function query<T>(sql: string): Promise<T[]> {
  return ctx.prisma.$queryRawUnsafe<T[]>(sql);
}

beforeAll(async () => {
  ctx = await bootstrapTestApp();
  await resetDatabase();
  fixtures = await createFixtures(ctx.prisma);

  managerToken = await authTokenFor(ctx.http, fixtures.users.manager.email);
  receptionToken = await authTokenFor(ctx.http, fixtures.users.receptionist.email);
  therapistToken = await authTokenFor(ctx.http, fixtures.users.therapist.email);

  const [therapistA, therapistB] = fixtures.employeeIds;
  const [roomA, roomB] = fixtures.roomIds;

  // Therapist A is the one the THERAPIST login belongs to, so the payout at the
  // end of this file is a payout that therapist can sign for themselves.
  bookings.collected = await trade({
    employeeId: therapistA,
    roomId: roomA,
    startsAt: slotAt(5),
    tip: { amountFils: 5_000, type: TipType.COLLECTED_BY_BUSINESS, method: PaymentMethod.CARD },
  });
  bookings.reversed = await trade({
    employeeId: therapistA,
    roomId: roomA,
    startsAt: slotAt(95),
    tip: { amountFils: 3_000, type: TipType.COLLECTED_BY_BUSINESS, method: PaymentMethod.CASH },
  });
  bookings.directCash = await trade({
    employeeId: therapistA,
    roomId: roomA,
    startsAt: slotAt(185),
    tip: { amountFils: 4_000, type: TipType.DIRECT_CASH },
  });
  // Therapist B is on 10 % commission, so this one accrues without any tip.
  bookings.commission = await trade({
    employeeId: therapistB,
    roomId: roomB,
    startsAt: slotAt(5),
  });
}, 120_000);

afterAll(async () => {
  await ctx.app.close();
});

describe('reversing a tip the business collected (§9.4)', () => {
  it('refuses reception, because a tip reversal is a manager decision', async () => {
    const tip = await tipOf(bookings.reversed.id);

    const res = await as(receptionToken, request(ctx.http).post(route(`/tips/${tip.id}/reverse`)))
      .send({ reason: 'Guest complained' });

    expect(outcome(res)).toEqual({ status: 403, code: ErrorCode.INSUFFICIENT_ROLE });
  });

  it('writes a mirror row, a refund and a REVERSAL entry — and edits nothing', async () => {
    const tip = await tipOf(bookings.reversed.id);

    const res = await as(managerToken, request(ctx.http).post(route(`/tips/${tip.id}/reverse`)))
      .send({ reason: 'Reception typed 30 where the guest gave 3' });
    expect(outcome(res)).toEqual({ status: 201 });

    const rows = await ctx.prisma.tip.findMany({
      where: { reservationId: bookings.reversed.id },
      orderBy: { amountFils: 'desc' },
    });
    expect(rows.map((r) => r.amountFils)).toEqual([3_000, -3_000]);

    const [original, mirror] = rows;
    // The original is untouched apart from the pointer to its correction — same
    // amount, same timestamp, same author. The mistake stays readable.
    expect(original!.amountFils).toBe(3_000);
    expect(original!.reversedByTipId).toBe(mirror!.id);
    expect(original!.recordedAt).toEqual(tip.recordedAt);
    // Both halves carry the link, so every `reversed_by_tip_id IS NULL` report
    // drops the pair together rather than keeping the negative half. §9.2.
    expect(mirror!.reversedByTipId).toBe(original!.id);

    const refund = await ctx.prisma.payment.findFirstOrThrow({
      where: { reservationId: bookings.reversed.id, kind: 'REFUND' },
    });
    expect(refund.amountFils).toBe(-3_000);
    expect(refund.reversesPaymentId).toBe(original!.paymentId);

    const entries = await ctx.prisma.therapistPayoutLedger.findMany({
      where: { reservationId: bookings.reversed.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(entries.map((e) => [e.entryType, e.amountFils])).toEqual([
      ['TIP_ACCRUAL', 3_000],
      ['REVERSAL', -3_000],
    ]);
    expect(entries[1]!.reversesEntryId).toBe(entries[0]!.id);
    expect(entries[1]!.tipId).toBe(mirror!.id);
  });

  it('leaves the balance exactly where the arithmetic says it should be', async () => {
    const res = await request(ctx.http)
      .get(route(`/ledger/${fixtures.employeeIds[0]}/balance`))
      .set('Authorization', `Bearer ${managerToken}`);

    // 5 000 collected + 3 000 collected − 3 000 reversed. The DIRECT_CASH tip is
    // not in here at all, and that is the whole point of §9.2.
    expect(outcome(res)).toEqual({ status: 200 });
    expect(res.body.balanceFils).toBe(5_000);
    expect(res.body.unbatchedFils).toBe(5_000);
    expect(res.body.entryCount).toBe(3);
  });

  it('409s a second reversal of the same tip', async () => {
    const tip = await tipOf(bookings.reversed.id);

    const res = await as(managerToken, request(ctx.http).post(route(`/tips/${tip.id}/reverse`)))
      .send({ reason: 'Trying again' });

    expect(outcome(res)).toEqual({ status: 409, code: ErrorCode.TIP_ALREADY_REVERSED });
  });

  it('records no liability for cash handed straight to the therapist', async () => {
    const tip = await tipOf(bookings.directCash.id);

    const res = await as(managerToken, request(ctx.http).post(route(`/tips/${tip.id}/reverse`)))
      .send({ reason: 'Guest asked for it back at the door' });
    expect(outcome(res)).toEqual({ status: 201 });
    expect(res.body.refundPaymentId).toBeNull();
    expect(res.body.reversalEntryId).toBeNull();

    // The business never held this money: nothing to send back, nothing to cancel.
    await expect(
      ctx.prisma.payment.count({ where: { reservationId: bookings.directCash.id, kind: 'REFUND' } }),
    ).resolves.toBe(0);
    await expect(
      ctx.prisma.therapistPayoutLedger.count({
        where: { reservationId: bookings.directCash.id },
      }),
    ).resolves.toBe(0);
    // …and the balance has not moved.
    expect(res.body.balanceAfterFils).toBe(5_000);
  });
});

describe('refunds and adjustments', () => {
  it('refuses reception outright', async () => {
    const res = await as(
      receptionToken,
      request(ctx.http).post(route(`/payments/${bookings.commission.basePaymentId}/refund`)),
    ).send({ reason: 'Guest asked' });

    expect(outcome(res)).toEqual({ status: 403, code: ErrorCode.INSUFFICIENT_ROLE });
  });

  it('refunds part of a payment without touching the original row', async () => {
    const before = await ctx.prisma.payment.findUniqueOrThrow({
      where: { id: bookings.commission.basePaymentId },
    });

    const res = await as(
      managerToken,
      request(ctx.http).post(route(`/payments/${bookings.commission.basePaymentId}/refund`)),
    ).send({ amountFils: 10_000, reason: 'Therapist was 20 minutes late' });

    expect(outcome(res)).toEqual({ status: 201 });
    expect(res.body.refund.amountFils).toBe(-10_000);
    expect(res.body.original.refundableFils).toBe(15_000);

    const after = await ctx.prisma.payment.findUniqueOrThrow({
      where: { id: bookings.commission.basePaymentId },
    });
    expect(after).toEqual(before);
  });

  it('422s a refund larger than what is left', async () => {
    const res = await as(
      managerToken,
      request(ctx.http).post(route(`/payments/${bookings.commission.basePaymentId}/refund`)),
    ).send({ amountFils: 20_000, reason: 'Trying it on' });

    expect(outcome(res)).toEqual({ status: 422, code: ErrorCode.REFUND_EXCEEDS_PAYMENT });
    expect(res.body.error.details).toMatchObject({ refundableFils: 15_000 });
  });

  it('refunds the remainder when no amount is named, then 409s the next attempt', async () => {
    const remainder = await as(
      managerToken,
      request(ctx.http).post(route(`/payments/${bookings.commission.basePaymentId}/refund`)),
    ).send({ reason: 'Manager comped the rest of the treatment' });

    expect(outcome(remainder)).toEqual({ status: 201 });
    expect(remainder.body.refund.amountFils).toBe(-15_000);
    expect(remainder.body.reservation.netCollectedFils).toBe(0);

    const again = await as(
      managerToken,
      request(ctx.http).post(route(`/payments/${bookings.commission.basePaymentId}/refund`)),
    ).send({ reason: 'And again' });

    expect(outcome(again)).toEqual({ status: 409, code: ErrorCode.PAYMENT_ALREADY_REFUNDED });
  });

  it('replays a repeated refund instead of paying it twice', async () => {
    const key = randomUUID();
    const send = () =>
      request(ctx.http)
        .post(route(`/payments/${bookings.collected.basePaymentId}/refund`))
        .set('Authorization', `Bearer ${managerToken}`)
        .set('Idempotency-Key', key)
        .send({ amountFils: 1_000, reason: 'Patchy wifi at the desk' });

    const first = await send();
    const second = await send();

    expect(outcome(first)).toEqual({ status: 201 });
    expect(second.body).toEqual(first.body);
    await expect(
      ctx.prisma.payment.count({
        where: { reversesPaymentId: bookings.collected.basePaymentId },
      }),
    ).resolves.toBe(1);
  });

  it('records a discount as a signed ADJUSTMENT with a reason', async () => {
    const res = await as(managerToken, request(ctx.http).post(route('/payments/adjustments'))).send({
      reservationId: bookings.collected.id,
      amountFils: -2_000,
      method: PaymentMethod.CASH,
      reason: 'Goodwill after the room was cold',
    });

    expect(outcome(res)).toEqual({ status: 201 });
    expect(res.body.adjustment).toMatchObject({ kind: 'ADJUSTMENT', amountFils: -2_000 });

    const row = await ctx.prisma.payment.findFirstOrThrow({
      where: { reservationId: bookings.collected.id, kind: 'ADJUSTMENT' },
    });
    expect(row.note).toBe('Goodwill after the room was cold');
  });

  it('422s an adjustment of nothing', async () => {
    const res = await as(managerToken, request(ctx.http).post(route('/payments/adjustments'))).send({
      reservationId: bookings.collected.id,
      amountFils: 0,
      method: PaymentMethod.CASH,
      reason: 'Mis-keyed',
    });

    expect(outcome(res)).toEqual({ status: 422, code: ErrorCode.INVALID_AMOUNT });
  });
});

describe('the payout batch (§9.5)', () => {
  it('422s a batch with nothing outstanding in it', async () => {
    const res = await as(managerToken, request(ctx.http).post(route('/payouts'))).send({
      employeeId: fixtures.employeeIds[0],
      periodStart: '2020-01-01',
      periodEnd: '2020-01-31',
      method: PaymentMethod.CASH,
    });

    expect(outcome(res)).toEqual({ status: 422, code: ErrorCode.PAYOUT_NOT_POSITIVE });
  });

  it('settles every unbatched entry and brings the balance to zero', async () => {
    const res = await as(managerToken, request(ctx.http).post(route('/payouts'))).send({
      employeeId: fixtures.employeeIds[0],
      ...PERIOD,
      method: PaymentMethod.CASH,
      note: 'September settlement',
    });

    expect(outcome(res)).toEqual({ status: 201 });
    // 5 000 + 3 000 − 3 000. The reversal is settled alongside the accrual it
    // cancels, which is why the batch is 5 000 and not 8 000.
    expect(res.body.totalFils).toBe(5_000);
    expect(res.body.entryIds).toHaveLength(3);
    expect(res.body.balanceAfterFils).toBe(0);
    expect(res.body.unbatchedFils).toBe(0);

    const entries = await ledgerOf(fixtures.employeeIds[0]);
    expect(entries).toHaveLength(4);
    // Every accrual now carries the batch, and the PAYOUT entry closes it out.
    expect(entries.every((e) => e.payoutBatchId === res.body.id)).toBe(true);
    const payout = entries.find((e) => e.entryType === 'PAYOUT')!;
    expect(payout.amountFils).toBe(-5_000);
    expect(entries.reduce((sum, e) => sum + e.amountFils, 0)).toBe(0);

    const batch = await ctx.prisma.payoutBatch.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(batch.totalFils).toBe(5_000);
    expect(batch.acknowledgedAt).toBeNull();
    expect(batch.approvedByUserId).toBe(fixtures.users.manager.id);
  });

  it('names every settled entry id in the audit row', async () => {
    const batch = await ctx.prisma.payoutBatch.findFirstOrThrow({
      where: { employeeId: fixtures.employeeIds[0] },
    });
    const audit = await ctx.prisma.financialAuditLog.findFirstOrThrow({
      where: { action: 'PAYOUT_CREATED', entityId: batch.id },
    });

    const after = audit.afterState as { entryIds: string[]; entryCount: number };
    const settled = await ctx.prisma.therapistPayoutLedger.findMany({
      where: { payoutBatchId: batch.id, entryType: { not: 'PAYOUT' } },
      select: { id: true },
    });
    expect(after.entryCount).toBe(3);
    expect([...after.entryIds].sort()).toEqual(settled.map((e) => e.id).sort());
    expect(audit.amountFils).toBe(5_000);
    expect(audit.entityType).toBe('PayoutBatch');
  });

  it('finds nothing left to settle on a second run of the same period', async () => {
    const res = await as(managerToken, request(ctx.http).post(route('/payouts'))).send({
      employeeId: fixtures.employeeIds[0],
      ...PERIOD,
      method: PaymentMethod.CASH,
    });

    expect(outcome(res)).toEqual({ status: 422, code: ErrorCode.PAYOUT_NOT_POSITIVE });
  });

  it('refuses to reverse a tip that has already gone out in a batch', async () => {
    const tip = await tipOf(bookings.collected.id);

    const res = await as(managerToken, request(ctx.http).post(route(`/tips/${tip.id}/reverse`)))
      .send({ reason: 'Guest disputed it a week later' });

    // A clawback is a human conversation, not a silent write. §9.4.
    expect(outcome(res)).toEqual({ status: 409, code: ErrorCode.TIP_ALREADY_PAID_OUT });
    expect(res.body.error.message).toContain('manual adjustment');
    await expect(ctx.prisma.tip.count({ where: { reservationId: bookings.collected.id } })).resolves.toBe(1);
  });
});

describe('acknowledgement is the therapist’s own signature (§9.5)', () => {
  const batchId = async () =>
    (
      await ctx.prisma.payoutBatch.findFirstOrThrow({
        where: { employeeId: fixtures.employeeIds[0] },
      })
    ).id;

  it('refuses the manager who approved it', async () => {
    const res = await request(ctx.http)
      .post(route(`/payouts/${await batchId()}/acknowledge`))
      .set('Authorization', `Bearer ${managerToken}`);

    // A receipt signed by the person who paid it is not a receipt.
    expect(outcome(res)).toEqual({ status: 403, code: ErrorCode.INSUFFICIENT_ROLE });
  });

  it('records the signature when the therapist confirms from their own login', async () => {
    const id = await batchId();
    const res = await request(ctx.http)
      .post(route(`/payouts/${id}/acknowledge`))
      .set('Authorization', `Bearer ${therapistToken}`);

    expect(outcome(res)).toEqual({ status: 200 });
    expect(res.body.acknowledgedAt).not.toBeNull();
    expect(res.body.entryIds).toHaveLength(3);

    const batch = await ctx.prisma.payoutBatch.findUniqueOrThrow({ where: { id } });
    expect(batch.acknowledgedAt).toBeInstanceOf(Date);
    await expect(
      ctx.prisma.financialAuditLog.count({
        where: { action: 'PAYOUT_ACKNOWLEDGED', entityId: id },
      }),
    ).resolves.toBe(1);
  });

  it('409s a second confirmation', async () => {
    const res = await request(ctx.http)
      .post(route(`/payouts/${await batchId()}/acknowledge`))
      .set('Authorization', `Bearer ${therapistToken}`);

    expect(outcome(res)).toEqual({ status: 409, code: ErrorCode.PAYOUT_ALREADY_ACKNOWLEDGED });
  });
});

describe('what the therapist sees (§9.2)', () => {
  it('keeps cash in hand and money owed as two labelled figures', async () => {
    const res = await request(ctx.http)
      .get(route(`/employees/${fixtures.employeeIds[0]}/earnings?from=${PERIOD.periodStart}&to=${PERIOD.periodEnd}`))
      .set('Authorization', `Bearer ${therapistToken}`);

    expect(outcome(res)).toEqual({ status: 200 });
    // The 4 000 direct-cash tip was reversed, so both halves drop out together
    // and the line reads zero rather than minus four thousand.
    expect(res.body.cashReceivedDirectly).toMatchObject({ tipCount: 0, totalFils: 0 });
    expect(res.body.cashReceivedDirectly.label).toMatch(/therapist is already holding/i);
    expect(res.body.heldByBusinessAndPayable).toMatchObject({
      tipsCollected: { tipCount: 1, totalFils: 5_000 },
      reversalsFils: -3_000,
      paidOutInPeriodFils: 5_000,
      balanceNowFils: 0,
      unbatchedFils: 0,
    });
    expect(res.body.explanation).toContain('pays a tip twice');
  });

  it('includes commission accruals for a therapist who is on commission', async () => {
    const res = await request(ctx.http)
      .get(route(`/employees/${fixtures.employeeIds[1]}/earnings?from=${PERIOD.periodStart}&to=${PERIOD.periodEnd}`))
      .set('Authorization', `Bearer ${managerToken}`);

    expect(outcome(res)).toEqual({ status: 200 });
    // 10 % of a 250 AED treatment, accrued at check-in. §8.2.
    expect(res.body.heldByBusinessAndPayable).toMatchObject({
      commissionAccruedFils: 2_500,
      accruedInPeriodFils: 2_500,
      balanceNowFils: 2_500,
    });
    expect(res.body.totalEarnedInPeriodFils).toBe(2_500);
  });

  it('403s a therapist reading a colleague’s ledger or earnings', async () => {
    const other = fixtures.employeeIds[1];

    for (const path of [`/ledger/${other}`, `/ledger/${other}/balance`, `/employees/${other}/earnings`]) {
      const res = await request(ctx.http)
        .get(route(path))
        .set('Authorization', `Bearer ${therapistToken}`);
      expect(outcome(res)).toEqual({ status: 403, code: ErrorCode.INSUFFICIENT_ROLE });
    }
  });

  it('answers the dispute in one call: every line, its booking and its batch', async () => {
    const res = await request(ctx.http)
      .get(route(`/ledger/${fixtures.employeeIds[0]}?from=${PERIOD.periodStart}&to=${PERIOD.periodEnd}`))
      .set('Authorization', `Bearer ${therapistToken}`);

    expect(outcome(res)).toEqual({ status: 200 });
    expect(res.body.balanceFils).toBe(0);
    expect(res.body.entries).toHaveLength(4);

    const accrual = res.body.entries.find((e: { entryType: string }) => e.entryType === 'TIP_ACCRUAL');
    expect(accrual).toMatchObject({
      amountFils: 5_000,
      reservationRef: bookings.collected.ref,
      tipType: 'COLLECTED_BY_BUSINESS',
      recordedBy: fixtures.users.receptionist.email,
    });
    // §9.7: the batch it was paid in, and the moment the therapist signed.
    expect(accrual.paidInBatchAt).not.toBeNull();
    expect(accrual.acknowledgedAt).not.toBeNull();
  });
});

describe('the audit trail (§9.6, §9.7)', () => {
  it('refuses reception, who takes the money but never audits it', async () => {
    const res = await request(ctx.http)
      .get(route('/audit'))
      .set('Authorization', `Bearer ${receptionToken}`);

    expect(outcome(res)).toEqual({ status: 403, code: ErrorCode.INSUFFICIENT_ROLE });
  });

  it('gives a manager the whole story of one booking, newest first', async () => {
    const res = await request(ctx.http)
      .get(route(`/audit?entityId=${bookings.reversed.id}`))
      .set('Authorization', `Bearer ${managerToken}`);

    expect(outcome(res)).toEqual({ status: 200 });
    const actions = res.body.entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual([
      'TIP_REVERSED',
      'RESERVATION_CHECKOUT',
      'RESERVATION_CHECK_IN',
      'RESERVATION_CREATED',
    ]);

    const reversal = res.body.entries[0];
    expect(reversal.amountFils).toBe(-3_000);
    expect(reversal.actor).toMatchObject({ id: fixtures.users.manager.id, role: 'MANAGER' });
    expect(reversal.afterState).toMatchObject({
      reason: 'Reception typed 30 where the guest gave 3',
    });
    expect(reversal.requestId).toMatch(/^req_/);
  });

  it('filters by action and by who did it', async () => {
    const byAction = await request(ctx.http)
      .get(route('/audit?action=PAYMENT_REFUNDED'))
      .set('Authorization', `Bearer ${managerToken}`);
    expect(byAction.body.total).toBe(3);

    const byActor = await request(ctx.http)
      .get(route(`/audit?actorUserId=${fixtures.users.therapist.id}`))
      .set('Authorization', `Bearer ${managerToken}`);
    // Everything that login did, newest first: they signed in, then they signed
    // for their money. Nothing else in this system was touched by that account.
    expect(byActor.body.entries.map((e: { action: string }) => e.action)).toEqual([
      'PAYOUT_ACKNOWLEDGED',
      'AUTH_LOGIN_SUCCEEDED',
    ]);
  });

  it('narrows to a trading day', async () => {
    const res = await request(ctx.http)
      .get(route(`/audit?from=${PERIOD.periodStart}&to=${PERIOD.periodEnd}&limit=200`))
      .set('Authorization', `Bearer ${managerToken}`);

    expect(res.body.entries.length).toBeGreaterThan(10);
    expect(res.body.entries.length).toBeLessThanOrEqual(res.body.total);
  });
});

/**
 * §13.3 over the data this suite produced. The seeded invariant suite proves
 * these hold for ordinary trading; this proves corrections do not break them.
 */
describe('the financial invariants survive a reversal and a payout (§13.3)', () => {
  it('1. every ledger balance still equals collected tips + commissions − payouts', async () => {
    // Verbatim from financial-invariants.e2e-spec.ts. This is the one a reversal
    // is most likely to break: the pair of tip rows must leave the earnings side
    // together, or the identity moves by twice the tip.
    const offenders = await query(`
      SELECT e.display_name AS employee, b.*,
             b.ledger_sum - (b.tips_collected + b.commissions - b.payouts) AS delta_fils
        FROM employees e
        CROSS JOIN LATERAL (
          SELECT
            (SELECT COALESCE(SUM(amount_fils), 0)::int FROM therapist_payout_ledger
              WHERE employee_id = e.id)                                       AS ledger_sum,
            (SELECT COALESCE(SUM(amount_fils), 0)::int FROM tips
              WHERE employee_id = e.id AND type = 'COLLECTED_BY_BUSINESS'
                AND reversed_by_tip_id IS NULL)                               AS tips_collected,
            (SELECT COALESCE(SUM(amount_fils), 0)::int FROM therapist_payout_ledger
              WHERE employee_id = e.id AND entry_type = 'COMMISSION_ACCRUAL') AS commissions,
            (SELECT COALESCE(SUM(-amount_fils), 0)::int FROM therapist_payout_ledger
              WHERE employee_id = e.id AND entry_type = 'PAYOUT')             AS payouts
        ) b
       WHERE b.ledger_sum <> b.tips_collected + b.commissions - b.payouts`);

    expect(offenders).toEqual([]);
  });

  it('2. still no ledger entry for any DIRECT_CASH tip, reversed or not', async () => {
    const accrued = await query(`
      SELECT l.id, l.entry_type, l.amount_fils
        FROM therapist_payout_ledger l
        JOIN tips t ON t.id = l.tip_id
       WHERE t.type = 'DIRECT_CASH'`);
    expect(accrued).toEqual([]);

    const leaked = await query(`
      SELECT id, amount_fils, method, payment_id FROM tips
       WHERE type = 'DIRECT_CASH' AND (payment_id IS NOT NULL OR method IS NOT NULL)`);
    expect(leaked).toEqual([]);
  });

  it('3. every LIVE collected tip still has one payment and one accrual', async () => {
    // Invariant 3 as shipped has no `reversed_by_tip_id IS NULL` filter, and a
    // §9.4 mirror row cannot satisfy it: it is a COLLECTED_BY_BUSINESS row whose
    // money went back out as a REFUND (not a TIP payment) and whose ledger entry
    // is a REVERSAL (not a TIP_ACCRUAL). Restricted to tips that are still live —
    // which is what the invariant is about — it holds exactly.
    const malformed = await query(`
      SELECT t.id AS tip_id, t.amount_fils
        FROM tips t
       WHERE t.type = 'COLLECTED_BY_BUSINESS'
         AND t.reversed_by_tip_id IS NULL
         AND ( (SELECT count(*) FROM payments p
                 WHERE p.id = t.payment_id AND p.kind = 'TIP'
                   AND p.amount_fils = t.amount_fils) <> 1
            OR (SELECT count(*) FROM therapist_payout_ledger l
                 WHERE l.tip_id = t.id AND l.entry_type = 'TIP_ACCRUAL'
                   AND l.amount_fils = t.amount_fils) <> 1 )`);
    expect(malformed).toEqual([]);

    // And the rows the shipped query WOULD flag are exactly the reversal pair —
    // nothing else. If a future change makes it flag anything more, this fails.
    const flagged = await query(`
      SELECT t.id, t.amount_fils, t.reversed_by_tip_id IS NOT NULL AS is_reversed
        FROM tips t
       WHERE t.type = 'COLLECTED_BY_BUSINESS'
         AND ( (SELECT count(*) FROM payments p
                 WHERE p.id = t.payment_id AND p.kind = 'TIP'
                   AND p.amount_fils = t.amount_fils) <> 1
            OR (SELECT count(*) FROM therapist_payout_ledger l
                 WHERE l.tip_id = t.id AND l.entry_type = 'TIP_ACCRUAL'
                   AND l.amount_fils = t.amount_fils) <> 1 )`);
    expect(flagged).toEqual([
      { id: expect.any(String), amount_fils: -3_000, is_reversed: true },
    ]);
  });

  it('4. every COMPLETED booking is paid for exactly, except where money was sent back', async () => {
    // The shipped query sums `kind IN ('BASE','REFUND')`, so ANY refund on a
    // completed booking moves it — including the REFUND row §9.4 requires when a
    // collected tip is reversed, which is tip money rather than base money. The
    // bookings this suite deliberately refunded are therefore expected here, and
    // no others; a booking that was only ADJUSTed stays balanced, which is why
    // §8.2 records a discount as an adjustment rather than a refund.
    const unbalanced = await query<{
      reservation: string;
      base_cost_fils: number;
      collected_net_fils: number;
    }>(`
      SELECT r.ref AS reservation, r.base_cost_fils,
             COALESCE(SUM(p.amount_fils) FILTER (WHERE p.kind IN ('BASE','REFUND')), 0)::int AS collected_net_fils
        FROM reservations r
        LEFT JOIN payments p ON p.reservation_id = r.id
       WHERE r.status = 'COMPLETED'
       GROUP BY r.id, r.ref, r.base_cost_fils
      HAVING r.base_cost_fils
             <> COALESCE(SUM(p.amount_fils) FILTER (WHERE p.kind IN ('BASE','REFUND')), 0)
       ORDER BY r.ref`);

    expect(unbalanced).toEqual(
      [
        // Base refunded in full by a manager.
        { reservation: bookings.commission.ref, base_cost_fils: 25_000, collected_net_fils: 0 },
        // 1 000 refunded against the base, and the discount recorded as an
        // ADJUSTMENT — which the bucket correctly ignores.
        { reservation: bookings.collected.ref, base_cost_fils: 25_000, collected_net_fils: 24_000 },
        // The tip reversal's REFUND row. No base money moved on this booking.
        { reservation: bookings.reversed.ref, base_cost_fils: 25_000, collected_net_fils: 22_000 },
      ].sort((a, b) => a.reservation.localeCompare(b.reservation)),
    );

    // Nothing else moved: the booking with only a DIRECT_CASH reversal is exact.
    expect(unbalanced.map((r) => r.reservation)).not.toContain(
      bookings.directCash.ref,
    );
  });

  it('5. no COMPLETED booking without a completion time, none IN_PROGRESS without an arrival', async () => {
    const incoherent = await query(`
      SELECT ref, status FROM reservations
       WHERE (status = 'COMPLETED'   AND completed_at      IS NULL)
          OR (status = 'COMPLETED'   AND actual_arrival_at IS NULL)
          OR (status = 'IN_PROGRESS' AND actual_arrival_at IS NULL)
          OR (status = 'COMPLETED'   AND completed_at < actual_arrival_at)`);
    expect(incoherent).toEqual([]);
  });

  it('7. every payment, tip and ledger entry has an audit row within one second', async () => {
    // The anchor rule of §9.6: payments, tips and accruals are audited against
    // the booking the money hangs off; a payout against its batch. The rows this
    // suite created — mirror tips, refunds, reversal entries, the payout — all
    // have to satisfy it too, which is why the reversal audits the RESERVATION.
    const unaudited = await query(`
      WITH money AS (
        SELECT 'payments' AS source, p.id, p.branch_id, p.reservation_id AS anchor_id,
               p.collected_at AS written_at FROM payments p
        UNION ALL
        SELECT 'tips', t.id, t.branch_id, t.reservation_id, t.recorded_at FROM tips t
        UNION ALL
        SELECT 'therapist_payout_ledger', l.id, l.branch_id,
               COALESCE(l.reservation_id, l.payout_batch_id, l.id), l.created_at
          FROM therapist_payout_ledger l
      )
      SELECT m.source, m.id, m.written_at
        FROM money m
       WHERE NOT EXISTS (
         SELECT 1 FROM financial_audit_log a
          WHERE a.branch_id = m.branch_id
            AND a.entity_id = m.anchor_id
            AND a.created_at BETWEEN m.written_at - interval '1 second'
                                 AND m.written_at + interval '1 second')
       ORDER BY m.written_at`);

    expect(unaudited).toEqual([]);
  });

  it('the append-only guards are still the last word', async () => {
    const [payment] = await ctx.prisma.payment.findMany({ take: 1 });
    const [entry] = await ctx.prisma.therapistPayoutLedger.findMany({ take: 1 });

    // Not a theoretical guarantee: the database refuses, whatever the API does.
    await expect(
      ctx.prisma.payment.update({ where: { id: payment!.id }, data: { amountFils: 1 } }),
    ).rejects.toThrow(/append-only/);
    await expect(
      ctx.prisma.therapistPayoutLedger.update({
        where: { id: entry!.id },
        data: { amountFils: 1 },
      }),
    ).rejects.toThrow(/immutable/);
    await expect(
      ctx.prisma.financialAuditLog.deleteMany({ where: { action: 'TIP_REVERSED' } }),
    ).rejects.toThrow(/append-only/);
  });
});

/**
 * The parallel pilot, driven through the real API against a real PostgreSQL.
 * §14, Phase 7.
 *
 * A night is traded for real — three guests booked, checked in, paid for and
 * checked out, cash and card, both tip modes — and then reconciled BOTH WAYS:
 * once against figures taken from the database, which must match, and once
 * against figures that are deliberately wrong, which must not.
 *
 * Three claims are worth more than every other assertion in this file:
 *
 *  1. **The paper figures come from SQL, never from the sheet.** Submitting the
 *     endpoint's own answer back to it would prove only that a number equals
 *     itself. Every figure reconciled below is summed independently, with the
 *     same filters §13.3's invariants use, and the sheet is then asserted to
 *     agree with it.
 *  2. **The streak counts and resets through the real endpoint.** Five
 *     consecutive matched nights make `readyToSwitch` true; one bad submission
 *     on the most recent night takes it back to zero; the correction that
 *     follows restores it — and a night nobody reconciled stops the count dead
 *     even though the nights either side of it matched.
 *  3. **Nothing can be rewritten.** The row is append-only at the database, and
 *     a row whose verdict disagrees with its own variances cannot be inserted
 *     at all. "Five nights matched" is worth something only because nobody
 *     could have gone back and made it so.
 *
 * Reception is checked out of all four routes on the way in (§6.4): the person
 * who counted the drawer all evening does not get to sign off their own night.
 */

import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  ErrorCode,
  PaymentMethod,
  ReconciliationVerdict,
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
 * Slots hang off the moment the suite runs, inside a tight window.
 *
 * A reservation is filed to the trading day of `starts_at` and its payments to
 * the day the money changed hands, so a suite that spread its bookings over
 * four hours could straddle the 06:00 cutover and put a treatment on one night
 * with its cash on the next (§3.3). That is real behaviour, not a bug — which
 * is exactly why nothing below assumes a figure: every expectation is summed
 * from the database for the night under test.
 */
const SUITE_START = new Date();
const slotAt = (minutesFromNow: number): string =>
  new Date(SUITE_START.getTime() + minutesFromNow * 60_000).toISOString();

/** The trading night the money lands on. */
const NIGHT = businessDay(SUITE_START);

/** Four empty nights before it, for the streak, and one further back on its own. */
const shiftDay = (day: string, days: number): string =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);

const EMPTY_NIGHTS = [4, 3, 2, 1].map((back) => shiftDay(NIGHT, -back));
/** Far enough back that the streak walk never reaches it. */
const BOTH_WAYS_NIGHT = shiftDay(NIGHT, -10);
/** Reconciled with a gap in front of it, to prove a gap breaks the run. */
const BEYOND_THE_GAP_NIGHT = shiftDay(NIGHT, -6);

let ctx: TestApp;
let fixtures: Fixtures;
let tokens: Record<'owner' | 'manager' | 'reception' | 'therapist', string>;
let guestSeq = 0;

const nextGuestPhone = (): string => `+97150${String(3_000_000 + guestSeq++).slice(-7)}`;

function as(token: string, req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${token}`).set('Idempotency-Key', randomUUID());
}

function get(path: string, token: string): request.Test {
  return request(ctx.http).get(route(path)).set('Authorization', `Bearer ${token}`);
}

/** Collapses a response to the pair worth printing when an expectation fails. */
function outcome(res: request.Response): { status: number; code?: string } {
  const code = (res.body as { error?: { code?: string } } | undefined)?.error?.code;
  return code ? { status: res.status, code } : { status: res.status };
}

/** Every statement below is a static literal; nothing interpolates user input. */
function query<T>(sql: string): Promise<T[]> {
  return ctx.prisma.$queryRawUnsafe<T[]>(sql);
}

async function one<T>(sql: string): Promise<T> {
  const [row] = await query<T>(sql);
  if (!row) throw new Error(`expected a row from: ${sql}`);
  return row;
}

/* ───────────────────── the figures, summed independently ───────────────────── */

interface PaperFigures {
  countedCashFils: number;
  paperBookings: number;
  paperCardTotalFils: number;
  paperTipsCashFils: number;
}

/**
 * What reception's sheet WOULD say on a night where nothing went wrong, summed
 * straight from the tables with the same filters the money layer uses.
 *
 * This is the whole point of the file: the paper side of every comparison below
 * is computed here, not read back off the endpoint being tested.
 */
async function figuresFromDatabase(day: string): Promise<PaperFigures> {
  const branch = fixtures.branchId;

  const money = await one<{ cash: number; card: number }>(`
    SELECT COALESCE(SUM(amount_fils) FILTER (WHERE method = 'CASH'), 0)::int AS "cash",
           COALESCE(SUM(amount_fils) FILTER (WHERE method = 'CARD'), 0)::int AS "card"
      FROM payments
     WHERE branch_id = '${branch}'::uuid AND business_day = '${day}'::date`);

  const sessions = await one<{ n: number }>(`
    SELECT count(*)::int AS "n"
      FROM reservations
     WHERE branch_id = '${branch}'::uuid AND business_day = '${day}'::date
       AND status IN ('COMPLETED', 'IN_PROGRESS')`);

  // Reversed pairs out of both sides, exactly as §9.2 and every report does it.
  const tips = await one<{ direct: number }>(`
    SELECT COALESCE(SUM(amount_fils), 0)::int AS "direct"
      FROM tips
     WHERE branch_id = '${branch}'::uuid AND business_day = '${day}'::date
       AND type = 'DIRECT_CASH' AND reversed_by_tip_id IS NULL`);

  return {
    countedCashFils: money.cash,
    paperCardTotalFils: money.card,
    paperBookings: sessions.n,
    paperTipsCashFils: tips.direct,
  };
}

function reconcile(day: string, body: unknown, token = tokens.manager): request.Test {
  return as(token, request(ctx.http).post(route(`/reconciliation/${day}`))).send(body as object);
}

async function reconcileOk(day: string, body: unknown, token = tokens.manager) {
  const res = await reconcile(day, body, token);
  expect(outcome(res)).toEqual({ status: 201 });
  return res.body;
}

/** A night with nothing on it: every figure is a real, checked zero. */
const AN_EMPTY_NIGHT = { countedCashFils: 0, paperBookings: 0, paperCardTotalFils: 0 };

async function streakNow() {
  const res = await get('/reconciliation/streak', tokens.manager);
  expect(res.status).toBe(200);
  return res.body;
}

/* ───────────────────────── one real night of trading ───────────────────────── */

async function trade(options: {
  employeeId: string;
  roomId: string;
  startsAt: string;
  baseMethod: PaymentMethod;
  tip?: { amountFils: number; type: TipType; method?: PaymentMethod };
  leaveOpen?: boolean;
}): Promise<{ id: string; ref: string }> {
  const created = await as(
    tokens.reception,
    request(ctx.http).post(route('/reservations')),
  ).send({
    employeeId: options.employeeId,
    roomId: options.roomId,
    serviceId: fixtures.serviceId,
    startsAt: options.startsAt,
    sourceChannel: SourceChannel.WALK_IN,
    guestName: `Guest ${guestSeq}`,
    guestPhone: nextGuestPhone(),
  });
  expect(outcome(created)).toEqual({ status: 201 });
  const id = created.body.id as string;

  const checkedIn = await as(
    tokens.reception,
    request(ctx.http).post(route(`/reservations/${id}/check-in`)),
  ).send({ basePayments: [{ method: options.baseMethod, amountFils: BASE_COST_FILS }] });
  expect(outcome(checkedIn)).toEqual({ status: 200 });

  if (!options.leaveOpen) {
    const checkedOut = await as(
      tokens.reception,
      request(ctx.http).post(route(`/reservations/${id}/checkout`)),
    ).send({ tip: options.tip ?? null });
    expect(outcome(checkedOut)).toEqual({ status: 200 });
  }

  return { id, ref: created.body.ref as string };
}

beforeAll(async () => {
  ctx = await bootstrapTestApp();
  await resetDatabase();
  fixtures = await createFixtures(ctx.prisma);

  const [owner, manager, reception, therapist] = await Promise.all([
    authTokenFor(ctx.http, fixtures.users.owner.email),
    authTokenFor(ctx.http, fixtures.users.manager.email),
    authTokenFor(ctx.http, fixtures.users.receptionist.email),
    authTokenFor(ctx.http, fixtures.users.therapist.email),
  ]);
  tokens = { owner, manager, reception, therapist };

  const [therapistA, therapistB] = fixtures.employeeIds;
  const [roomA, roomB] = fixtures.roomIds;

  // Cash treatment with a tip added to the bill: both go into the drawer.
  await trade({
    employeeId: therapistA,
    roomId: roomA,
    startsAt: slotAt(5),
    baseMethod: PaymentMethod.CASH,
    tip: { amountFils: 5_000, type: TipType.COLLECTED_BY_BUSINESS, method: PaymentMethod.CASH },
  });
  // Card treatment with a tip on the card: both go through the terminal.
  await trade({
    employeeId: therapistB,
    roomId: roomB,
    startsAt: slotAt(5),
    baseMethod: PaymentMethod.CARD,
    tip: { amountFils: 4_000, type: TipType.COLLECTED_BY_BUSINESS, method: PaymentMethod.CARD },
  });
  // Cash treatment, tip handed straight to the therapist. §9.1: that money
  // never entered the till, so it must NOT be in the drawer figure.
  await trade({
    employeeId: therapistA,
    roomId: roomA,
    startsAt: slotAt(85),
    baseMethod: PaymentMethod.CASH,
    tip: { amountFils: 3_000, type: TipType.DIRECT_CASH },
  });
}, 180_000);

afterAll(async () => {
  await ctx?.app.close();
});

/* ─────────────────────────────── §6.4 ─────────────────────────────── */

describe('who may reconcile a night', () => {
  const ROUTES = [
    '/reconciliation/streak',
    '/reconciliation',
    `/reconciliation/${NIGHT}/sheet`,
  ];

  it.each(ROUTES)('403s a RECEPTIONIST reading %s', async (path) => {
    const res = await get(path, tokens.reception);

    expect(outcome(res)).toEqual({ status: 403, code: ErrorCode.INSUFFICIENT_ROLE });
  });

  it.each(ROUTES)('403s a THERAPIST reading %s', async (path) => {
    const res = await get(path, tokens.therapist);

    expect(outcome(res)).toEqual({ status: 403, code: ErrorCode.INSUFFICIENT_ROLE });
  });

  it('403s a RECEPTIONIST signing off their own night', async () => {
    // The whole control is that somebody else counts it. A receptionist
    // reconciling their own drawer against their own sheet is a formality.
    const res = await reconcile(NIGHT, AN_EMPTY_NIGHT, tokens.reception);

    expect(outcome(res)).toEqual({ status: 403, code: ErrorCode.INSUFFICIENT_ROLE });
  });

  it('lets the OWNER reconcile', async () => {
    const res = await reconcile(BOTH_WAYS_NIGHT, AN_EMPTY_NIGHT, tokens.owner);

    expect(outcome(res)).toEqual({ status: 201 });
  });
});

/* ─────────────────────────── the close-out sheet ─────────────────────────── */

describe('the close-out sheet', () => {
  it('agrees with the database, figure for figure', async () => {
    const expected = await figuresFromDatabase(NIGHT);
    const res = await get(`/reconciliation/${NIGHT}/sheet`, tokens.manager);

    expect(res.status).toBe(200);
    const sheet = res.body;
    expect(sheet.businessDay).toBe(NIGHT);
    expect(sheet.cash.expectedCashFils).toBe(expected.countedCashFils);
    expect(sheet.card.expectedCardFils).toBe(expected.paperCardTotalFils);
    expect(sheet.guestsSeen).toBe(expected.paperBookings);
    expect(sheet.tips.directCash.totalFils).toBe(expected.paperTipsCashFils);
  });

  it('keeps a tip handed straight over OUT of the drawer figure', async () => {
    const res = await get(`/reconciliation/${NIGHT}/sheet`, tokens.manager);
    const sheet = res.body;

    // The guest put that money into the therapist's hand. It never entered the
    // till and BE RELAX never owed it (§9.1, §9.2), so the drawer must not
    // expect it back.
    expect(sheet.tips.directCash.totalFils).toBeGreaterThan(0);
    expect(sheet.cash.expectedCashFils).toBe(
      sheet.cash.baseCashFils + sheet.cash.tipCashFils +
        sheet.cash.refundedCashFils + sheet.cash.adjustmentCashFils,
    );
    expect(sheet.tips.payableFils).toBe(sheet.tips.collectedByBusiness.totalFils);
  });

  it('splits the card terminal total the way the Z-report reads', async () => {
    const res = await get(`/reconciliation/${NIGHT}/sheet`, tokens.manager);
    const card = res.body.card;

    expect(card.expectedCardFils).toBe(
      card.baseCardFils + card.tipCardFils + card.refundedCardFils + card.adjustmentCardFils,
    );
    expect(card.baseCardFils).toBe(BASE_COST_FILS);
    expect(card.tipCardFils).toBe(4_000);
  });

  it('lists the night by therapist, including tips in both modes', async () => {
    const res = await get(`/reconciliation/${NIGHT}/sheet`, tokens.manager);
    const lines: Array<Record<string, number>> = res.body.byTherapist;

    expect(lines.length).toBeGreaterThan(0);
    const sessions = lines.reduce((total, line) => total + Number(line.sessions), 0);
    expect(sessions).toBe(res.body.guestsSeen);

    const direct = lines.reduce((total, line) => total + Number(line.tipsDirectCashFils), 0);
    const onBill = lines.reduce(
      (total, line) => total + Number(line.tipsCollectedByBusinessFils),
      0,
    );
    // The per-therapist lines are a decomposition of the night's two tip
    // totals, not a second, larger reading of them.
    expect(direct).toBe(res.body.tips.directCash.totalFils);
    expect(onBill).toBe(res.body.tips.collectedByBusiness.totalFils);
  });

  it('names who took cash at the desk, so a variance belongs to somebody', async () => {
    const res = await get(`/reconciliation/${NIGHT}/sheet`, tokens.manager);

    // §15.4. Reception took it; the manager is only signing it off.
    expect(res.body.cashDesk).toEqual([
      expect.objectContaining({
        userId: fixtures.users.receptionist.id,
        amountFils: res.body.cash.expectedCashFils,
      }),
    ]);
  });

  it('asks for the same five figures the form collects, in the same order', async () => {
    const res = await get(`/reconciliation/${NIGHT}/sheet`, tokens.manager);

    expect(res.body.toCheck.map((line: { key: string }) => line.key)).toEqual([
      'CASH',
      'CARD',
      'BOOKINGS',
      'TIPS_DIRECT_CASH',
      'OPEN_SESSIONS',
    ]);
  });

  it('refuses a businessDay that is not a trading day at all', async () => {
    const res = await get('/reconciliation/16-09-2026/sheet', tokens.manager);

    expect(outcome(res)).toEqual({ status: 422, code: ErrorCode.VALIDATION_FAILED });
  });
});

/* ────────────────────── reconciled both ways ────────────────────── */

describe('reconciling a night both ways', () => {
  it('records a MATCHED night when the paper agrees to the fil', async () => {
    const paper = await figuresFromDatabase(NIGHT);

    const result = await reconcileOk(NIGHT, paper);

    expect(result.verdict).toBe(ReconciliationVerdict.MATCHED);
    expect(result.matched).toBe(true);
    expect(result.failing).toEqual([]);
    expect(result.variance).toEqual({
      cashFils: 0,
      cardFils: 0,
      bookings: 0,
      tipsCashFils: 0,
    });
    expect(result.businessDay).toBe(NIGHT);
    expect(result.submittedByUserId).toBe(fixtures.users.manager.id);
  });

  it('is MATCHED_WITH_NOTE when the figures agree and the night needed explaining', async () => {
    const paper = await figuresFromDatabase(NIGHT);

    const result = await reconcileOk(NIGHT, {
      ...paper,
      note: 'one walk-in paid half cash half card',
    });

    expect(result.verdict).toBe(ReconciliationVerdict.MATCHED_WITH_NOTE);
    expect(result.matched).toBe(true);
    expect(result.note).toBe('one walk-in paid half cash half card');
  });

  it('records a MISMATCHED night, with the variance and the failing line', async () => {
    const paper = await figuresFromDatabase(BOTH_WAYS_NIGHT);

    // A fifty-dirham note that never reached the drawer.
    const result = await reconcileOk(BOTH_WAYS_NIGHT, {
      ...paper,
      countedCashFils: paper.countedCashFils + 5_000,
    });

    expect(result.verdict).toBe(ReconciliationVerdict.MISMATCHED);
    expect(result.matched).toBe(false);
    expect(result.variance.cashFils).toBe(5_000);
    expect(result.failing.map((line: { key: string }) => line.key)).toEqual(['CASH']);
    // A finding, not an error: 201, and the row is written.
    expect(result.id).toEqual(expect.any(String));
  });

  it('holds the card line to the fil even when the cash line is forgiven', async () => {
    const paper = await figuresFromDatabase(BOTH_WAYS_NIGHT);

    const result = await reconcileOk(BOTH_WAYS_NIGHT, {
      ...paper,
      paperCardTotalFils: paper.paperCardTotalFils + 1,
    });

    expect(result.verdict).toBe(ReconciliationVerdict.MISMATCHED);
    expect(result.failing.map((line: { key: string }) => line.key)).toEqual(['CARD']);
    expect(result.cashToleranceFils).toBe(0);
  });

  it('does not compare a tips figure nobody wrote down', async () => {
    const paper = await figuresFromDatabase(BOTH_WAYS_NIGHT);
    const { paperTipsCashFils: _omitted, ...withoutTips } = paper;

    const result = await reconcileOk(BOTH_WAYS_NIGHT, withoutTips);

    expect(result.verdict).toBe(ReconciliationVerdict.MATCHED);
    expect(result.paper.tipsCashFils).toBeNull();
    expect(result.variance.tipsCashFils).toBeNull();
  });

  it('refuses a night that has not happened yet', async () => {
    const res = await reconcile(shiftDay(NIGHT, 2), AN_EMPTY_NIGHT);

    expect(outcome(res)).toEqual({
      status: 422,
      code: ErrorCode.RECONCILIATION_DAY_IN_FUTURE,
    });
  });

  it('refuses a decimal, and never offers one', async () => {
    const res = await reconcile(BOTH_WAYS_NIGHT, { ...AN_EMPTY_NIGHT, countedCashFils: 1840.5 });

    expect(outcome(res)).toEqual({ status: 422, code: ErrorCode.VALIDATION_FAILED });
    expect(res.body.error.message).toMatch(/whole fils/);
  });

  it('writes an audit entry naming who signed the night off', async () => {
    const paper = await figuresFromDatabase(NIGHT);
    const result = await reconcileOk(NIGHT, paper);

    const entry = await ctx.prisma.financialAuditLog.findFirstOrThrow({
      where: { entityType: 'NightlyReconciliation', entityId: result.id },
    });

    expect(entry.action).toBe('RECONCILIATION_SUBMITTED');
    expect(entry.actorUserId).toBe(fixtures.users.manager.id);
    expect(entry.amountFils).toBe(0);
    expect(entry.beforeState).toBeNull();
  });

  it('attributes the night to whoever actually took the cash', async () => {
    const paper = await figuresFromDatabase(NIGHT);

    const result = await reconcileOk(NIGHT, paper);

    expect(result.cashDeskUserIds).toEqual([fixtures.users.receptionist.id]);
  });
});

/* ───────────────────────────── the streak ───────────────────────────── */

describe('the streak — the only question the pilot asks', () => {
  it('counts the nights already reconciled and is not ready yet', async () => {
    const streak = await streakNow();

    // Only NIGHT and BOTH_WAYS_NIGHT have been reconciled so far, and the walk
    // back from NIGHT hits the un-reconciled night before it immediately.
    expect(streak.lastReconciledNight).toBe(NIGHT);
    expect(streak.consecutiveMatchedNights).toBe(1);
    expect(streak.readyToSwitch).toBe(false);
    expect(streak.brokenBy).toEqual({
      businessDay: shiftDay(NIGHT, -1),
      reason: 'NOT_RECONCILED',
    });
  });

  it('reaches five and says the pilot is ready to switch', async () => {
    for (const night of EMPTY_NIGHTS) {
      const result = await reconcileOk(night, AN_EMPTY_NIGHT);
      expect(result.verdict).toBe(ReconciliationVerdict.MATCHED);
    }

    const streak = await streakNow();

    expect(streak.consecutiveMatchedNights).toBe(5);
    expect(streak.requiredNights).toBe(5);
    expect(streak.readyToSwitch).toBe(true);
    expect(streak.nights.map((night: { businessDay: string }) => night.businessDay)).toEqual([
      NIGHT,
      ...EMPTY_NIGHTS.slice().reverse(),
    ]);
  });

  it('resets to zero the moment a night stops matching', async () => {
    const paper = await figuresFromDatabase(NIGHT);

    // The same night, reconciled again against a drawer that is short. This is
    // a CORRECTION — a new row — and it is now the night's effective verdict.
    const result = await reconcileOk(NIGHT, {
      ...paper,
      countedCashFils: paper.countedCashFils - 10_000,
    });
    expect(result.verdict).toBe(ReconciliationVerdict.MISMATCHED);

    const streak = await streakNow();

    // Four good nights behind it count for nothing: the run is measured from
    // the most recent night, and the most recent night did not match.
    expect(streak.consecutiveMatchedNights).toBe(0);
    expect(streak.readyToSwitch).toBe(false);
    expect(streak.brokenBy).toEqual({ businessDay: NIGHT, reason: 'MISMATCHED' });
  });

  it('restores the run when the night is put right', async () => {
    const paper = await figuresFromDatabase(NIGHT);

    const result = await reconcileOk(NIGHT, { ...paper, note: 'found the missing cash slip' });

    expect(result.verdict).toBe(ReconciliationVerdict.MATCHED_WITH_NOTE);
    expect(result.supersedesId).toEqual(expect.any(String));
    expect((await streakNow()).consecutiveMatchedNights).toBe(5);
    expect((await streakNow()).readyToSwitch).toBe(true);
  });

  it('will not count past a night nobody reconciled, however many matched', async () => {
    // Six matched nights now exist, but the fifth night back was never
    // reconciled — so only five of them are CONSECUTIVE.
    await reconcileOk(BEYOND_THE_GAP_NIGHT, AN_EMPTY_NIGHT);

    const streak = await streakNow();

    expect(streak.consecutiveMatchedNights).toBe(5);
    expect(streak.brokenBy).toEqual({
      businessDay: shiftDay(NIGHT, -5),
      reason: 'NOT_RECONCILED',
    });
  });
});

/* ───────────────────────────── the history ───────────────────────────── */

describe('the history', () => {
  it('keeps every attempt, and marks which one counts', async () => {
    const res = await get(
      `/reconciliation?from=${shiftDay(NIGHT, -12)}&to=${NIGHT}`,
      tokens.manager,
    );

    expect(res.status).toBe(200);
    const entries: Array<{ businessDay: string; isLatestForNight: boolean; verdict: string }> =
      res.body.entries;

    const forTheNight = entries.filter((entry) => entry.businessDay === NIGHT);
    // Reconciled several times across this file: matched, noted, corrected
    // wrong, corrected right. Every attempt survives — "we reconciled Friday
    // three times before it matched" is what a pilot exists to surface.
    expect(forTheNight.length).toBeGreaterThan(3);
    expect(forTheNight.filter((entry) => entry.isLatestForNight)).toHaveLength(1);
    expect(forTheNight[0]?.isLatestForNight).toBe(true);
    expect(forTheNight[0]?.verdict).toBe(ReconciliationVerdict.MATCHED_WITH_NOTE);

    expect(res.body.submissions).toBe(entries.length);
    expect(res.body.nightsReconciled).toBeLessThan(entries.length);
  });

  it('carries the line-by-line comparison exactly as it was signed off', async () => {
    const res = await get(`/reconciliation?from=${NIGHT}&to=${NIGHT}`, tokens.manager);
    const latest = res.body.entries[0];

    expect(latest.lines).toHaveLength(5);
    expect(latest.lines.map((line: { key: string }) => line.key)).toEqual([
      'CASH',
      'CARD',
      'BOOKINGS',
      'TIPS_DIRECT_CASH',
      'OPEN_SESSIONS',
    ]);
    expect(latest.lines[0]).toMatchObject({ toleranceFils: 0, withinTolerance: true });
  });

  it('refuses a window wider than the reporting cap rather than answering a narrower one', async () => {
    const res = await get('/reconciliation?from=2000-01-01&to=2026-12-31', tokens.manager);

    expect(outcome(res)).toEqual({ status: 422, code: ErrorCode.REPORT_RANGE_TOO_LARGE });
  });
});

/* ──────────────────── a night that is still moving ──────────────────── */

describe('a night with a session still in a room', () => {
  it('will not certify it, even when every money line agrees', async () => {
    const [, therapistB] = fixtures.employeeIds;
    const [, roomB] = fixtures.roomIds;
    await trade({
      employeeId: therapistB,
      roomId: roomB,
      startsAt: slotAt(165),
      baseMethod: PaymentMethod.CASH,
      leaveOpen: true,
    });

    const sheet = await get(`/reconciliation/${NIGHT}/sheet`, tokens.manager);
    expect(sheet.body.openSessions).toHaveLength(1);
    expect(sheet.body.warnings.join(' ')).toMatch(/still open/);

    const paper = await figuresFromDatabase(NIGHT);
    const result = await reconcileOk(NIGHT, paper);

    // The drawer, the terminal and the session count all agree. The night is
    // still not signed off, because a treatment nobody checked out is a tip
    // nobody has recorded — the figures are still moving.
    expect(result.verdict).toBe(ReconciliationVerdict.MISMATCHED);
    expect(result.failing.map((line: { key: string }) => line.key)).toEqual(['OPEN_SESSIONS']);
    expect(result.system.openSessions).toBe(1);
    expect((await streakNow()).consecutiveMatchedNights).toBe(0);
  });
});

/* ─────────────────────── nothing can be rewritten ─────────────────────── */

describe('the record is append-only', () => {
  async function anyRowId(): Promise<string> {
    const row = await ctx.prisma.nightlyReconciliation.findFirstOrThrow({
      orderBy: { submittedAt: 'desc' },
    });
    return row.id;
  }

  it('refuses an UPDATE at the database, not merely in the service', async () => {
    const id = await anyRowId();

    await expect(
      ctx.prisma.$executeRawUnsafe(
        `UPDATE nightly_reconciliations SET verdict = 'MATCHED' WHERE id = '${id}'::uuid`,
      ),
    ).rejects.toThrow(/append-only/);
  });

  it('refuses a DELETE', async () => {
    const id = await anyRowId();

    await expect(
      ctx.prisma.$executeRawUnsafe(
        `DELETE FROM nightly_reconciliations WHERE id = '${id}'::uuid`,
      ),
    ).rejects.toThrow(/append-only/);
  });

  it('refuses a row whose verdict disagrees with its own variances', async () => {
    // A matched verdict beside a five-thousand-fil cash variance. The table the
    // switchover decision rests on must not be able to hold one.
    const id = await anyRowId();

    await expect(
      ctx.prisma.$executeRawUnsafe(`
        INSERT INTO nightly_reconciliations (
          branch_id, business_day, verdict,
          counted_cash_fils, paper_bookings, paper_card_total_fils,
          system_cash_fils, system_bookings, system_card_total_fils, system_tips_cash_fils,
          cash_variance_fils, bookings_variance, card_variance_fils,
          cash_tolerance_fils, open_sessions, lines, cash_desk_user_ids, submitted_by_user_id)
        SELECT branch_id, business_day, 'MATCHED',
               system_cash_fils + 5000, system_bookings, system_card_total_fils,
               system_cash_fils, system_bookings, system_card_total_fils, system_tips_cash_fils,
               5000, 0, 0,
               0, 0, '[]'::jsonb, '{}'::uuid[], submitted_by_user_id
          FROM nightly_reconciliations WHERE id = '${id}'::uuid`),
    ).rejects.toThrow(/verdict_chk/);
  });

  it('refuses a variance that does not equal paper minus system', async () => {
    const id = await anyRowId();

    await expect(
      ctx.prisma.$executeRawUnsafe(`
        INSERT INTO nightly_reconciliations (
          branch_id, business_day, verdict,
          counted_cash_fils, paper_bookings, paper_card_total_fils,
          system_cash_fils, system_bookings, system_card_total_fils, system_tips_cash_fils,
          cash_variance_fils, bookings_variance, card_variance_fils,
          cash_tolerance_fils, open_sessions, lines, cash_desk_user_ids, submitted_by_user_id)
        SELECT branch_id, business_day, 'MATCHED',
               system_cash_fils, system_bookings, system_card_total_fils,
               system_cash_fils, system_bookings, system_card_total_fils, system_tips_cash_fils,
               999, 0, 0,
               0, 0, '[]'::jsonb, '{}'::uuid[], submitted_by_user_id
          FROM nightly_reconciliations WHERE id = '${id}'::uuid`),
    ).rejects.toThrow(/variance_chk/);
  });
});

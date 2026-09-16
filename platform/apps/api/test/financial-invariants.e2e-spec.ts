/**
 * The seven financial invariants of §13.3, asserted in SQL against seeded data.
 *
 * These are property tests, not example tests: they run over every row the seed
 * produced — roughly two hundred bookings, their payments, tips, ledger entries
 * and audit trail — and every one of them asks "is there ANY row for which this
 * is untrue". Each query therefore returns the OFFENDING rows and the assertion
 * is `toEqual([])`, so a failure prints the reservation reference, the employee
 * and the delta in fils rather than `expected 0, received 3`.
 *
 * Invariant 6 is the canary. It is deliberately asserted by an independent
 * overlap query rather than by trying to insert a conflicting row: if a future
 * migration drops an exclusion constraint, this fails on the pull request
 * instead of on a Friday night.
 */

import { seed } from '../prisma/seed';
import { businessDay } from '@berelax/contracts';
import { getPrisma, resetDatabase } from './setup-e2e';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * Pinned rather than "today": the seed hangs its sixty-day history, its payout
 * cutoff and its near-future bookings off this day, and an invariant suite whose
 * fixture changes with the wall clock is one that fails once a quarter for
 * reasons nobody can reproduce.
 */
const SEED_ANCHOR_DAY = '2026-09-16';

let prisma: PrismaService;

/** Every statement below is a static literal — nothing here interpolates input. */
function query<T>(sql: string): Promise<T[]> {
  return prisma.$queryRawUnsafe<T[]>(sql);
}

beforeAll(async () => {
  prisma = getPrisma();
  await resetDatabase();
  await seed(prisma, { quiet: true, anchorDay: SEED_ANCHOR_DAY });
}, 120_000);

describe('financial invariants (§13.3)', () => {
  /**
   * Run first, because every invariant below is trivially true of an empty
   * database and a green suite on no data is worse than no suite at all.
   */
  it('runs against a fixture substantial enough for the invariants to mean anything', async () => {
    const [counts] = await query<{
      reservations: number;
      completed: number;
      payments: number;
      tips_direct: number;
      tips_collected: number;
      ledger: number;
      payouts: number;
      audit: number;
      trading_days: number;
    }>(`
      SELECT (SELECT count(*) FROM reservations)::int                                       AS reservations,
             (SELECT count(*) FROM reservations WHERE status = 'COMPLETED')::int            AS completed,
             (SELECT count(*) FROM payments)::int                                           AS payments,
             (SELECT count(*) FROM tips WHERE type = 'DIRECT_CASH')::int                    AS tips_direct,
             (SELECT count(*) FROM tips WHERE type = 'COLLECTED_BY_BUSINESS')::int          AS tips_collected,
             (SELECT count(*) FROM therapist_payout_ledger)::int                            AS ledger,
             (SELECT count(*) FROM therapist_payout_ledger WHERE entry_type = 'PAYOUT')::int AS payouts,
             (SELECT count(*) FROM financial_audit_log)::int                                AS audit,
             (SELECT count(DISTINCT business_day) FROM reservations)::int                   AS trading_days`);

    expect(counts.reservations).toBeGreaterThanOrEqual(150);
    expect(counts.completed).toBeGreaterThanOrEqual(100);
    expect(counts.payments).toBeGreaterThanOrEqual(100);
    // Both tip modes must be represented, or invariants 2 and 3 prove nothing.
    expect(counts.tips_direct).toBeGreaterThan(0);
    expect(counts.tips_collected).toBeGreaterThan(0);
    // Without a PAYOUT entry the `- SUM(payouts)` term of invariant 1 is untested.
    expect(counts.payouts).toBeGreaterThan(0);
    expect(counts.ledger).toBeGreaterThan(counts.tips_collected);
    expect(counts.audit).toBeGreaterThan(0);
    expect(counts.trading_days).toBeGreaterThanOrEqual(60);
  });

  it('1. every employee’s ledger balance equals collected tips + commission accruals − payouts', async () => {
    const offenders = await query(`
      SELECT e.display_name                                                   AS employee,
             b.ledger_sum, b.tips_collected, b.commissions, b.payouts,
             b.ledger_sum - (b.tips_collected + b.commissions - b.payouts)    AS delta_fils
        FROM employees e
        CROSS JOIN LATERAL (
          SELECT
            (SELECT COALESCE(SUM(amount_fils), 0)::int FROM therapist_payout_ledger
              WHERE employee_id = e.id)                                        AS ledger_sum,
            -- A reversed tip is excluded here and cancelled by its REVERSAL entry
            -- on the ledger side, so both sides fall by the same amount. The seed
            -- writes no reversals; §9.4 reversals have their own unit coverage.
            (SELECT COALESCE(SUM(amount_fils), 0)::int FROM tips
              WHERE employee_id = e.id AND type = 'COLLECTED_BY_BUSINESS'
                AND reversed_by_tip_id IS NULL)                                AS tips_collected,
            (SELECT COALESCE(SUM(amount_fils), 0)::int FROM therapist_payout_ledger
              WHERE employee_id = e.id AND entry_type = 'COMMISSION_ACCRUAL')  AS commissions,
            -- Ledger payouts are stored negative; the invariant subtracts a magnitude.
            (SELECT COALESCE(SUM(-amount_fils), 0)::int FROM therapist_payout_ledger
              WHERE employee_id = e.id AND entry_type = 'PAYOUT')              AS payouts
        ) b
       WHERE b.ledger_sum <> b.tips_collected + b.commissions - b.payouts
       ORDER BY e.display_name`);

    expect(offenders).toEqual([]);
  });

  it('2. no ledger entry exists for any DIRECT_CASH tip', async () => {
    // The business never held that money, so it owes nothing. Writing an accrual
    // and an offsetting settlement "for symmetry" is how a spa pays a tip twice
    // — once in cash on the night, once again in the monthly payout. §9.2.
    const accruedDirectCash = await query(`
      SELECT l.id AS ledger_entry_id, l.entry_type, l.amount_fils, t.id AS tip_id
        FROM therapist_payout_ledger l
        JOIN tips t ON t.id = l.tip_id
       WHERE t.type = 'DIRECT_CASH'`);
    expect(accruedDirectCash).toEqual([]);

    // The same claim from the other side: cash handed to the therapist never
    // touched the till, so it can carry neither a payment row nor a method.
    const leakedIntoTill = await query(`
      SELECT id AS tip_id, amount_fils, method, payment_id
        FROM tips
       WHERE type = 'DIRECT_CASH' AND (payment_id IS NOT NULL OR method IS NOT NULL)`);
    expect(leakedIntoTill).toEqual([]);
  });

  it('3. every COLLECTED_BY_BUSINESS tip has exactly one payment and one TIP_ACCRUAL', async () => {
    // Positive rows only. A reversal (§9.4) writes a MIRROR tip with a negative
    // amount, and that mirror is backed by a REFUND payment and a REVERSAL
    // ledger entry — not a TIP payment and a TIP_ACCRUAL. Counting mirrors here
    // would report every correctly-performed reversal as corruption. The next
    // test asserts the mirrors are well formed in their own right, so nothing
    // goes unchecked.
    const malformed = await query(`
      SELECT t.id AS tip_id, t.amount_fils, r.ref AS reservation,
             (SELECT count(*)::int FROM payments p
               WHERE p.id = t.payment_id AND p.kind = 'TIP'
                 AND p.amount_fils = t.amount_fils)                AS matching_payments,
             (SELECT count(*)::int FROM therapist_payout_ledger l
               WHERE l.tip_id = t.id AND l.entry_type = 'TIP_ACCRUAL'
                 AND l.amount_fils = t.amount_fils)                AS matching_accruals
        FROM tips t
        JOIN reservations r ON r.id = t.reservation_id
       WHERE t.type = 'COLLECTED_BY_BUSINESS'
         AND t.amount_fils > 0
         AND ( (SELECT count(*) FROM payments p
                 WHERE p.id = t.payment_id AND p.kind = 'TIP'
                   AND p.amount_fils = t.amount_fils) <> 1
            OR (SELECT count(*) FROM therapist_payout_ledger l
                 WHERE l.tip_id = t.id AND l.entry_type = 'TIP_ACCRUAL'
                   AND l.amount_fils = t.amount_fils) <> 1 )
       ORDER BY r.ref`);

    expect(malformed).toEqual([]);
  });

  it('3b. every reversed tip is mirrored, refunded and un-accrued together', async () => {
    // The other half of §9.4. A reversal is only trustworthy if all four pieces
    // moved: the original marked reversed, a negative mirror, the money sent
    // back when the business had held it, and the liability cancelled.
    const brokenReversals = await query(`
      SELECT orig.id AS original_tip, orig.amount_fils, orig.type,
             mirror.id AS mirror_tip, mirror.amount_fils AS mirror_amount,
             (SELECT count(*)::int FROM payments p
               WHERE p.kind = 'REFUND' AND p.reverses_payment_id = orig.payment_id) AS refunds,
             (SELECT count(*)::int FROM therapist_payout_ledger l
               WHERE l.tip_id = mirror.id AND l.entry_type = 'REVERSAL') AS reversal_entries
        FROM tips orig
        JOIN tips mirror ON mirror.id = orig.reversed_by_tip_id
       WHERE orig.reversed_by_tip_id IS NOT NULL
         AND (
              mirror.amount_fils <> -orig.amount_fils
           OR mirror.type <> orig.type
           OR (orig.type = 'COLLECTED_BY_BUSINESS' AND (
                 (SELECT count(*) FROM payments p
                   WHERE p.kind = 'REFUND' AND p.reverses_payment_id = orig.payment_id) <> 1
              OR (SELECT count(*) FROM therapist_payout_ledger l
                   WHERE l.tip_id = mirror.id AND l.entry_type = 'REVERSAL') <> 1))
           OR (orig.type = 'DIRECT_CASH' AND (
                 mirror.payment_id IS NOT NULL
              OR (SELECT count(*) FROM therapist_payout_ledger l
                   WHERE l.tip_id = mirror.id) <> 0))
         )`);

    expect(brokenReversals).toEqual([]);
  });

  it('4. the desk collected the full quoted price for every COMPLETED reservation', async () => {
    // A short payment is a discount, and a discount is a manager decision recorded
    // as an ADJUSTMENT — never a quiet under-collection at the desk. §8.2.
    //
    // This asks about BASE only. The original phrasing, "net of refunds",
    // bucketed every REFUND against the base, so refunding a TIP made a
    // fully-paid booking look short — and a legitimate, audited base refund
    // made it look short too, which is not corruption but a manager's decision.
    // What the system actually guarantees is narrower and checkable: the desk
    // collected the quoted price in full. Refunds are governed by 4b.
    const unbalanced = await query(`
      SELECT r.ref AS reservation, r.base_cost_fils,
             COALESCE(SUM(p.amount_fils) FILTER (WHERE p.kind = 'BASE'), 0)::int AS base_collected_fils
        FROM reservations r
        LEFT JOIN payments p ON p.reservation_id = r.id
       WHERE r.status = 'COMPLETED'
       GROUP BY r.id, r.ref, r.base_cost_fils
      HAVING r.base_cost_fils <> COALESCE(SUM(p.amount_fils) FILTER (WHERE p.kind = 'BASE'), 0)
       ORDER BY r.ref`);

    expect(unbalanced).toEqual([]);
  });

  it('4b. no payment was refunded for more than it was worth', async () => {
    // The other direction: money can only go back out if it came in. A refund
    // resolves to the payment it reverses, so refunding a 50 AED tip can never
    // be mistaken for shorting a 250 AED base.
    const overRefunded = await query(`
      SELECT orig.id AS payment_id, orig.kind, orig.amount_fils,
             SUM(ref.amount_fils)::int AS refunded_fils
        FROM payments orig
        JOIN payments ref ON ref.reverses_payment_id = orig.id AND ref.kind = 'REFUND'
       GROUP BY orig.id, orig.kind, orig.amount_fils
      HAVING -SUM(ref.amount_fils) > orig.amount_fils
       ORDER BY orig.id`);

    expect(overRefunded).toEqual([]);
  });

  it('5. no reservation is COMPLETED without a completion time, nor IN_PROGRESS without an arrival', async () => {
    const incoherent = await query(`
      SELECT ref AS reservation, status, actual_arrival_at, completed_at,
             CASE
               WHEN status = 'COMPLETED'   AND completed_at      IS NULL THEN 'completed without completed_at'
               WHEN status = 'COMPLETED'   AND actual_arrival_at IS NULL THEN 'completed without ever arriving'
               WHEN status = 'IN_PROGRESS' AND actual_arrival_at IS NULL THEN 'in progress without an arrival'
               ELSE 'completed before the guest arrived'
             END AS problem
        FROM reservations
       WHERE (status = 'COMPLETED'   AND completed_at      IS NULL)
          OR (status = 'COMPLETED'   AND actual_arrival_at IS NULL)
          OR (status = 'IN_PROGRESS' AND actual_arrival_at IS NULL)
          OR (status = 'COMPLETED'   AND completed_at < actual_arrival_at)
       ORDER BY ref`);

    expect(incoherent).toEqual([]);
  });

  /**
   * THE CANARY.
   *
   * Asserted by query, not by attempting a conflicting insert, and deliberately
   * not by reading pg_constraint either: this must stay true even if somebody
   * drops the constraint, because what matters to a guest is that two people are
   * not in the same room, not that a particular DDL object exists.
   */
  it('6. no two live reservations share a therapist and an overlapping range', async () => {
    const collisions = await query(`
      SELECT a.ref AS first_ref, b.ref AS second_ref, e.display_name AS therapist,
             a.starts_at AS first_starts, a.blocked_until AS first_blocked_until,
             b.starts_at AS second_starts
        FROM reservations a
        JOIN reservations b
          ON a.id < b.id
         AND a.branch_id   = b.branch_id
         AND a.employee_id = b.employee_id
         AND tstzrange(a.starts_at, a.blocked_until, '[)')
          && tstzrange(b.starts_at, b.blocked_until, '[)')
        JOIN employees e ON e.id = a.employee_id
       WHERE a.status IN ('SCHEDULED', 'IN_PROGRESS')
         AND b.status IN ('SCHEDULED', 'IN_PROGRESS')
       ORDER BY a.starts_at`);

    expect(collisions).toEqual([]);
  });

  it('6b. nor a room, nor — on the treatment window — a guest', async () => {
    // Rooms are blocked to `blocked_until` because the room needs cleaning;
    // guests only to `ends_at`, because a guest is free the moment they are done.
    const roomCollisions = await query(`
      SELECT a.ref AS first_ref, b.ref AS second_ref, rm.name AS room
        FROM reservations a
        JOIN reservations b
          ON a.id < b.id AND a.branch_id = b.branch_id AND a.room_id = b.room_id
         AND tstzrange(a.starts_at, a.blocked_until, '[)')
          && tstzrange(b.starts_at, b.blocked_until, '[)')
        JOIN rooms rm ON rm.id = a.room_id
       WHERE a.status IN ('SCHEDULED', 'IN_PROGRESS')
         AND b.status IN ('SCHEDULED', 'IN_PROGRESS')`);
    expect(roomCollisions).toEqual([]);

    const guestCollisions = await query(`
      SELECT a.ref AS first_ref, b.ref AS second_ref, g.full_name AS guest
        FROM reservations a
        JOIN reservations b
          ON a.id < b.id AND a.branch_id = b.branch_id AND a.guest_id = b.guest_id
         AND tstzrange(a.starts_at, a.ends_at, '[)')
          && tstzrange(b.starts_at, b.ends_at, '[)')
        JOIN guests g ON g.id = a.guest_id
       WHERE a.status IN ('SCHEDULED', 'IN_PROGRESS')
         AND b.status IN ('SCHEDULED', 'IN_PROGRESS')`);
    expect(guestCollisions).toEqual([]);
  });

  /**
   * The complement to invariant 6. Clean data proves nothing about a constraint
   * that has been dropped until somebody actually double-books, so this asks the
   * catalogue directly. Both tests have to pass: one catches bad data, the other
   * catches a missing guard before any bad data exists.
   */
  it('6c. the three exclusion constraints are still installed', async () => {
    const installed = await query<{ conname: string }>(`
      SELECT conname FROM pg_constraint
       WHERE contype = 'x' AND conrelid = 'public.reservations'::regclass
       ORDER BY conname`);

    expect(installed.map((c) => c.conname)).toEqual([
      'reservations_no_guest_overlap',
      'reservations_no_room_overlap',
      'reservations_no_therapist_overlap',
    ]);
  });

  it('7. every payment, tip and ledger entry has an audit entry within one second', async () => {
    // "Corresponding" means: an audit row for the entity the money hangs off —
    // the reservation for payments, tips and accruals; the batch for a payout —
    // written inside the same transaction, hence the same instant. §9.6.
    const unaudited = await query(`
      WITH money AS (
        -- created_at, NOT collected_at. collected_at is when the money changed
        -- hands and reception may legitimately back-date it (§8.2); created_at
        -- is when the row was written, which is the thing an audit entry is
        -- supposed to sit beside.
        SELECT 'payments' AS source, p.id, p.branch_id,
               p.reservation_id AS anchor_id, p.created_at AS written_at
          FROM payments p
        UNION ALL
        SELECT 'tips', t.id, t.branch_id, t.reservation_id, t.recorded_at
          FROM tips t
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
       ORDER BY m.written_at
       LIMIT 20`);

    expect(unaudited).toEqual([]);
  });
});

/**
 * The SQL half of the business-day contract. `src/common/business-day.spec.ts`
 * pins the TypeScript `businessDay()` against literal dates without needing a
 * database; this is where the two implementations are shown to agree, over every
 * row the seed produced rather than a handful of examples.
 */
describe('business_day(): SQL and TypeScript agree (§3.3)', () => {
  it('derives the same trading day for every seeded reservation', async () => {
    const rows = await query<{ ref: string; starts_at: Date; sql_day: Date; stored_day: Date }>(`
      SELECT ref, starts_at,
             business_day(starts_at)                              AS sql_day,
             business_day                                         AS stored_day
        FROM reservations
       ORDER BY starts_at`);

    expect(rows.length).toBeGreaterThan(150);

    const disagreements = rows
      .map((row) => ({
        ref: row.ref,
        startsAt: row.starts_at.toISOString(),
        sql: row.sql_day.toISOString().slice(0, 10),
        stored: row.stored_day.toISOString().slice(0, 10),
        typescript: businessDay(row.starts_at),
      }))
      .filter((r) => r.sql !== r.typescript || r.sql !== r.stored);

    expect(disagreements).toEqual([]);
  });

  it('bills an after-midnight booking to the previous trading day', async () => {
    // The rule that makes every revenue report right or wrong: a 01:30 session on
    // Tuesday is Monday's takings. If the seed ever stops producing after-midnight
    // bookings this goes red, and the coverage is restored rather than lost quietly.
    const [row] = await query<{ after_midnight: number; billed_to_previous_day: number }>(`
      SELECT count(*)::int AS after_midnight,
             count(*) FILTER (
               WHERE business_day = ((starts_at AT TIME ZONE 'Asia/Dubai')::date - 1)
             )::int AS billed_to_previous_day
        FROM reservations
       WHERE (starts_at AT TIME ZONE 'Asia/Dubai')::time < TIME '06:00'`);

    expect(row!.after_midnight).toBeGreaterThan(0);
    expect(row!.billed_to_previous_day).toBe(row!.after_midnight);
  });
});

import { Injectable, Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';

import { PrismaService } from '../prisma/prisma.service';

/**
 * What `ThrottlerStorage.increment` has to return. @nestjs/throttler declares
 * this shape but does not re-export the type from its index, and reaching into
 * its dist/ would bind us to a path that is not part of its public surface.
 * Declared here instead: `implements ThrottlerStorage` below still checks it
 * structurally, so if the library ever changes the shape, this file stops
 * compiling — which is the warning worth having.
 */
interface ThrottlerRecord {
  totalHits: number;
  /** Seconds until the current window ends. */
  timeToExpire: number;
  isBlocked: boolean;
  /** Seconds until the block lifts; 0 when not blocked. */
  timeToBlockExpire: number;
}

/**
 * Rate-limit counters in PostgreSQL, shared by every instance of the API.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * @nestjs/throttler's default storage is a `Map` in the process. That was
 * defensible while the API was one long-lived container and became wrong the
 * moment it stopped being one: each serverless instance keeps its own Map, so
 * §12.4's "5 login attempts per 15 minutes" turns into 5 × however many
 * instances the platform happens to have warm. Nobody controls that number, and
 * an attacker can raise it simply by opening more connections. A brute-force
 * limit multiplied by an unknown is not a limit.
 *
 * Everything else about serverless this system already handles — transactions
 * are round trips, the audit context is per invocation, idempotency is a table.
 * This was the one genuine regression, and this file is the answer to it.
 *
 * ── WHY POSTGRES AND NOT REDIS ──────────────────────────────────────────────
 *
 * Redis is the reflex, and here it is the wrong reflex. This system has exactly
 * one data store. Adding Upstash — or anything else — means another vendor,
 * another DPA, another row in docs/compliance/data-processing-register.md,
 * another secret to rotate, another thing that can be down at 01:00, and
 * another set of credentials in the breach runbook's blast radius. That is a
 * real, recurring cost paid in compliance work, not just in money.
 *
 * What it would buy is throughput this business does not have. A spa doing
 * 30–60 reservations a night (§12.1) generates a few counter rows and one
 * single-row UPSERT per request, against a database already doing far more work
 * for every booking. Postgres is entirely adequate, and "one data store" is a
 * property worth keeping.
 *
 * ── CORRECTNESS UNDER CONCURRENCY ───────────────────────────────────────────
 *
 * The count is incremented by ONE statement — `INSERT … ON CONFLICT DO UPDATE`
 * — never read-then-write. Postgres takes a row lock for the duration of the
 * conflicting update, so concurrent increments of the same key serialise and no
 * hit is lost, whether they arrive on one connection or on fifty across as many
 * instances. A read-modify-write would lose hits exactly when it matters most:
 * under the burst a rate limiter exists to stop.
 *
 * Every timestamp is the DATABASE's `now()`, never the instance's clock. N
 * instances have N clocks; a window that starts on one and ends on another is a
 * window of unknown length.
 *
 * ── FIXED WINDOW, AND WHAT THAT COSTS ───────────────────────────────────────
 *
 * The in-memory storage expires each hit individually, which makes it a sliding
 * window. This is a fixed window, like every non-memory ThrottlerStorage in
 * this ecosystem, because a sliding window means storing one row per hit rather
 * than one row per caller.
 *
 * Named plainly rather than quietly dropped: at a window boundary a caller can
 * land `limit` requests at the end of one window and `limit` more at the start
 * of the next — up to 2 × limit in a burst. The sustained rate is unchanged
 * (limit per ttl), and once the limit is exceeded the key is blocked for a full
 * `blockDuration`, so the trick works once and not repeatedly. For the login
 * limit that means a worst case of ten attempts in a moment instead of five,
 * against an account that locks itself after five failures anyway (§6.1,
 * `ACCOUNT_LOCKED`). Set against 5 × N, it is a large net tightening.
 *
 * ── FAILURE MODE: CLOSED ────────────────────────────────────────────────────
 *
 * If the database is unreachable this throws and the request fails. That is
 * deliberate. A rate limiter that opens when its store is down is a rate limiter
 * an attacker can remove by attacking the store — and an API that cannot reach
 * Postgres cannot serve a booking anyway, so nothing is lost by refusing.
 */
@Injectable()
export class PgThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(PgThrottlerStorage.name);

  /**
   * How often a request also sweeps expired rows, and how many it takes.
   *
   * Sampled rather than scheduled: there is no always-on process to hang an
   * interval on, and `pg_cron` is absent from local Postgres and from CI (see
   * 20260917090000_retention_schedule for what accommodating that costs). At
   * one in a hundred requests the sweep is invisible in the p95 and still runs
   * many times an hour on any night the spa is open; the batch is bounded so it
   * can never become the slow part of a booking.
   */
  private static readonly SWEEP_PROBABILITY = 0.01;
  private static readonly SWEEP_BATCH = 1000;

  constructor(private readonly prisma: PrismaService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerRecord> {
    // Milliseconds, as integers: `$n::bigint` fixes the parameter's type at
    // parse time, and a fractional value would not bind to it.
    const ttlMs = Math.max(0, Math.trunc(ttl));
    const blockMs = Math.max(0, Math.trunc(blockDuration));
    const maxHits = Math.trunc(limit);

    const rows = await this.prisma.$queryRaw<ThrottlerRecord[]>`
      INSERT INTO rate_limit_counters AS c (key, throttler, hits, window_ends_at, blocked_until)
      VALUES (${key}, ${throttlerName}, 1, now() + (${ttlMs}::bigint * INTERVAL '1 millisecond'), NULL)
      ON CONFLICT (key, throttler) DO UPDATE SET
        -- Every branch reads the OLD row: Postgres evaluates all SET
        -- expressions against the pre-update tuple, so the three CASEs below
        -- agree with each other by construction.
        hits = CASE
          -- Blocked: refuse without counting, exactly as the in-memory storage
          -- does. Counting here would extend the block on every retry and turn
          -- a 15-minute lockout into an unbounded one.
          WHEN c.blocked_until > now()   THEN c.hits
          WHEN c.window_ends_at <= now() THEN 1
          ELSE c.hits + 1
        END,
        window_ends_at = CASE
          WHEN c.blocked_until > now()   THEN c.window_ends_at
          WHEN c.window_ends_at <= now() THEN now() + (${ttlMs}::bigint * INTERVAL '1 millisecond')
          ELSE c.window_ends_at
        END,
        blocked_until = CASE
          WHEN c.blocked_until > now()   THEN c.blocked_until
          -- The window rolled, which means the block (never shorter than the
          -- window) has rolled with it. Fresh start.
          WHEN c.window_ends_at <= now() THEN NULL
          WHEN c.hits + 1 > ${maxHits}::int THEN now() + (${blockMs}::bigint * INTERVAL '1 millisecond')
          ELSE NULL
        END
      RETURNING
        hits AS "totalHits",
        GREATEST(CEIL(EXTRACT(EPOCH FROM (window_ends_at - now())))::int, 0) AS "timeToExpire",
        (blocked_until IS NOT NULL AND blocked_until > now()) AS "isBlocked",
        GREATEST(CEIL(EXTRACT(EPOCH FROM (COALESCE(blocked_until, now()) - now())))::int, 0)
          AS "timeToBlockExpire"`;

    const record = rows[0];
    if (!record) {
      // An UPSERT that matched nothing cannot happen; if it ever does, the
      // count is unknown and the safe answer is to refuse, not to guess.
      throw new Error(`Rate-limit counter for ${throttlerName} returned no row.`);
    }

    if (Math.random() < PgThrottlerStorage.SWEEP_PROBABILITY) await this.sweep();

    return record;
  }

  /**
   * Delete counters nobody is counting any more.
   *
   * An hour of grace past the window's end, and never a row that is still
   * blocked: deleting one of those would hand the caller a clean slate early,
   * which is the one way a garbage collector can become a security hole. The
   * batch is bounded and ordered so the work is a bounded index scan rather
   * than "however much rubbish has accumulated".
   */
  private async sweep(): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        DELETE FROM rate_limit_counters c
         USING (
           SELECT key, throttler
             FROM rate_limit_counters
            WHERE window_ends_at < now() - INTERVAL '1 hour'
              AND (blocked_until IS NULL OR blocked_until < now())
            ORDER BY window_ends_at
            LIMIT ${PgThrottlerStorage.SWEEP_BATCH}
         ) stale
         WHERE c.key = stale.key AND c.throttler = stale.throttler`;
    } catch (error) {
      // Housekeeping, not the request. A failed sweep leaves rows to be swept
      // by the next one; failing the caller's booking over it would not.
      this.logger.warn(`Rate-limit sweep failed: ${String(error)}`);
    }
  }
}

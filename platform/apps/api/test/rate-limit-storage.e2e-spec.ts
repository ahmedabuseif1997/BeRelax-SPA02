/**
 * The rate limiter counts across instances, not inside one.
 *
 * This is the suite for the one security control that a move off an always-on
 * container would otherwise have quietly weakened. @nestjs/throttler's default
 * storage is a Map in the process: on N serverless instances, §12.4's "5 login
 * attempts per 15 minutes" becomes 5 × N, and N is a number the platform picks.
 *
 * So the assertions that matter here are not "the limiter works" — they are
 * that a hammered key loses no hits, that a window really ends, and that two
 * SEPARATE applications sharing one database share one counter. The last one is
 * the whole point of PgThrottlerStorage; it is the last test in the file.
 */

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import type { Server } from 'node:http';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { PgThrottlerStorage } from '../src/common/pg-throttler.storage';
import { PrismaService } from '../src/prisma/prisma.service';
import { getPrisma, resetDatabase, route } from './setup-e2e';

const WINDOW = 'default';

/** Distinct per test: a leftover counter from a neighbour would be indistinguishable from a bug. */
function freshKey(label: string): string {
  return `${label}-${Math.random().toString(36).slice(2)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface CounterRow {
  hits: number;
  blocked_until: Date | null;
  window_ends_at: Date;
}

async function readCounter(key: string): Promise<CounterRow | undefined> {
  const rows = await getPrisma().$queryRaw<CounterRow[]>`
    SELECT hits, blocked_until, window_ends_at
      FROM rate_limit_counters
     WHERE key = ${key} AND throttler = ${WINDOW}`;
  return rows[0];
}

describe('PgThrottlerStorage', () => {
  let storage: PgThrottlerStorage;

  beforeAll(() => {
    storage = new PgThrottlerStorage(getPrisma());
  });

  beforeEach(async () => {
    await getPrisma().$executeRawUnsafe('DELETE FROM rate_limit_counters');
  });

  it('counts a single caller the way the in-memory storage does', async () => {
    const key = freshKey('sequential');
    const seen = [];
    for (let i = 0; i < 7; i++) {
      seen.push(await storage.increment(key, 60_000, 5, 60_000, WINDOW));
    }

    // Five admitted, the sixth trips the block, the seventh is refused without
    // being counted — otherwise every retry would extend its own lockout.
    expect(seen.map((r) => r.totalHits)).toEqual([1, 2, 3, 4, 5, 6, 6]);
    expect(seen.map((r) => r.isBlocked)).toEqual([false, false, false, false, false, true, true]);
    expect(seen[5]?.timeToBlockExpire).toBeGreaterThan(0);
    expect(seen[0]?.timeToExpire).toBe(60);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // NO LOST UPDATES
  // ───────────────────────────────────────────────────────────────────────────

  it('loses no hits when one key is hammered concurrently', async () => {
    const key = freshKey('hammer');
    const N = 60;

    // A read-then-write storage passes the "the count went up" test and fails
    // this one: interleaved readers all see the same number and all write back
    // the same number + 1. The assertion is not "roughly N" — it is that the N
    // responses carry the numbers 1..N, once each, and that the row agrees.
    const records = await Promise.all(
      Array.from({ length: N }, () => storage.increment(key, 60_000, N * 10, 60_000, WINDOW)),
    );

    const counts = records.map((r) => r.totalHits).sort((a, b) => a - b);
    expect(counts).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    expect(new Set(counts).size).toBe(N);
    expect((await readCounter(key))?.hits).toBe(N);
  });

  it('admits exactly `limit` of a concurrent burst and blocks the rest', async () => {
    const key = freshKey('burst');
    const limit = 5;

    const records = await Promise.all(
      Array.from({ length: 40 }, () => storage.increment(key, 60_000, limit, 60_000, WINDOW)),
    );

    expect(records.filter((r) => !r.isBlocked)).toHaveLength(limit);
    expect(records.filter((r) => r.isBlocked)).toHaveLength(40 - limit);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // THE WINDOW REALLY ENDS
  // ───────────────────────────────────────────────────────────────────────────

  it('starts a fresh window once the old one has passed', async () => {
    const key = freshKey('window');

    expect((await storage.increment(key, 800, 5, 800, WINDOW)).totalHits).toBe(1);
    expect((await storage.increment(key, 800, 5, 800, WINDOW)).totalHits).toBe(2);

    await sleep(1_000);

    const after = await storage.increment(key, 800, 5, 800, WINDOW);
    expect(after.totalHits).toBe(1);
    expect(after.isBlocked).toBe(false);
  });

  it('lifts a block when its duration has passed, and not before', async () => {
    const key = freshKey('block');

    for (let i = 0; i < 3; i++) await storage.increment(key, 800, 2, 800, WINDOW);
    expect((await storage.increment(key, 800, 2, 800, WINDOW)).isBlocked).toBe(true);

    await sleep(1_000);

    const after = await storage.increment(key, 800, 2, 800, WINDOW);
    expect(after.isBlocked).toBe(false);
    expect(after.totalHits).toBe(1);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // THE SWEEP
  // ───────────────────────────────────────────────────────────────────────────

  it('sweeps counters nobody is counting any more, and spares the ones that matter', async () => {
    await getPrisma().$executeRawUnsafe(`
      INSERT INTO rate_limit_counters (key, throttler, hits, window_ends_at, blocked_until) VALUES
        ('sweep-stale',   'default', 9, now() - INTERVAL '2 hours', NULL),
        ('sweep-recent',  'default', 1, now() + INTERVAL '1 minute', NULL),
        -- Expired window, live block. Deleting this one would hand a blocked
        -- caller a clean slate early: a garbage collector turned security hole.
        ('sweep-blocked', 'default', 9, now() - INTERVAL '2 hours', now() + INTERVAL '10 minutes'),
        -- Inside the hour of grace, so not yet rubbish.
        ('sweep-fresh',   'default', 9, now() - INTERVAL '2 minutes', NULL)`);

    // The sweep is sampled on the request path; called directly here so the
    // test asserts what it deletes rather than how often it runs.
    await (storage as unknown as { sweep(): Promise<void> }).sweep();

    const rows = await getPrisma().$queryRaw<{ key: string }[]>`
      SELECT key FROM rate_limit_counters ORDER BY key`;
    expect(rows.map((r) => r.key)).toEqual(['sweep-blocked', 'sweep-fresh', 'sweep-recent']);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // THE POINT OF THE WHOLE CHANGE
  // ───────────────────────────────────────────────────────────────────────────

  it('shares one counter between two storages on separate connections', async () => {
    const key = freshKey('two-clients');

    // Two PrismaService instances means two connection pools — as close to two
    // serverless instances as one process gets.
    const clientA = new PrismaService();
    const clientB = new PrismaService();
    try {
      const a = new PgThrottlerStorage(clientA);
      const b = new PgThrottlerStorage(clientB);

      expect((await a.increment(key, 60_000, 3, 60_000, WINDOW)).totalHits).toBe(1);
      expect((await b.increment(key, 60_000, 3, 60_000, WINDOW)).totalHits).toBe(2);
      expect((await a.increment(key, 60_000, 3, 60_000, WINDOW)).totalHits).toBe(3);

      // The fourth is the third instance's first request and is still refused.
      // With the in-memory storage each of these would be on its first hit.
      expect((await b.increment(key, 60_000, 3, 60_000, WINDOW)).isBlocked).toBe(true);
    } finally {
      await Promise.all([clientA.$disconnect(), clientB.$disconnect()]);
    }
  });
});

/**
 * The same claim, end to end, through the real guard chain: two independently
 * booted applications — the closest thing to two Vercel instances a test can
 * build — must sum to ONE login limit, not one each.
 */
describe('login rate limit across two application instances', () => {
  const apps: INestApplication[] = [];
  let httpA: Server;
  let httpB: Server;

  /**
   * Deliberately NOT `bootstrapTestApp()`. That helper replaces ThrottlerStorage
   * with a stub so twenty-five concurrent bookings are not throttled, which is
   * right for every other suite and would make this one assert nothing.
   */
  async function boot(): Promise<Server> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('v1', { exclude: ['health', 'health/ready'] });
    app.use(cookieParser());
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
    await app.listen(0);
    apps.push(app);
    return app.getHttpServer() as Server;
  }

  beforeAll(async () => {
    await resetDatabase();
    httpA = await boot();
    httpB = await boot();
  });

  afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
  });

  it('spends one shared budget of five attempts, not five per instance', async () => {
    // An address that exists nowhere: the point is the throttler, and a real
    // account would hit the five-failure lockout (§6.1) at the same moment and
    // make it ambiguous which control refused the sixth request.
    const attempt = (http: Server) =>
      request(http)
        .post(route('/auth/login'))
        .set('x-forwarded-for', '203.0.113.7')
        .send({ email: 'nobody@test.berelax.ae', password: 'WrongPassw0rd!2026' });

    // Alternating: no instance sees more than three of the five.
    const order = [httpA, httpB, httpA, httpB, httpA];
    for (const http of order) {
      expect((await attempt(http)).status).toBe(401);
    }

    // Sixth request, on the instance that has only served two of them. With the
    // in-memory storage this is a 401 and the limit has silently become 10.
    expect((await attempt(httpB)).status).toBe(429);
    expect((await attempt(httpA)).status).toBe(429);
  });
});

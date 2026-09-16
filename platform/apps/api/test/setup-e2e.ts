/**
 * e2e harness. Loaded by `setupFilesAfterEnv`, so everything here runs once per
 * test FILE, before the file itself is imported.
 *
 * These suites run against a real PostgreSQL. That is not a preference: an
 * in-memory or mocked database has no exclusion constraints, no triggers and no
 * `business_day()`, so it would pass every test in `booking-concurrency` while
 * proving nothing at all (§13.1).
 *
 * Expected setup, which is what CI does:
 *
 *   docker compose up -d postgres-test
 *   DATABASE_URL=postgresql://postgres:test@localhost:5433/berelax_test \
 *   DIRECT_URL=$DATABASE_URL pnpm --filter api prisma:deploy
 *   DATABASE_URL=... pnpm --filter api test:e2e
 */

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcrypt';
import type { Server } from 'node:http';
import request from 'supertest';
import { UserRole, toFils } from '@berelax/contracts';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

// Set BEFORE anything reads them. `PrismaService.truncateAll()` refuses to run
// unless NODE_ENV is 'test', and UTC keeps every date assertion reproducible
// regardless of the developer's machine.
process.env.NODE_ENV = 'test';
process.env.TZ = 'UTC';

/** Matches `app.setGlobalPrefix('v1')` in main.ts. */
export const API_PREFIX = 'v1';

/** `route('/reservations')` -> `/v1/reservations`. */
export function route(path: string): string {
  return `/${API_PREFIX}${path.startsWith('/') ? path : `/${path}`}`;
}

// ─────────────────────────────────────────────────────────────
// DATABASE
// ─────────────────────────────────────────────────────────────

/**
 * These suites TRUNCATE between files. Pointing them at the development
 * database would wipe a colleague's afternoon, so the URL has to look like a
 * test database before anything connects — docker-compose publishes it on 5433
 * as `berelax_test`.
 */
function assertTestDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. The e2e suite needs the TEST database:\n' +
        '  docker compose up -d postgres-test\n' +
        '  export DATABASE_URL=postgresql://postgres:test@localhost:5433/berelax_test',
    );
  }
  const looksLikeTest = /_test(\?|$)/i.test(url) || /:5433\//.test(url);
  if (!looksLikeTest) {
    throw new Error(
      `Refusing to run: DATABASE_URL does not look like a test database (${redact(url)}).\n` +
        'This suite truncates every table. Point it at berelax_test on port 5433.',
    );
  }
  return url;
}

function redact(url: string): string {
  return url.replace(/\/\/[^@]*@/, '//***@');
}

let prisma: PrismaService | null = null;

/** The suite-level client. Separate from the application's, and unscoped by branch. */
export function getPrisma(): PrismaService {
  if (!prisma) {
    assertTestDatabaseUrl();
    prisma = new PrismaService();
  }
  return prisma;
}

/**
 * Fail loudly and early if the hand-written SQL from §5 is missing, rather than
 * letting twenty assertions fail one by one with an unrecognisable error.
 *
 * Note what is deliberately NOT checked here: the exclusion constraints. If a
 * migration drops one, that must surface as invariant 6 failing in
 * `financial-invariants.e2e-spec.ts` — the canary is worth nothing if the
 * harness refuses to start before it can sing.
 */
async function assertMigrationsApplied(): Promise<void> {
  const [row] = await getPrisma().$queryRaw<{ ok: boolean }[]>`
    SELECT to_regprocedure('business_day(timestamptz)') IS NOT NULL
       AND to_regclass('public.reservations')          IS NOT NULL
       AND to_regclass('public.reservation_ref_seq')   IS NOT NULL AS ok`;
  if (!row?.ok) {
    throw new Error(
      'The test database has no schema. Run:\n' +
        '  DIRECT_URL=$DATABASE_URL pnpm --filter api prisma:deploy',
    );
  }
}

/** Empty every table. Suites start from a known-empty database, never a leftover one. */
export async function resetDatabase(): Promise<void> {
  await getPrisma().truncateAll();
  // `ref` is drawn from a sequence that TRUNCATE does not touch, so without this
  // the second suite in a run re-issues BR-2026-0001 and trips the unique index.
  await getPrisma().$executeRawUnsafe(`SELECT setval('reservation_ref_seq', 1, false)`);
}

beforeAll(async () => {
  await assertMigrationsApplied();
  await resetDatabase();
});

afterAll(async () => {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
});

// ─────────────────────────────────────────────────────────────
// APPLICATION
// ─────────────────────────────────────────────────────────────

export interface TestApp {
  app: INestApplication;
  http: Server;
  prisma: PrismaService;
}

/**
 * Boot the real AppModule — global guards, filters and interceptors included,
 * because `PrismaErrorFilter` turning SQLSTATE 23P01 into a
 * `409 THERAPIST_ALREADY_BOOKED` is half of what §13.1 actually tests.
 *
 * The one thing overridden is the rate limiter's storage: twenty-five requests
 * from one IP inside a second is precisely what ThrottlerGuard exists to stop,
 * and a 429 would mask the 409 this suite is here to observe.
 */
export async function bootstrapTestApp(): Promise<TestApp> {
  assertTestDatabaseUrl();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    // The guard itself is left in place — it is registered under APP_GUARD, so
    // `overrideGuard(ThrottlerGuard)` matches nothing. Replacing its STORAGE is
    // what actually neuters it, and it keeps the guard in the chain so the test
    // still exercises the real pipeline.
    .overrideProvider(ThrottlerStorage)
    .useValue({
      increment: async () => ({
        totalHits: 1,
        timeToExpire: 60,
        isBlocked: false,
        timeToBlockExpire: 0,
      }),
    })
    .compile();

  const app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix(API_PREFIX, { exclude: ['health', 'health/ready'] });
  app.use(cookieParser());
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  // No global ValidationPipe here. Every handler validates with ZodValidationPipe
  // against the schemas in @berelax/contracts, so the class-validator pipe would
  // see a plain `Object` metatype and pass everything through untouched — while
  // requiring class-validator and class-transformer, which this app does not
  // depend on. Adding it would test the harness, not the API.

  // `listen`, not `init`. Supertest binds an unbound server itself, and twenty-five
  // concurrent requests would then race to call listen() on the same socket. Binding
  // an ephemeral port once here removes that race from the one suite that depends on
  // genuine parallelism.
  await app.listen(0);

  return { app, http: app.getHttpServer() as Server, prisma: app.get(PrismaService) };
}

// ─────────────────────────────────────────────────────────────
// FIXTURES
// ─────────────────────────────────────────────────────────────

export const FIXTURE_PASSWORD = 'TestPassw0rd!2026';

let cachedPasswordHash: string | null = null;

/** bcrypt at cost 12 is ~250 ms by design. Once per worker, not once per `beforeEach`. */
async function fixturePasswordHash(): Promise<string> {
  cachedPasswordHash ??= await bcrypt.hash(FIXTURE_PASSWORD, 12);
  return cachedPasswordHash;
}

export interface FixtureUser {
  id: string;
  email: string;
  role: UserRole;
}

export interface Fixtures {
  branchId: string;
  categoryId: string;
  /** 60 minutes, AED 250. The slot every concurrency test fights over. */
  serviceId: string;
  /** 90 minutes, AED 350, for tests that need a second duration. */
  longServiceId: string;
  /** Two therapists: the second exists so "the other therapist is free" is testable. */
  employeeIds: [string, string];
  /** Two rooms, for the same reason. */
  roomIds: [string, string];
  users: Record<'owner' | 'manager' | 'receptionist' | 'therapist', FixtureUser>;
  password: string;
}

/**
 * The smallest branch a booking can happen in. Turnaround is 15 minutes, which
 * is what makes `blockedUntil` land at 20:15 for a 19:00–20:00 treatment.
 */
export async function createFixtures(db: PrismaService = getPrisma()): Promise<Fixtures> {
  const passwordHash = await fixturePasswordHash();

  const branch = await db.branch.create({
    data: {
      name: 'BE RELAX (test)',
      addressLine: '250 Al Meena Street, Al Zahiyah',
      city: 'Abu Dhabi',
      phonePrimary: '+971525108633',
      whatsappNumber: '+971525108633',
      timezone: 'Asia/Dubai',
      opensAt: '11:00',
      closesAt: '02:00',
      turnaroundMins: 15,
    },
  });

  const category = await db.serviceCategory.create({ data: { name: 'Asian', sortOrder: 0 } });

  const [service, longService] = await Promise.all([
    db.service.create({
      data: {
        branchId: branch.id,
        categoryId: category.id,
        name: 'Normal Massage — 60 min',
        durationMinutes: 60,
        priceFils: toFils(250),
      },
    }),
    db.service.create({
      data: {
        branchId: branch.id,
        categoryId: category.id,
        name: 'Normal Massage — 90 min',
        durationMinutes: 90,
        priceFils: toFils(350),
      },
    }),
  ]);

  const [employeeA, employeeB] = await Promise.all([
    db.employee.create({
      data: { branchId: branch.id, displayName: 'Therapist A', commissionBps: 0 },
    }),
    db.employee.create({
      // On commission, so check-in writes a COMMISSION_ACCRUAL worth asserting.
      data: { branchId: branch.id, displayName: 'Therapist B', commissionBps: 1000 },
    }),
  ]);

  const [roomA, roomB] = await Promise.all([
    db.room.create({ data: { branchId: branch.id, name: 'Suite 1' } }),
    db.room.create({ data: { branchId: branch.id, name: 'Suite 2' } }),
  ]);

  const userSpecs = [
    { key: 'owner', email: 'owner@test.berelax.ae', role: UserRole.OWNER, employeeId: null },
    { key: 'manager', email: 'manager@test.berelax.ae', role: UserRole.MANAGER, employeeId: null },
    { key: 'receptionist', email: 'reception@test.berelax.ae', role: UserRole.RECEPTIONIST, employeeId: null },
    { key: 'therapist', email: 'therapist@test.berelax.ae', role: UserRole.THERAPIST, employeeId: employeeA.id },
  ] as const;

  const users = {} as Fixtures['users'];
  for (const spec of userSpecs) {
    const created = await db.user.create({
      data: {
        branchId: branch.id,
        email: spec.email,
        passwordHash,
        fullName: spec.email,
        role: spec.role,
        // Otherwise every login is answered with PASSWORD_CHANGE_REQUIRED and no
        // usable token, which is correct behaviour and useless as a fixture.
        mustChangePassword: false,
        employeeId: spec.employeeId,
      },
    });
    users[spec.key] = { id: created.id, email: created.email, role: spec.role };
  }

  return {
    branchId: branch.id,
    categoryId: category.id,
    serviceId: service.id,
    longServiceId: longService.id,
    employeeIds: [employeeA.id, employeeB.id],
    roomIds: [roomA.id, roomB.id],
    users,
    password: FIXTURE_PASSWORD,
  };
}

/**
 * A real access token from the real login endpoint. Minting one by hand would
 * skip the guard chain these suites are supposed to be exercising.
 */
export async function authTokenFor(
  http: Server,
  email: string,
  password: string = FIXTURE_PASSWORD,
): Promise<string> {
  const res = await request(http).post(route('/auth/login')).send({ email, password });

  if (res.status !== 200 || typeof res.body?.accessToken !== 'string') {
    throw new Error(
      `Could not sign in as ${email}: ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
  return res.body.accessToken as string;
}

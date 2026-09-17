import { z } from 'zod';

/**
 * The process refuses to start if the environment is wrong. A misconfigured
 * JWT secret discovered at boot is a five-second problem; discovered at 01:00
 * on a Friday it is a different kind of problem.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  // Supabase hands you two connection strings and using the wrong one costs an
  // afternoon: DATABASE_URL is the transaction-mode pooler (:6543), DIRECT_URL
  // is the session connection (:5432) that `prisma migrate` needs.
  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url(),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters (use 32 random bytes).'),
  JWT_SECRET_PREVIOUS: z.string().min(32).optional(),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(7),
  BCRYPT_COST: z.coerce.number().int().min(10).max(15).default(12),

  API_BASE_URL: z.string().url().default('http://localhost:3000'),
  DASHBOARD_ORIGIN: z.string().url().default('http://localhost:3001'),
  PUBLIC_SITE_ORIGIN: z.string().url().default('http://localhost:8080'),
  COOKIE_DOMAIN: z.string().default('localhost'),
  DEFAULT_BRANCH_ID: z.string().uuid().optional(),

  TZ: z.string().default('UTC'),
  WHATSAPP_NUMBER: z.string().default('971525108633'),

  ATTRIBUTION_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  GUEST_RETENTION_YEARS: z.coerce.number().int().positive().default(3),
  FINANCIAL_RETENTION_YEARS: z.coerce.number().int().positive().default(5),
  /// Never rotate: rotation orphans every already-erased guest record.
  ERASURE_SALT: z.string().min(16).default('dev-only-erasure-salt-change-me'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  SENTRY_DSN: z.string().optional(),
  IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().positive().default(24),

  /// Phase 7. How far the counted drawer may differ from the system before a
  /// night is called mismatched. Zero by default: a variance is a finding to
  /// record and chase, not a rounding allowance. Integer fils.
  ///
  /// Declared here so the key is part of the documented environment, but left
  /// as a string on purpose: `reconciliation.config.ts` owns what it MEANS, and
  /// its parser rejects "2.50" with a message that says why. Coercing here too
  /// would put two validators on one key, and the less helpful one would win by
  /// running first.
  RECONCILIATION_CASH_TOLERANCE_FILS: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * An empty string means "not set".
 *
 * .env.example ships every optional key as KEY="" so its name is discoverable,
 * and a developer fills in only the ones the README asks for. But zod applies
 * .optional() and .default() to `undefined` — an empty string is *present*, so
 * it is validated as a real value and rejected. ERASURE_SALT="" would fail its
 * length check rather than take its default; JWT_SECRET_PREVIOUS="" would be
 * read as a secret that is too short.
 *
 * Stripping blanks once, here, makes every optional and every default behave
 * the way the file's own comments say they do — rather than turning "follow
 * the README" into a boot error on someone's first morning.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const present = Object.fromEntries(
    Object.entries(raw).filter(([, v]) => !(typeof v === 'string' && v.trim() === '')),
  );
  const parsed = envSchema.safeParse(present);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  if (parsed.data.NODE_ENV === 'production') {
    if (parsed.data.ERASURE_SALT.startsWith('dev-only')) {
      throw new Error('ERASURE_SALT still holds its development default in production.');
    }
    if (parsed.data.COOKIE_DOMAIN === 'localhost') {
      throw new Error('COOKIE_DOMAIN is localhost in production; the attribution cookie will not work.');
    }
  }
  return parsed.data;
}

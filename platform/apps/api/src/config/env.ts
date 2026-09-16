import { z } from 'zod';

/**
 * The process refuses to start if the environment is wrong. A misconfigured
 * JWT secret discovered at boot is a five-second problem; discovered at 01:00
 * on a Friday it is a different kind of problem.
 */
/**
 * Treat an empty string as absent.
 *
 * .env.example ships optional keys as KEY="" so their names are discoverable,
 * and a developer filling in only the values they need leaves the rest empty.
 * zod's .optional() only applies to `undefined` — an empty string is present,
 * so it would be validated as a real value and fail. That turns "follow the
 * README" into a boot error on someone's first morning.
 */
const blankAsAbsent = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  // Supabase hands you two connection strings and using the wrong one costs an
  // afternoon: DATABASE_URL is the transaction-mode pooler (:6543), DIRECT_URL
  // is the session connection (:5432) that `prisma migrate` needs.
  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url(),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters (use 32 random bytes).'),
  JWT_SECRET_PREVIOUS: blankAsAbsent(z.string().min(32)),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(7),
  BCRYPT_COST: z.coerce.number().int().min(10).max(15).default(12),

  API_BASE_URL: z.string().url().default('http://localhost:3000'),
  DASHBOARD_ORIGIN: z.string().url().default('http://localhost:3001'),
  PUBLIC_SITE_ORIGIN: z.string().url().default('http://localhost:8080'),
  COOKIE_DOMAIN: z.string().default('localhost'),
  DEFAULT_BRANCH_ID: blankAsAbsent(z.string().uuid()),

  TZ: z.string().default('UTC'),
  WHATSAPP_NUMBER: z.string().default('971525108633'),

  ATTRIBUTION_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  GUEST_RETENTION_YEARS: z.coerce.number().int().positive().default(3),
  FINANCIAL_RETENTION_YEARS: z.coerce.number().int().positive().default(5),
  /// Never rotate: rotation orphans every already-erased guest record.
  ERASURE_SALT: z.string().min(16).default('dev-only-erasure-salt-change-me'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  SENTRY_DSN: blankAsAbsent(z.string()),
  IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().positive().default(24),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
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

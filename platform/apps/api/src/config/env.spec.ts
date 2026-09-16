import { validateEnv } from './env';

/**
 * These cases are not hypothetical: every one of them is what `.env.example`
 * actually produces when a developer copies it and fills in only the values
 * the README tells them to.
 */
const required = {
  DATABASE_URL: 'postgresql://postgres@localhost:5432/berelax',
  DIRECT_URL: 'postgresql://postgres@localhost:5432/berelax',
  JWT_SECRET: 'a'.repeat(32),
};

describe('environment validation', () => {
  it('accepts the minimum a developer must fill in', () => {
    const env = validateEnv({ ...required });
    expect(env.NODE_ENV).toBe('development');
    expect(env.BCRYPT_COST).toBe(12);
    expect(env.ATTRIBUTION_RETENTION_DAYS).toBe(90);
  });

  it('treats every empty key in .env.example as absent', () => {
    const env = validateEnv({
      ...required,
      JWT_SECRET_PREVIOUS: '',   // only set during a secret rotation
      DEFAULT_BRANCH_ID: '',
      SENTRY_DSN: '',
      // These carry defaults. An empty string must fall back to the default
      // rather than be validated as a real (and far too short) value.
      ERASURE_SALT: '',
      BCRYPT_COST: '',
      LOG_LEVEL: '',
      ATTRIBUTION_RETENTION_DAYS: '',
      COOKIE_DOMAIN: '   ',
    });
    expect(env.JWT_SECRET_PREVIOUS).toBeUndefined();
    expect(env.DEFAULT_BRANCH_ID).toBeUndefined();
    expect(env.SENTRY_DSN).toBeUndefined();
    expect(env.ERASURE_SALT).toBe('dev-only-erasure-salt-change-me');
    expect(env.BCRYPT_COST).toBe(12);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.ATTRIBUTION_RETENTION_DAYS).toBe(90);
    expect(env.COOKIE_DOMAIN).toBe('localhost');
  });

  it('boots from .env.example with only the three required values filled in', () => {
    // The literal shape of apps/api/.env.example after the README's steps.
    const fromExample: Record<string, string> = {
      DATABASE_URL: required.DATABASE_URL,
      DIRECT_URL: required.DIRECT_URL,
      JWT_SECRET: required.JWT_SECRET,
      JWT_SECRET_PREVIOUS: '', JWT_ACCESS_TTL: '15m', JWT_REFRESH_TTL_DAYS: '7',
      BCRYPT_COST: '12', NODE_ENV: 'development', PORT: '3000',
      API_BASE_URL: 'http://localhost:3000', DASHBOARD_ORIGIN: 'http://localhost:3001',
      PUBLIC_SITE_ORIGIN: 'http://localhost:8080', COOKIE_DOMAIN: 'localhost',
      DEFAULT_BRANCH_ID: '', TZ: 'UTC', WHATSAPP_NUMBER: '971525108633',
      ATTRIBUTION_RETENTION_DAYS: '90', GUEST_RETENTION_YEARS: '3',
      FINANCIAL_RETENTION_YEARS: '5', ERASURE_SALT: '', LOG_LEVEL: 'info',
      SENTRY_DSN: '', IDEMPOTENCY_TTL_HOURS: '24',
    };
    expect(() => validateEnv(fromExample)).not.toThrow();
  });

  it('still rejects a non-empty optional value that is wrong', () => {
    expect(() => validateEnv({ ...required, JWT_SECRET_PREVIOUS: 'too-short' }))
      .toThrow(/JWT_SECRET_PREVIOUS/);
    expect(() => validateEnv({ ...required, DEFAULT_BRANCH_ID: 'not-a-uuid' }))
      .toThrow(/DEFAULT_BRANCH_ID/);
  });

  it('refuses to boot without a usable JWT secret', () => {
    expect(() => validateEnv({ ...required, JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
    const { JWT_SECRET: _omitted, ...withoutSecret } = required;
    expect(() => validateEnv(withoutSecret)).toThrow(/JWT_SECRET/);
  });

  it('refuses production defaults that would silently break things', () => {
    expect(() =>
      validateEnv({ ...required, NODE_ENV: 'production', COOKIE_DOMAIN: '.berelax.ae' }),
    ).toThrow(/ERASURE_SALT/);

    // A localhost cookie domain in production means the attribution cookie
    // mirror never sets, and iOS attribution quietly disappears.
    expect(() =>
      validateEnv({
        ...required,
        NODE_ENV: 'production',
        ERASURE_SALT: 'a-real-production-salt-value',
      }),
    ).toThrow(/COOKIE_DOMAIN/);
  });
});

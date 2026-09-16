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

  it('treats the empty optional keys in .env.example as absent', () => {
    const env = validateEnv({
      ...required,
      JWT_SECRET_PREVIOUS: '',   // only set during a secret rotation
      DEFAULT_BRANCH_ID: '',
      SENTRY_DSN: '',
    });
    expect(env.JWT_SECRET_PREVIOUS).toBeUndefined();
    expect(env.DEFAULT_BRANCH_ID).toBeUndefined();
    expect(env.SENTRY_DSN).toBeUndefined();
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

import { HttpException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { RefreshToken, User } from '@prisma/client';
import { ErrorCode, UserRole } from '@berelax/contracts';
import type { ApiErrorBody } from '@berelax/contracts';
import { AuditService } from '../common/audit.service';
import type { AuthUser, RequestContext } from '../common/request-context';
import type { PrismaService } from '../prisma/prisma.service';
import type { Env } from '../config/env';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

/**
 * §6.3 is the security-critical half of this module, so rotation, reuse
 * detection and the lockout each get their own assertions rather than a
 * happy-path smoke test.
 */

const USER_ID = '0192dddd-0000-7000-8000-00000000000d';
const BRANCH_ID = '0192bbbb-0000-7000-8000-00000000000b';
const EMPLOYEE_ID = '0192cccc-0000-7000-8000-00000000000c';
const FAMILY_ID = '0192ffff-0000-7000-8000-00000000000f';
const PASSWORD = 'correct horse battery staple';
const PRESENTED = 'a-refresh-token-as-the-browser-sent-it';
const DAY_MS = 24 * 60 * 60 * 1000;

/** Cost 4: the production floor of 12 would make this file take a minute. */
function configFor(cost = 4): ConfigService<Env, true> {
  const values: Record<string, unknown> = {
    BCRYPT_COST: cost,
    JWT_SECRET: 'unit-test-secret-of-at-least-32-characters',
    JWT_ACCESS_TTL: '15m',
    JWT_REFRESH_TTL_DAYS: 7,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService<Env, true>;
}

let PASSWORD_HASH = '';
beforeAll(async () => {
  PASSWORD_HASH = await new PasswordService(configFor()).hash(PASSWORD);
});

function userFixture(overrides: Partial<User> = {}): User {
  return {
    id: USER_ID,
    branchId: BRANCH_ID,
    email: 'owner@berelax.ae',
    passwordHash: PASSWORD_HASH,
    fullName: 'Owner',
    role: UserRole.OWNER,
    isActive: true,
    mustChangePassword: false,
    lastLoginAt: null,
    failedLoginCount: 0,
    lockedUntil: null,
    passwordChangedAt: new Date('2026-01-01T00:00:00.000Z'),
    employeeId: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

function storedTokenFixture(
  overrides: Partial<RefreshToken> & { user?: User } = {},
): RefreshToken & { user: User } {
  const { user, ...rest } = overrides;
  return {
    id: 'rt-current',
    userId: USER_ID,
    familyId: FAMILY_ID,
    tokenHash: 'whatever-the-service-looks-up-is-asserted-separately',
    expiresAt: new Date(Date.now() + 6 * DAY_MS),
    revokedAt: null,
    replacedById: null,
    userAgent: null,
    ipAddress: null,
    createdAt: new Date(Date.now() - DAY_MS),
    user: user ?? userFixture(),
    ...rest,
  };
}

function actorFixture(): AuthUser {
  return {
    id: USER_ID,
    role: UserRole.OWNER,
    branchId: BRANCH_ID,
    email: 'owner@berelax.ae',
    fullName: 'Owner',
  };
}

/** Login is @Public, so the interceptor has no user to put in the context yet. */
const CTX: RequestContext = {
  requestId: 'req_01JBQ7X8',
  branchId: '',
  ipAddress: '203.0.113.7',
  userAgent: 'Mozilla/5.0 (dashboard)',
};

type Tx = {
  user: { update: jest.Mock };
  refreshToken: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
  financialAuditLog: { create: jest.Mock };
};

type PrismaMock = {
  user: { findFirst: jest.Mock };
  refreshToken: { findUnique: jest.Mock; updateMany: jest.Mock };
  $transaction: jest.Mock;
};

function setup(
  options: { user?: User | null; stored?: (RefreshToken & { user: User }) | null; cost?: number } = {},
) {
  const user = options.user === undefined ? userFixture() : options.user;
  const stored = options.stored ?? null;

  const tx: Tx = {
    user: {
      update: jest.fn(async ({ data }: { data: Partial<User> }) => ({ ...userFixture(), ...data })),
    },
    refreshToken: {
      findUnique: jest.fn().mockResolvedValue(stored),
      create: jest.fn().mockResolvedValue({ id: 'rt-next' }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
    financialAuditLog: { create: jest.fn().mockResolvedValue({}) },
  };

  const prisma: PrismaMock = {
    user: { findFirst: jest.fn().mockResolvedValue(user) },
    refreshToken: {
      findUnique: jest.fn().mockResolvedValue(stored),
      updateMany: jest.fn().mockResolvedValue({ count: 3 }),
    },
    $transaction: jest.fn(async (cb: (client: Tx) => Promise<unknown>) => cb(tx)),
  };

  const passwords = new PasswordService(configFor(options.cost));
  const tokens = new TokenService(new JwtService({}), configFor(options.cost));
  // The real AuditService, so "the audit row rides the same transaction" is
  // asserted rather than assumed.
  const service = new AuthService(
    prisma as unknown as PrismaService,
    passwords,
    tokens,
    new AuditService(),
  );

  return { service, prisma, tx, tokens, user };
}

function auditRows(tx: Tx): Record<string, unknown>[] {
  return tx.financialAuditLog.create.mock.calls.map(
    (call) => (call[0] as { data: Record<string, unknown> }).data,
  );
}

function writeArg(mock: jest.Mock, call = 0): Record<string, unknown> {
  return (mock.mock.calls[call]![0] as { data: Record<string, unknown> }).data;
}

async function caught(run: () => Promise<unknown>): Promise<{ status: number; body: ApiErrorBody }> {
  try {
    await run();
  } catch (err) {
    const http = err as HttpException;
    return { status: http.getStatus(), body: http.getResponse() as ApiErrorBody };
  }
  throw new Error('expected the call to reject, but it resolved');
}

describe('AuthService.login', () => {
  it('rejects a wrong password and counts the attempt', async () => {
    const { service, tx } = setup();

    const { status, body } = await caught(() =>
      service.login({ email: 'owner@berelax.ae', password: 'not the password' }, CTX),
    );

    expect(status).toBe(401);
    expect(body.error.code).toBe(ErrorCode.INVALID_CREDENTIALS);
    expect(writeArg(tx.user.update)).toEqual({ failedLoginCount: 1, lockedUntil: null });
    expect(auditRows(tx)[0]!.action).toBe('AUTH_LOGIN_FAILED');
    expect(tx.refreshToken.create).not.toHaveBeenCalled();
  });

  it('locks the account for fifteen minutes on the fifth failure', async () => {
    const { service, tx } = setup({ user: userFixture({ failedLoginCount: 4 }) });

    await caught(() => service.login({ email: 'owner@berelax.ae', password: 'wrong' }, CTX));

    const data = writeArg(tx.user.update) as { failedLoginCount: number; lockedUntil: Date | null };
    expect(data.failedLoginCount).toBe(5);
    const heldFor = data.lockedUntil!.getTime() - Date.now();
    expect(heldFor).toBeGreaterThan(14 * 60_000);
    expect(heldFor).toBeLessThanOrEqual(15 * 60_000);
  });

  it('turns away a locked account without writing anything', async () => {
    const lockedUntil = new Date(Date.now() + 5 * 60_000);
    const { service, prisma } = setup({ user: userFixture({ lockedUntil, failedLoginCount: 5 }) });

    const { status, body } = await caught(() =>
      service.login({ email: 'owner@berelax.ae', password: PASSWORD }, CTX),
    );

    expect(status).toBe(423);
    expect(body.error.code).toBe(ErrorCode.ACCOUNT_LOCKED);
    expect(body.error.details).toEqual({ lockedUntil: lockedUntil.toISOString() });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('starts a fresh five-attempt window once a lock has run out', async () => {
    const { service, tx } = setup({
      user: userFixture({ failedLoginCount: 5, lockedUntil: new Date(Date.now() - 60_000) }),
    });

    await caught(() => service.login({ email: 'owner@berelax.ae', password: 'wrong' }, CTX));

    expect(writeArg(tx.user.update)).toEqual({ failedLoginCount: 1, lockedUntil: null });
  });

  it('refuses a disabled account', async () => {
    const { service, prisma } = setup({ user: userFixture({ isActive: false }) });

    const { status, body } = await caught(() =>
      service.login({ email: 'owner@berelax.ae', password: PASSWORD }, CTX),
    );

    expect(status).toBe(403);
    expect(body.error.code).toBe(ErrorCode.ACCOUNT_DISABLED);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('answers an unknown email exactly as it answers a wrong password', async () => {
    const { service, prisma } = setup({ user: null });
    const unknown = await caught(() =>
      service.login({ email: 'nobody@berelax.ae', password: PASSWORD }, CTX),
    );

    const wrongPassword = await caught(() =>
      setup().service.login({ email: 'owner@berelax.ae', password: 'wrong' }, CTX),
    );

    // Byte for byte the same rejection: anything that differs is an oracle for
    // which staff addresses exist.
    expect(unknown).toEqual(wrongPassword);
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.code).toBe(ErrorCode.INVALID_CREDENTIALS);
    // Nothing is written for an account that does not exist — there is no branch
    // to file the audit row under.
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('issues a session, resets the counter and opens a new family', async () => {
    const { service, tx, tokens } = setup({
      user: userFixture({ failedLoginCount: 3, employeeId: EMPLOYEE_ID, role: UserRole.THERAPIST }),
    });

    const session = await service.login({ email: 'owner@berelax.ae', password: PASSWORD }, CTX);

    const update = writeArg(tx.user.update) as {
      failedLoginCount: number;
      lockedUntil: Date | null;
      lastLoginAt: Date;
    };
    expect(update.failedLoginCount).toBe(0);
    expect(update.lockedUntil).toBeNull();
    expect(update.lastLoginAt).toBeInstanceOf(Date);

    const created = writeArg(tx.refreshToken.create);
    expect(created.familyId).toEqual(expect.any(String));
    // Only the hash is stored; the raw token exists solely in the response.
    expect(created.tokenHash).toBe(tokens.hashRefreshToken(session.refreshToken));
    expect(created.tokenHash).not.toBe(session.refreshToken);
    expect(created).toMatchObject({ ipAddress: '203.0.113.7', userAgent: 'Mozilla/5.0 (dashboard)' });

    const payload = tokens.verifyAccess(session.accessToken);
    expect(payload).not.toBeNull();
    // Spec §6.2 lists these claims and no others.
    expect(Object.keys(payload!).sort()).toEqual(['bid', 'eid', 'exp', 'iat', 'jti', 'role', 'sub']);
    expect(payload).toMatchObject({
      sub: USER_ID,
      bid: BRANCH_ID,
      eid: EMPLOYEE_ID,
      role: UserRole.THERAPIST,
    });
    expect(session.expiresIn).toBe(15 * 60);
  });

  it('files the audit row under the branch on the user row, not the request context', async () => {
    const { service, tx } = setup();

    await service.login({ email: 'owner@berelax.ae', password: PASSWORD }, CTX);

    const row = auditRows(tx)[0]!;
    expect(row.action).toBe('AUTH_LOGIN_SUCCEEDED');
    // CTX.branchId is '' — a public route has no authenticated branch yet. §6.6.
    expect(row.branchId).toBe(BRANCH_ID);
    expect(row.actorUserId).toBe(USER_ID);
    expect(row.requestId).toBe('req_01JBQ7X8');
  });

  it('re-hashes transparently when the stored cost has fallen behind', async () => {
    const { service, tx } = setup({ cost: 6 });

    await service.login({ email: 'owner@berelax.ae', password: PASSWORD }, CTX);

    const data = writeArg(tx.user.update) as { passwordHash?: string };
    expect(data.passwordHash?.startsWith('$2b$06$')).toBe(true);
    expect(data.passwordHash).not.toBe(PASSWORD_HASH);
    // The storage changed; the password did not.
    expect(data).not.toHaveProperty('passwordChangedAt');
  });

  it('leaves the hash out of everything it returns', async () => {
    const { service } = setup();

    const session = await service.login({ email: 'owner@berelax.ae', password: PASSWORD }, CTX);

    expect(JSON.stringify(session)).not.toContain(PASSWORD_HASH);
    expect(JSON.stringify(session)).not.toContain(PASSWORD);
    expect(session.user).not.toHaveProperty('passwordHash');
  });
});

describe('AuthService.refresh — rotation and reuse detection (§6.3)', () => {
  it('looks the token up by hash, never by the value it was handed', async () => {
    const { service, tx, tokens } = setup({ stored: storedTokenFixture() });

    await service.refresh(PRESENTED, CTX);

    const where = (tx.refreshToken.findUnique.mock.calls[0]![0] as { where: unknown }).where;
    expect(where).toEqual({ tokenHash: tokens.hashRefreshToken(PRESENTED) });
  });

  it('rotates within the same family and spends the old token', async () => {
    const { service, tx, tokens } = setup({ stored: storedTokenFixture() });

    const session = await service.refresh(PRESENTED, CTX);

    const created = writeArg(tx.refreshToken.create);
    expect(created.familyId).toBe(FAMILY_ID);
    expect(created.tokenHash).toBe(tokens.hashRefreshToken(session.refreshToken));
    expect(session.refreshToken).not.toBe(PRESENTED);
    expect(tx.refreshToken.update).toHaveBeenCalledWith({
      where: { id: 'rt-current' },
      data: { revokedAt: expect.any(Date), replacedById: 'rt-next' },
    });
    expect(tokens.verifyAccess(session.accessToken)).toMatchObject({ sub: USER_ID });
  });

  it('revokes the whole family when a spent token comes back', async () => {
    const { service, tx, prisma } = setup({
      stored: storedTokenFixture({ revokedAt: new Date(Date.now() - 60_000) }),
    });

    const { status, body } = await caught(() => service.refresh(PRESENTED, CTX));

    expect(status).toBe(401);
    expect(body.error.code).toBe(ErrorCode.REFRESH_TOKEN_REUSED);
    expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { familyId: FAMILY_ID, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });

    const row = auditRows(tx)[0]!;
    expect(row.action).toBe('AUTH_REFRESH_REUSE_DETECTED');
    expect(row.entityId).toBe(USER_ID);
    expect(row.afterState).toEqual({ familyId: FAMILY_ID });

    // A stolen token buys nothing: no replacement is minted.
    expect(tx.refreshToken.create).not.toHaveBeenCalled();

    // The revocation has to survive the 401. Throwing from inside the callback
    // would roll back the very write that just closed the session down, so the
    // transaction must have committed before the exception was raised.
    await expect(prisma.$transaction.mock.results[0]!.value as Promise<unknown>).resolves.toEqual({
      reused: true,
    });
  });

  it('rejects an expired token without rotating it', async () => {
    const { service, tx } = setup({
      stored: storedTokenFixture({ expiresAt: new Date(Date.now() - DAY_MS) }),
    });

    const { status, body } = await caught(() => service.refresh(PRESENTED, CTX));

    expect(status).toBe(401);
    expect(body.error.code).toBe(ErrorCode.REFRESH_TOKEN_EXPIRED);
    expect(tx.refreshToken.create).not.toHaveBeenCalled();
    expect(tx.refreshToken.update).not.toHaveBeenCalled();
    expect(tx.refreshToken.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a token it has never seen', async () => {
    const { service, tx } = setup({ stored: null });

    const { status, body } = await caught(() => service.refresh(PRESENTED, CTX));

    expect(status).toBe(401);
    expect(body.error.code).toBe(ErrorCode.INVALID_REFRESH_TOKEN);
    expect(tx.refreshToken.create).not.toHaveBeenCalled();
  });

  it('will not refresh a session belonging to a disabled account', async () => {
    const { service, tx } = setup({
      stored: storedTokenFixture({ user: userFixture({ isActive: false }) }),
    });

    const { status, body } = await caught(() => service.refresh(PRESENTED, CTX));

    expect(status).toBe(403);
    expect(body.error.code).toBe(ErrorCode.ACCOUNT_DISABLED);
    expect(tx.refreshToken.create).not.toHaveBeenCalled();
  });
});

describe('AuthService.logout', () => {
  it('ends the whole family, not just the token in hand', async () => {
    const { service, prisma } = setup({ stored: storedTokenFixture() });

    await service.logout(PRESENTED, CTX);

    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { familyId: FAMILY_ID, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('is a no-op for an unknown or absent cookie', async () => {
    const { service, prisma } = setup({ stored: null });

    await expect(service.logout(PRESENTED, CTX)).resolves.toBeUndefined();
    await expect(service.logout(undefined, CTX)).resolves.toBeUndefined();

    expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
  });
});

describe('AuthService.changePassword', () => {
  it('will not take a new password without the current one', async () => {
    const { service, prisma } = setup();

    const { status, body } = await caught(() =>
      service.changePassword(
        actorFixture(),
        { currentPassword: 'wrong', newPassword: 'barefoot-lantern-tuesday' },
        CTX,
      ),
    );

    expect(status).toBe(401);
    expect(body.error.code).toBe(ErrorCode.INVALID_CREDENTIALS);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a password from the breach lists', async () => {
    const { service } = setup();

    const { status, body } = await caught(() =>
      service.changePassword(
        actorFixture(),
        { currentPassword: PASSWORD, newPassword: 'passwordpassword' },
        CTX,
      ),
    );

    expect(status).toBe(422);
    expect(body.error.code).toBe(ErrorCode.PASSWORD_TOO_COMMON);
  });

  it('refuses the password already in use', async () => {
    const { service } = setup();

    const { status, body } = await caught(() =>
      service.changePassword(
        actorFixture(),
        { currentPassword: PASSWORD, newPassword: PASSWORD },
        CTX,
      ),
    );

    expect(status).toBe(422);
    expect(body.error.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it('clears the flag, ends every other session and keeps the caller signed in', async () => {
    const { service, tx, tokens } = setup({ user: userFixture({ mustChangePassword: true }) });

    const session = await service.changePassword(
      actorFixture(),
      { currentPassword: PASSWORD, newPassword: 'barefoot-lantern-tuesday' },
      CTX,
    );

    const data = writeArg(tx.user.update) as { mustChangePassword: boolean; passwordChangedAt: Date };
    expect(data.mustChangePassword).toBe(false);
    expect(data.passwordChangedAt).toBeInstanceOf(Date);
    expect(data).toMatchObject({ failedLoginCount: 0, lockedUntil: null });

    // Revoke first, mint second — the other way round would kill the new token.
    expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(tx.refreshToken.updateMany.mock.invocationCallOrder[0]!).toBeLessThan(
      tx.refreshToken.create.mock.invocationCallOrder[0]!,
    );

    expect(writeArg(tx.refreshToken.create).tokenHash).toBe(
      tokens.hashRefreshToken(session.refreshToken),
    );
    expect(session.mustChangePassword).toBe(false);
    expect(auditRows(tx)[0]!.action).toBe('PASSWORD_RESET');
  });
});

describe('AuthService.revokeAllSessions', () => {
  it('revokes every live token and records who pressed the button', async () => {
    const { service, tx } = setup();

    const result = await service.revokeAllSessions(USER_ID, {
      ...CTX,
      branchId: BRANCH_ID,
      actorUserId: USER_ID,
      actorRole: UserRole.MANAGER,
    });

    expect(result).toEqual({ revoked: 2 });
    expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });

    const row = auditRows(tx)[0]!;
    expect(row.action).toBe('USER_SESSIONS_REVOKED');
    expect(row.entityId).toBe(USER_ID);
    expect(row.afterState).toEqual({ revoked: 2 });
    expect(row.actorRole).toBe(UserRole.MANAGER);
  });
});

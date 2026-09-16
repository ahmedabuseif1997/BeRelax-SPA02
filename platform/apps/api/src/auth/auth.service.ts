import {
  ForbiddenException,
  HttpException,
  Injectable,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { User } from '@prisma/client';
import { ErrorCode } from '@berelax/contracts';
import type { ChangePasswordDto, LoginDto } from '@berelax/contracts';
import { AuditAction, AuditService } from '../common/audit.service';
import type { AuthUser, RequestContext } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

/** Spec §6.1: five failures buy a fifteen-minute pause. */
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;

export interface AuthSession {
  accessToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  /** Raw refresh token. The controller puts it in the cookie; it goes nowhere else. */
  refreshToken: string;
  user: AuthUser;
  mustChangePassword: boolean;
}

/** The subset of a user row anything outside this module is allowed to see. */
type SessionUserFields = Pick<
  User,
  'id' | 'email' | 'fullName' | 'role' | 'branchId' | 'employeeId' | 'mustChangePassword'
>;

/**
 * RequestContextInterceptor stamps a context on every request. The fallbacks are
 * here so that an auth event is still auditable if a route is reached before it
 * runs — an audit log with a gap is worse than one with a synthetic request id.
 */
export function auditContext(
  ctx: RequestContext | undefined,
  actor: { id: string; role: User['role']; branchId: string },
): RequestContext {
  return {
    ...ctx,
    requestId: ctx?.requestId ?? randomUUID(),
    // Branch comes from the user row. A request body never gets a vote. Spec §6.6.
    branchId: actor.branchId,
    actorUserId: actor.id,
    actorRole: actor.role,
  };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  async login(dto: LoginDto, ctx: RequestContext): Promise<AuthSession> {
    // findFirst, not findUnique: email is unique only among rows where deleted_at
    // is null, so a soft-deleted account must not shadow a live one.
    const user = await this.prisma.user.findFirst({
      where: { email: dto.email, deletedAt: null },
    });

    // Runs on every path, including the one where no such account exists, so the
    // response time cannot be used to enumerate staff email addresses.
    const passwordMatches = await this.passwords.compareOrDummy(
      dto.password,
      user?.passwordHash ?? null,
    );

    if (!user) throw invalidCredentials();

    const now = new Date();
    if (user.lockedUntil && user.lockedUntil > now) {
      throw new HttpException(
        {
          error: {
            code: ErrorCode.ACCOUNT_LOCKED,
            message: 'Too many failed attempts. Try again in a few minutes.',
            details: { lockedUntil: user.lockedUntil.toISOString() },
          },
        },
        // 423 Locked. @nestjs/common's HttpStatus has no member for it.
        423,
      );
    }

    if (!user.isActive) throw accountDisabled();

    if (!passwordMatches) {
      await this.registerFailedAttempt(user, ctx, now);
      throw invalidCredentials();
    }

    // Transparent upgrade when BCRYPT_COST has been raised, or when a future
    // release swaps the primitive. `passwordChangedAt` is untouched: the storage
    // changed, the password did not.
    const rehashed = this.passwords.needsRehash(user.passwordHash)
      ? await this.passwords.hash(dto.password)
      : null;

    const refresh = this.tokens.issueRefreshToken(now);
    const familyId = this.tokens.newFamilyId();
    const context = auditContext(ctx, user);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          lastLoginAt: now,
          failedLoginCount: 0,
          lockedUntil: null,
          ...(rehashed ? { passwordHash: rehashed } : {}),
        },
      });
      await tx.refreshToken.create({
        data: {
          userId: user.id,
          familyId,
          tokenHash: refresh.tokenHash,
          expiresAt: refresh.expiresAt,
          userAgent: context.userAgent ?? null,
          ipAddress: context.ipAddress ?? null,
        },
      });
      await this.audit.write(tx, context, {
        action: AuditAction.AUTH_LOGIN_SUCCEEDED,
        entityType: 'User',
        entityId: user.id,
        afterState: { familyId, rehashed: rehashed !== null },
      });
    });

    return this.sessionFor(user, refresh.token);
  }

  /**
   * Rotation with reuse detection, spec §6.3. Every refresh consumes the token it
   * was given; presenting a spent one is the signature of a stolen cookie, so the
   * whole family dies and the event is recorded.
   */
  async refresh(rawToken: string, ctx: RequestContext): Promise<AuthSession> {
    const tokenHash = this.tokens.hashRefreshToken(rawToken);
    const now = new Date();

    const outcome = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.refreshToken.findUnique({
        where: { tokenHash },
        include: { user: true },
      });

      if (!existing) {
        throw new UnauthorizedException({
          error: {
            code: ErrorCode.INVALID_REFRESH_TOKEN,
            message: 'Sign in again.',
          },
        });
      }

      if (existing.revokedAt) {
        await tx.refreshToken.updateMany({
          where: { familyId: existing.familyId, revokedAt: null },
          data: { revokedAt: now },
        });
        await this.audit.write(tx, auditContext(ctx, existing.user), {
          action: AuditAction.AUTH_REFRESH_REUSE_DETECTED,
          entityType: 'User',
          entityId: existing.userId,
          afterState: { familyId: existing.familyId },
        });
        // Reported after the commit, not thrown from in here: §6.3's snippet throws
        // inside the transaction, which would roll back the revocation it just wrote.
        return { reused: true } as const;
      }

      if (existing.expiresAt < now) {
        throw new UnauthorizedException({
          error: {
            code: ErrorCode.REFRESH_TOKEN_EXPIRED,
            message: 'Your session has expired. Sign in again.',
          },
        });
      }

      if (!existing.user.isActive || existing.user.deletedAt) throw accountDisabled();

      const refresh = this.tokens.issueRefreshToken(now);
      const next = await tx.refreshToken.create({
        data: {
          userId: existing.userId,
          familyId: existing.familyId, // same lineage
          tokenHash: refresh.tokenHash,
          expiresAt: refresh.expiresAt,
          userAgent: ctx?.userAgent ?? null,
          ipAddress: ctx?.ipAddress ?? null,
        },
      });
      await tx.refreshToken.update({
        where: { id: existing.id },
        data: { revokedAt: now, replacedById: next.id },
      });

      return { reused: false, user: existing.user, rawToken: refresh.token } as const;
    });

    if (outcome.reused) {
      throw new UnauthorizedException({
        error: {
          code: ErrorCode.REFRESH_TOKEN_REUSED,
          message: 'This session was ended for your security. Sign in again.',
        },
      });
    }

    return this.sessionFor(outcome.user, outcome.rawToken);
  }

  /** Logging out ends the whole family, not just the token in hand. Spec §6.3. */
  async logout(rawToken: string | undefined, _ctx: RequestContext): Promise<void> {
    if (!rawToken) return;
    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.tokens.hashRefreshToken(rawToken) },
      select: { familyId: true },
    });
    // An unknown token is not an error: logout is idempotent, and a 404 here would
    // confirm to a guesser which tokens exist.
    if (!existing) return;
    await this.prisma.refreshToken.updateMany({
      where: { familyId: existing.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Clears `mustChangePassword` and returns a fresh session, so the first login of
   * a new account flows straight into the dashboard.
   */
  async changePassword(
    actor: AuthUser,
    dto: ChangePasswordDto,
    ctx: RequestContext,
  ): Promise<AuthSession> {
    const user = await this.prisma.user.findFirst({
      where: { id: actor.id, deletedAt: null },
    });
    if (!user) throw invalidCredentials();
    if (!user.isActive) throw accountDisabled();

    if (!(await this.passwords.compare(dto.currentPassword, user.passwordHash))) {
      throw invalidCredentials();
    }

    this.passwords.assertNotCommon(dto.newPassword);
    if (await this.passwords.compare(dto.newPassword, user.passwordHash)) {
      throw new UnprocessableEntityException({
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: 'The new password must be different from the current one.',
          details: { issues: [{ path: 'newPassword', message: 'Choose a different password.' }] },
        },
      });
    }

    const now = new Date();
    const passwordHash = await this.passwords.hash(dto.newPassword);
    const refresh = this.tokens.issueRefreshToken(now);
    const familyId = this.tokens.newFamilyId();
    const context = auditContext(ctx, user);

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          mustChangePassword: false,
          passwordChangedAt: now,
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });
      // Whoever else was holding a session may be why the password is being
      // changed. Revoke first, then mint this caller's replacement.
      await tx.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.refreshToken.create({
        data: {
          userId: user.id,
          familyId,
          tokenHash: refresh.tokenHash,
          expiresAt: refresh.expiresAt,
          userAgent: context.userAgent ?? null,
          ipAddress: context.ipAddress ?? null,
        },
      });
      await this.audit.write(tx, context, {
        action: AuditAction.PASSWORD_RESET,
        entityType: 'User',
        entityId: user.id,
        afterState: { self: true, sessionsRevoked: true },
      });
      return row;
    });

    return this.sessionFor(updated, refresh.token);
  }

  /** The button you press when a therapist's phone is lost. Spec §6.3. */
  async revokeAllSessions(userId: string, ctx: RequestContext): Promise<{ revoked: number }> {
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      });
      await this.audit.write(tx, ctx, {
        // AuditAction has no member for this yet and the column is a free-form
        // string; losing the record would be worse than the widening cast.
        action: 'USER_SESSIONS_REVOKED' as AuditAction,
        entityType: 'User',
        entityId: userId,
        afterState: { revoked: count },
      });
      return { revoked: count };
    });
  }

  /**
   * Committed on its own so the counter survives the rejection that follows —
   * a failed attempt recorded inside the transaction that throws is a failed
   * attempt that never happened.
   */
  private async registerFailedAttempt(
    user: User,
    ctx: RequestContext,
    now: Date,
  ): Promise<void> {
    // A lock that has run out starts the count again: each fifteen-minute window
    // costs five fresh mistakes, not one. The counter still only resets on success
    // within a window. Spec §6.1.
    const previous = user.lockedUntil && user.lockedUntil <= now ? 0 : user.failedLoginCount;
    const failedLoginCount = previous + 1;
    const locked = failedLoginCount >= MAX_FAILED_ATTEMPTS;
    const lockedUntil = locked ? new Date(now.getTime() + LOCK_DURATION_MS) : null;
    const context = auditContext(ctx, user);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { failedLoginCount, lockedUntil },
      });
      await this.audit.write(tx, context, {
        action: AuditAction.AUTH_LOGIN_FAILED,
        entityType: 'User',
        entityId: user.id,
        afterState: { failedLoginCount, lockedUntil: lockedUntil?.toISOString() ?? null },
      });
    });
  }

  private sessionFor(user: SessionUserFields, refreshToken: string): AuthSession {
    const { accessToken, expiresIn } = this.tokens.signAccess(user);
    return {
      accessToken,
      expiresIn,
      refreshToken,
      user: toAuthUser(user),
      mustChangePassword: user.mustChangePassword,
    };
  }
}

export function toAuthUser(user: SessionUserFields): AuthUser {
  return {
    id: user.id,
    role: user.role,
    branchId: user.branchId,
    employeeId: user.employeeId,
    email: user.email,
    fullName: user.fullName,
  };
}

function invalidCredentials(): UnauthorizedException {
  // One message for "no such account" and for "wrong password": which of the two
  // it was is exactly what an attacker is asking.
  return new UnauthorizedException({
    error: {
      code: ErrorCode.INVALID_CREDENTIALS,
      message: 'That email and password do not match.',
    },
  });
}

function accountDisabled(): ForbiddenException {
  return new ForbiddenException({
    error: {
      code: ErrorCode.ACCOUNT_DISABLED,
      message: 'This account has been disabled. Ask the owner to re-enable it.',
    },
  });
}

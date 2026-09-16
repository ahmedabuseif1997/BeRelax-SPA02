import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { UserRole } from '@prisma/client';
import type { Env } from '../config/env';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Exactly the claims in §6.2 — no issuer, no audience, nothing a verifier has to guess at. */
export interface AccessTokenPayload {
  sub: string;
  role: UserRole;
  /** Branch. Every service-layer query filters on it. */
  bid: string;
  /** Linked employee; null for everyone but a THERAPIST login. */
  eid: string | null;
  jti: string;
  iat: number;
  exp: number;
}

/** The fields of a user row an access token is built from — never the whole row. */
export interface TokenSubject {
  id: string;
  role: UserRole;
  branchId: string;
  employeeId?: string | null;
}

export interface SignedAccessToken {
  accessToken: string;
  /** Seconds, so the dashboard can schedule its refresh without decoding the JWT. */
  expiresIn: number;
  jti: string;
}

export interface IssuedRefreshToken {
  /** The only time the raw token exists outside the client. Goes straight into the cookie. */
  token: string;
  tokenHash: string;
  expiresAt: Date;
}

@Injectable()
export class TokenService {
  private readonly secret: string;
  private readonly previousSecret?: string;
  private readonly accessTtl: string;
  private readonly refreshTtlDays: number;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService<Env, true>,
  ) {
    this.secret = String(config.get('JWT_SECRET', { infer: true }));
    this.previousSecret = config.get('JWT_SECRET_PREVIOUS', { infer: true });
    this.accessTtl = String(config.get('JWT_ACCESS_TTL', { infer: true }) ?? '15m');
    this.refreshTtlDays = Number(config.get('JWT_REFRESH_TTL_DAYS', { infer: true })) || 7;
  }

  signAccess(user: TokenSubject): SignedAccessToken {
    const jti = uuidv7();
    const accessToken = this.jwt.sign(
      { sub: user.id, role: user.role, bid: user.branchId, eid: user.employeeId ?? null, jti },
      // jti lives in the payload, not options.jwtid: jsonwebtoken rejects both at once.
      { secret: this.secret, expiresIn: this.accessTtl },
    );
    const { iat, exp } = this.jwt.decode<AccessTokenPayload>(accessToken);
    return { accessToken, expiresIn: exp - iat, jti };
  }

  /**
   * Null rather than a throw: expired, forged and malformed all end as the same
   * 401, and the caller decides the wording.
   *
   * During the annual rotation both secrets verify for the 24-hour overlap, so
   * tokens signed a minute before the swap keep working. Signing only ever uses
   * the current secret. Spec §6.2.
   */
  verifyAccess(token: string): AccessTokenPayload | null {
    for (const secret of [this.secret, this.previousSecret]) {
      if (!secret) continue;
      try {
        return this.jwt.verify<AccessTokenPayload>(token, { secret });
      } catch {
        // Fall through to the previous secret; a genuine failure returns null below.
      }
    }
    return null;
  }

  /** 256 bits of opaque randomness. Only its SHA-256 is ever stored. Spec §6.2. */
  issueRefreshToken(now: Date = new Date()): IssuedRefreshToken {
    const token = randomBytes(32).toString('base64url');
    return {
      token,
      tokenHash: this.hashRefreshToken(token),
      expiresAt: new Date(now.getTime() + this.refreshTtlDays * DAY_MS),
    };
  }

  /**
   * Plain SHA-256, not bcrypt: the input is already 256 bits of uniform entropy,
   * so there is nothing for a slow KDF to protect, and the lookup is on the hot path.
   */
  hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** A rotation lineage. Every token descended from one login shares it. */
  newFamilyId(): string {
    return uuidv7();
  }
}

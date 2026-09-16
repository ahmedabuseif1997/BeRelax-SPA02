import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ErrorCode } from '@berelax/contracts';
import { IS_PUBLIC_KEY } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { TokenService } from './token.service';

/**
 * The one exemption from the `mustChangePassword` lockout, so a user who has to
 * set a password has somewhere to set it. Spec §6.1.
 */
export const ALLOW_PASSWORD_CHANGE = 'allowPasswordChange';
export const AllowPasswordChange = () => SetMetadata(ALLOW_PASSWORD_CHANGE, true);

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const token = bearerToken(request.headers.authorization);
    if (!token) throw unauthenticated('This endpoint needs an access token.');

    const payload = this.tokens.verifyAccess(token);
    if (!payload) throw unauthenticated('Your session has expired. Sign in again.');

    // The claims are up to fifteen minutes stale, so role, branch and account state
    // are read from the row: a demotion or a disable takes effect on the next
    // request rather than whenever the token happens to run out.
    const user = await this.prisma.user.findFirst({
      where: { id: payload.sub, deletedAt: null },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        branchId: true,
        employeeId: true,
        isActive: true,
        mustChangePassword: true,
        passwordChangedAt: true,
      },
    });

    if (!user) throw unauthenticated('Sign in again.');
    if (!user.isActive) {
      throw new ForbiddenException({
        error: {
          code: ErrorCode.ACCOUNT_DISABLED,
          message: 'This account has been disabled.',
        },
      });
    }

    // Access tokens are not revocable (§6.2), but a password change is the one
    // event that must not leave the old ones usable: it is what you do after a
    // phone goes missing. `iat` is whole seconds, so this is a strict comparison.
    if (payload.iat < Math.floor(user.passwordChangedAt.getTime() / 1000)) {
      throw unauthenticated('Your password changed. Sign in again.');
    }

    const allowsPasswordChange =
      this.reflector.getAllAndOverride<boolean>(ALLOW_PASSWORD_CHANGE, targets) ?? false;
    if (user.mustChangePassword && !allowsPasswordChange) {
      throw new ForbiddenException({
        error: {
          code: ErrorCode.PASSWORD_CHANGE_REQUIRED,
          message: 'Set a new password before using the dashboard.',
        },
      });
    }

    request.user = {
      id: user.id,
      role: user.role,
      branchId: user.branchId,
      employeeId: user.employeeId,
      email: user.email,
      fullName: user.fullName,
    };
    return true;
  }
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (!value || scheme?.toLowerCase() !== 'bearer') return null;
  return value.trim() || null;
}

/** Expired, forged and absent all read the same from outside. */
function unauthenticated(message: string): UnauthorizedException {
  return new UnauthorizedException({
    error: { code: ErrorCode.INVALID_CREDENTIALS, message },
  });
}

import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ErrorCode, UserRole } from '@berelax/contracts';
import { ROLES_KEY } from '../common/decorators';

/**
 * Runs after JwtAuthGuard, which is what puts `user` on the request. Spec §6.5.
 * Handler metadata overrides controller metadata, so a single endpoint can widen
 * or narrow the rule its controller sets.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;

    const { user } = context.switchToHttp().getRequest<Request>();
    if (!user) throw new UnauthorizedException();
    if (!required.includes(user.role)) {
      throw new ForbiddenException({
        error: {
          code: ErrorCode.INSUFFICIENT_ROLE,
          message: 'Your account cannot perform this action.',
        },
      });
    }
    return true;
  }
}

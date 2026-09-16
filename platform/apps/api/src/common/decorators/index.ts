import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import { UserRole } from '@prisma/client';
import type { AuthUser, RequestContext } from '../request-context';

/** Opt an endpoint out of the global JwtAuthGuard. */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Restrict an endpoint (or a whole controller) to the listed roles. */
export const ROLES_KEY = 'roles';
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

/** Mark a money-moving endpoint as requiring an Idempotency-Key header. */
export const IDEMPOTENT_KEY = 'idempotent';
export const Idempotent = () => SetMetadata(IDEMPOTENT_KEY, true);

export const CurrentUser = createParamDecorator(
  (data: keyof AuthUser | undefined, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<Request>();
    return data ? req.user?.[data] : req.user;
  },
);

export const Ctx = createParamDecorator((_d: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<Request>().ctx as RequestContext;
});

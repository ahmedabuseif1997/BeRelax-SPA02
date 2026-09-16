import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { Observable } from 'rxjs';
import type { RequestContext } from './request-context';

/**
 * Assembles the audit context once per request. Every money-affecting write
 * threads this through, which is how "who did this, from where, on which
 * request" ends up in financial_audit_log without a developer remembering to
 * put it there.
 */
@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const requestId = (req.header('x-request-id') ?? `req_${randomUUID()}`).slice(0, 64);

    const ctx: RequestContext = {
      requestId,
      // Populated by JwtAuthGuard, which runs before this for guarded routes.
      branchId: req.user?.branchId ?? '',
      actorUserId: req.user?.id,
      actorRole: req.user?.role,
      ipAddress: clientIp(req),
      userAgent: req.header('user-agent')?.slice(0, 300),
      idempotencyKey: req.header('idempotency-key')?.slice(0, 200),
    };

    req.ctx = ctx;
    context.switchToHttp().getResponse<{ setHeader(k: string, v: string): void }>()
      .setHeader('x-request-id', requestId);

    return next.handle();
  }
}

/** Behind Railway/Render/Cloudflare the socket address is the proxy, not the guest. */
function clientIp(req: Request): string | undefined {
  const forwarded = req.header('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim();
  return req.socket.remoteAddress ?? undefined;
}

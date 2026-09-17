import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { Observable } from 'rxjs';
import { requestBindings } from './logger';
import { clientIp, resolveRequestId } from './request-context';
import type { RequestContext } from './request-context';

/**
 * Assembles the audit context once per request. Every money-affecting write
 * threads this through, which is how "who did this, from where, on which
 * request" ends up in financial_audit_log without a developer remembering to
 * put it there.
 *
 * It is also where the log lines pick up who is calling: this is the first
 * point in the Nest pipeline at which both `req.user` (set by JwtAuthGuard) and
 * `req.route` exist, so §12.3's `userId`, `role`, `branchId` and `route` are
 * bound onto the request logger here and carried by every line that follows.
 */
@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  constructor(private readonly logger: PinoLogger) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const requestId = resolveRequestId(req);

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
    this.bindLogContext(req);
    context.switchToHttp().getResponse<{ setHeader(k: string, v: string): void }>()
      .setHeader('x-request-id', requestId);

    return next.handle();
  }

  /**
   * `assign` throws outside a request scope, and a request must never fail
   * because of something that only exists to describe it. Swallowed here and
   * nowhere else.
   */
  private bindLogContext(req: Request): void {
    try {
      this.logger.assign(requestBindings(req));
    } catch {
      /* no request-scoped logger — the line still carries requestId */
    }
  }
}

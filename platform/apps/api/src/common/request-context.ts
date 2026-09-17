import { randomUUID } from 'node:crypto';
import { UserRole } from '@prisma/client';

/** The authenticated caller, decoded from the access token. */
export interface AuthUser {
  id: string;
  role: UserRole;
  /** Branch from the TOKEN. Never from a request body — that is the whole point. */
  branchId: string;
  /** Linked employee, present only for THERAPIST logins. */
  employeeId?: string | null;
  email: string;
  fullName: string;
}

/**
 * Everything the audit log needs about *who did this and from where*, assembled
 * once per request by RequestContextInterceptor and threaded through the
 * service layer. Auditing is infrastructure, not something a developer
 * remembers to do.
 */
export interface RequestContext {
  requestId: string;
  branchId: string;
  actorUserId?: string;
  actorRole?: UserRole;
  ipAddress?: string;
  userAgent?: string;
  idempotencyKey?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      ctx?: RequestContext;
    }
  }
}

/** The minimum of an incoming request these helpers need. */
interface RequestLike {
  id?: unknown;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | undefined };
}

/**
 * The ONE request id.
 *
 * `pino-http` runs as middleware, which in Nest is before every guard,
 * interceptor and filter, so on a real request the id already exists by the
 * time RequestContextInterceptor asks for it. Minting a second one here would
 * give the log lines one id and `financial_audit_log` another, and §3.6 promises
 * the caller that the `requestId` in the error body is the one to quote.
 *
 * Outside an HTTP request — a unit test, a cron job — nothing has been minted
 * yet and this is the mint.
 */
export function resolveRequestId(req: RequestLike): string {
  const existing = req.id;
  if (typeof existing === 'string' && existing.length > 0) return existing;
  return (header(req, 'x-request-id') ?? `req_${randomUUID()}`).slice(0, 64);
}

/** Behind Railway/Render/Cloudflare the socket address is the proxy, not the guest. */
export function clientIp(req: RequestLike): string | undefined {
  const forwarded = header(req, 'x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim();
  return req.socket?.remoteAddress ?? undefined;
}

function header(req: RequestLike, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

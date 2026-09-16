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

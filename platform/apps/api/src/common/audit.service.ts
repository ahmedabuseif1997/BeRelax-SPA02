import { Injectable } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import type { RequestContext } from './request-context';

/** The money-affecting actions this system records. Spec §9.6. */
export const AuditAction = {
  RESERVATION_CREATED: 'RESERVATION_CREATED',
  RESERVATION_RESCHEDULED: 'RESERVATION_RESCHEDULED',
  RESERVATION_CHECK_IN: 'RESERVATION_CHECK_IN',
  RESERVATION_CHECKOUT: 'RESERVATION_CHECKOUT',
  RESERVATION_CANCELLED: 'RESERVATION_CANCELLED',
  RESERVATION_NO_SHOW: 'RESERVATION_NO_SHOW',
  PAYMENT_REFUNDED: 'PAYMENT_REFUNDED',
  PAYMENT_ADJUSTED: 'PAYMENT_ADJUSTED',
  TIP_REVERSED: 'TIP_REVERSED',
  PAYOUT_CREATED: 'PAYOUT_CREATED',
  PAYOUT_ACKNOWLEDGED: 'PAYOUT_ACKNOWLEDGED',
  SERVICE_PRICE_CHANGED: 'SERVICE_PRICE_CHANGED',
  EMPLOYEE_COMMISSION_CHANGED: 'EMPLOYEE_COMMISSION_CHANGED',
  USER_CREATED: 'USER_CREATED',
  USER_ROLE_CHANGED: 'USER_ROLE_CHANGED',
  USER_DISABLED: 'USER_DISABLED',
  USER_SESSIONS_REVOKED: 'USER_SESSIONS_REVOKED',
  PASSWORD_RESET: 'PASSWORD_RESET',
  AUTH_LOGIN_SUCCEEDED: 'AUTH_LOGIN_SUCCEEDED',
  AUTH_LOGIN_FAILED: 'AUTH_LOGIN_FAILED',
  AUTH_REFRESH_REUSE_DETECTED: 'AUTH_REFRESH_REUSE_DETECTED',
  GUEST_DATA_EXPORTED: 'GUEST_DATA_EXPORTED',
  GUEST_ERASED: 'GUEST_ERASED',
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

export interface AuditEntryInput {
  action: AuditAction;
  entityType: string;
  entityId: string;
  beforeState?: unknown;
  afterState?: unknown;
  amountFils?: number;
}

@Injectable()
export class AuditService {
  /**
   * ALWAYS called with the same transaction client as the write it records, so
   * that if the business write rolls back the audit row goes with it. An audit
   * log containing entries for transactions that never happened is worse than
   * no audit log, because you would believe it.
   */
  async write(
    tx: Prisma.TransactionClient,
    ctx: RequestContext,
    entry: AuditEntryInput,
  ): Promise<void> {
    await tx.financialAuditLog.create({
      data: {
        branchId: ctx.branchId,
        actorUserId: ctx.actorUserId ?? null,
        actorRole: (ctx.actorRole as UserRole | undefined) ?? null,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        beforeState: toJson(entry.beforeState),
        afterState: toJson(entry.afterState),
        amountFils: entry.amountFils ?? null,
        ipAddress: ctx.ipAddress ?? null,
        userAgent: ctx.userAgent ?? null,
        requestId: ctx.requestId,
      },
    });
  }
}

function toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === undefined || value === null) return Prisma.JsonNull;
  return value as Prisma.InputJsonValue;
}

/**
 * The audit log records WHAT CHANGED ABOUT THE MONEY, not a second copy of the
 * guest database. IDs, amounts, statuses and timestamps only — never a name,
 * phone number or email.
 */
const PII_FIELDS = new Set(['fullName', 'guestName', 'phone', 'guestPhone', 'email',
  'guestEmail', 'legalName', 'notes', 'passwordHash', 'tokenHash']);

export function pickAuditFields<T extends object>(row: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (PII_FIELDS.has(k)) continue;
    if (v instanceof Date) out[k] = v.toISOString();
    else if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v;
  }
  return out;
}

import { Injectable } from '@nestjs/common';
import { FinancialAuditLog, Prisma, UserRole } from '@prisma/client';
import { AuditQuery, businessDayBounds } from '@berelax/contracts';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../common/request-context';
import { resolveTradingWindow, shiftTradingDay } from './money.support';

/** Used only when a caller gives one end of a date range and not the other. */
export const AUDIT_DEFAULT_SPAN_DAYS = 90;

export interface AuditEntryView {
  id: string;
  createdAt: string;
  action: string;
  /**
   * The ANCHOR the money hangs off, not the row type: every payment, tip and
   * accrual is recorded against its `Reservation`, and a payout against its
   * `PayoutBatch`. The specific row ids are in `beforeState`/`afterState`.
   * §9.6, §13.3 invariant 7.
   */
  entityType: string;
  entityId: string;
  actor: { id: string; role: UserRole | null; fullName: string | null } | null;
  amountFils: number | null;
  beforeState: unknown;
  afterState: unknown;
  /** Present in every log line for that request, which is how you follow it. §3.6. */
  requestId: string;
  ipAddress: string | null;
}

export interface AuditSearchView {
  total: number;
  limit: number;
  offset: number;
  entries: AuditEntryView[];
}

/**
 * What a manager opens during a dispute. §9.7.
 *
 * Read-only by construction: `financial_audit_log` has no update or delete path
 * anywhere in this application, and the database refuses both outright (§5.4).
 * During a breach this is the only record you can still trust, which is exactly
 * why nothing here writes.
 */
@Injectable()
export class AuditQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async find(query: AuditQuery, actor: AuthUser): Promise<AuditSearchView> {
    const where: Prisma.FinancialAuditLogWhereInput = { branchId: actor.branchId };
    if (query.entityType) where.entityType = query.entityType;
    if (query.entityId) where.entityId = query.entityId;
    if (query.actorUserId) where.actorUserId = query.actorUserId;
    if (query.action) where.action = query.action;

    // A range is applied only when one is asked for: looking a booking up by id
    // should return its whole history, not the last quarter of it. Given one
    // end, the other is filled in — in TRADING days, so "16 September" covers
    // the 01:30 tip that belongs to that night. §3.3.
    if (query.from ?? query.to) {
      const { from, to } = resolveTradingWindow(query, (end) =>
        shiftTradingDay(end, -AUDIT_DEFAULT_SPAN_DAYS),
      );
      where.createdAt = { gte: businessDayBounds(from).start, lt: businessDayBounds(to).end };
    }

    const total = await this.prisma.financialAuditLog.count({ where });
    const rows = await this.prisma.financialAuditLog.findMany({
      where,
      // Newest first: a dispute starts from what just happened and works back.
      // `id` breaks the tie because UUID v7 is time-ordered, so two rows written
      // in the same transaction still come back in the order they were written.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit,
      skip: query.offset,
    });

    const names = await this.actorNames(rows, actor.branchId);
    return {
      total,
      limit: query.limit,
      offset: query.offset,
      entries: rows.map((row) => presentAuditEntry(row, names)),
    };
  }

  /**
   * "Who did this" is a name in an argument, not a UUID. The log deliberately
   * stores only the id — a user renamed later must not rewrite history — so the
   * name is resolved at read time, once for the whole page.
   */
  private async actorNames(
    rows: FinancialAuditLog[],
    branchId: string,
  ): Promise<Map<string, string>> {
    const ids = [...new Set(rows.map((row) => row.actorUserId).filter(isPresent))];
    if (ids.length === 0) return new Map();

    const users = await this.prisma.user.findMany({
      where: { id: { in: ids }, branchId },
      select: { id: true, fullName: true },
    });
    return new Map(users.map((user) => [user.id, user.fullName]));
  }
}

function isPresent(id: string | null): id is string {
  return id !== null;
}

function presentAuditEntry(
  row: FinancialAuditLog,
  names: Map<string, string>,
): AuditEntryView {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    actor: row.actorUserId
      ? {
          id: row.actorUserId,
          role: row.actorRole,
          fullName: names.get(row.actorUserId) ?? null,
        }
      : null,
    amountFils: row.amountFils,
    beforeState: row.beforeState,
    afterState: row.afterState,
    requestId: row.requestId,
    ipAddress: row.ipAddress,
  };
}

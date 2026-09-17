import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RetentionRunDto, ErrorCode } from '@berelax/contracts';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser, RequestContext } from '../common/request-context';
import { apiError } from '../reservations/reservations.service';
import { GuestErasureService } from './guest-erasure.service';

/* ───────────────────────── the report ───────────────────────── */

export interface AttributionPruneReport {
  retentionDays: number;
  /** Snapshots whose identifiers were stripped on this run. §5.6. */
  snapshotsPruned: number;
  outboundClicksDeleted: number;
  idempotencyRecordsDeleted: number;
  /** Revoked or expired refresh tokens past their 30-day tail. §11.6. */
  refreshTokensDeleted: number;
}

export interface GuestRetentionReport {
  retentionYears: number;
  /** Nothing whose last visit is on or after this day is touched. */
  cutoff: string;
  /** Guests past the window that this run considered. */
  candidates: number;
  anonymised: number;
  /** Candidates left for the next run because `limit` was reached. */
  remaining: number;
  /** Anonymisations that failed. An empty array is the normal outcome. */
  failures: Array<{ guestId: string; code: string }>;
  guestIds: string[];
}

export interface RetentionRunReport {
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  branchId: string;
  attribution: AttributionPruneReport;
  guests: GuestRetentionReport;
}

/* ───────────────────────── the service ───────────────────────── */

/**
 * The retention schedule of §11.6, made to actually happen.
 *
 * Two halves, for two reasons:
 *
 *   ATTRIBUTION runs INSIDE the database, as `prune_attribution()` (§5.6). It is
 *   a bulk update over rows nobody is named on, it has no audit entry to write,
 *   and it must keep running whether or not the API is deployed — so it is
 *   scheduled with `pg_cron` and this endpoint only calls the same function on
 *   demand. There is one definition of pruning and it lives in SQL.
 *
 *   GUEST IDENTITY runs in the APPLICATION, through GuestErasureService, because
 *   anonymising a guest writes a `GUEST_ERASED` audit row with an actor, severs
 *   attribution and rewrites the enquiry inbox — none of which belongs in a cron
 *   job's SQL, and all of which must be identical to what the erasure endpoint
 *   does. §11.4 and §11.6 must not be able to disagree about what "erased" means,
 *   so there is exactly ONE code path and this calls it.
 *
 * Deleting nothing is a normal outcome. A run that reports zero is a run that
 * proves the window is not yet reached, and that is worth having on the record.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);
  private readonly attributionRetentionDays: number;
  private readonly guestRetentionYears: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly erasure: GuestErasureService,
    config: ConfigService,
  ) {
    // From configuration, never from the request body: the published register
    // states these periods, and an endpoint that lets a caller shorten them is
    // an endpoint that makes the register a lie. §11.6.
    this.attributionRetentionDays = Number(config.get('ATTRIBUTION_RETENTION_DAYS') ?? 90);
    this.guestRetentionYears = Number(config.get('GUEST_RETENTION_YEARS') ?? 3);
  }

  async run(
    dto: RetentionRunDto,
    actor: AuthUser,
    ctx: RequestContext,
    now: Date = new Date(),
  ): Promise<RetentionRunReport> {
    const startedAt = now;
    const attribution = await this.pruneAttribution(dto.dryRun, now);
    const guests = await this.anonymiseLapsedGuests(dto, actor, ctx, now);

    this.logger.log(
      `${dto.dryRun ? 'Retention DRY RUN' : 'Retention run'}: ` +
        `${attribution.snapshotsPruned} attribution snapshots, ${guests.anonymised} guests anonymised`,
    );

    return {
      dryRun: dto.dryRun,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      branchId: actor.branchId,
      attribution,
      guests,
    };
  }

  /**
   * §5.6, called rather than reimplemented. The function strips the identifying
   * fields from snapshots past the window, keeps the channel aggregates the ROI
   * report reads, and clears the click log, the spent idempotency keys and the
   * dead refresh tokens in the same pass.
   *
   * It returns only the snapshot count, so the other three are reported by
   * counting what was still due before and after — which also means a dry run and
   * a real run answer the same question in the same way.
   */
  async pruneAttribution(dryRun: boolean, now: Date = new Date()): Promise<AttributionPruneReport> {
    const days = this.attributionRetentionDays;
    const before = await this.countDue(now, days);

    if (dryRun) {
      return {
        retentionDays: days,
        snapshotsPruned: before.snapshots,
        outboundClicksDeleted: before.clicks,
        idempotencyRecordsDeleted: before.idempotency,
        refreshTokensDeleted: before.refreshTokens,
      };
    }

    await this.assertPruneFunctionInstalled();
    const [row] = await this.prisma.$queryRaw<Array<{ pruned: number }>>`
      SELECT prune_attribution(${days}::int) AS pruned`;
    const after = await this.countDue(now, days);

    return {
      retentionDays: days,
      snapshotsPruned: Number(row?.pruned ?? 0),
      outboundClicksDeleted: Math.max(0, before.clicks - after.clicks),
      idempotencyRecordsDeleted: Math.max(0, before.idempotency - after.idempotency),
      refreshTokensDeleted: Math.max(0, before.refreshTokens - after.refreshTokens),
    };
  }

  /**
   * Guest identity is kept for three years after the last visit, then the row is
   * anonymised — by the same method the erasure endpoint calls, with the same
   * audit entry, so a retention anonymisation and a requested one are the same
   * event with a different reason. §11.6.
   *
   * "Last visit" is the latest reservation the guest holds, PAST OR FUTURE: a
   * booking next month is a live relationship, however long ago they last came
   * in. A guest with no reservations at all falls back to when the record was
   * created, which catches the walk-in whose booking was never completed.
   *
   * One guest, one transaction. A single failure — a guest erased by a manager a
   * second before the job reached them — is recorded and stepped over rather than
   * abandoning the other four hundred.
   */
  async anonymiseLapsedGuests(
    dto: RetentionRunDto,
    actor: AuthUser,
    ctx: RequestContext,
    now: Date = new Date(),
  ): Promise<GuestRetentionReport> {
    const years = this.guestRetentionYears;
    const cutoff = new Date(now);
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);

    const where = {
      // §6.6: the branch comes from the token, so a multi-branch deployment runs
      // this once per branch rather than reaching across them from one session.
      branchId: actor.branchId,
      anonymisedAt: null,
      deletedAt: null,
      createdAt: { lt: cutoff },
      reservations: { none: { startsAt: { gte: cutoff } } },
    } as const;

    const candidates = await this.prisma.guest.count({ where });
    const due = await this.prisma.guest.findMany({
      where,
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: dto.limit,
    });

    const report: GuestRetentionReport = {
      retentionYears: years,
      cutoff: cutoff.toISOString(),
      candidates,
      anonymised: 0,
      remaining: Math.max(0, candidates - due.length),
      failures: [],
      guestIds: due.map((g) => g.id),
    };
    if (dto.dryRun) return report;

    const reason = `Retention: no visit in ${years} year${years === 1 ? '' : 's'} (PDPL §11.6)`;
    for (const guest of due) {
      try {
        await this.erasure.erase(guest.id, reason, actor, ctx);
        report.anonymised += 1;
      } catch (error) {
        report.failures.push({ guestId: guest.id, code: errorCodeOf(error) });
        this.logger.warn(`Retention could not anonymise guest ${guest.id}: ${String(error)}`);
      }
    }
    return report;
  }

  /** What is past the window right now, per table. The same shape before and after. */
  private async countDue(
    now: Date,
    days: number,
  ): Promise<{ snapshots: number; clicks: number; idempotency: number; refreshTokens: number }> {
    const cutoff = new Date(now.getTime() - days * 86_400_000);
    // 30 days is the tail §11.6 gives a revoked or expired refresh token, and it
    // is the interval hard-coded in `prune_attribution()` — read the same way
    // here so the report cannot claim a deletion the function did not make.
    const tokenCutoff = new Date(cutoff.getTime());
    tokenCutoff.setTime(now.getTime() - 30 * 86_400_000);

    const [snapshots, clicks, idempotency, refreshTokens] = await Promise.all([
      this.prisma.attributionSnapshot.count({
        where: { prunedAt: null, capturedAt: { lt: cutoff } },
      }),
      this.prisma.outboundClick.count({ where: { createdAt: { lt: cutoff } } }),
      this.prisma.idempotencyRecord.count({ where: { expiresAt: { lt: now } } }),
      this.prisma.refreshToken.count({ where: { expiresAt: { lt: tokenCutoff } } }),
    ]);
    return { snapshots, clicks, idempotency, refreshTokens };
  }

  /**
   * A missing function means the §5.6 migration never ran on this database, and
   * the difference between "nothing was due" and "nothing can ever be pruned" is
   * the difference between a compliant system and one that only looks compliant.
   * Say so in a code the dashboard can switch on, not in a Postgres error.
   */
  private async assertPruneFunctionInstalled(): Promise<void> {
    const [row] = await this.prisma.$queryRaw<Array<{ installed: boolean }>>`
      SELECT to_regprocedure('prune_attribution(int)') IS NOT NULL AS installed`;
    if (row?.installed) return;

    throw new ServiceUnavailableException(
      apiError(
        ErrorCode.RETENTION_FUNCTION_MISSING,
        'prune_attribution() is not installed on this database. Apply the retention migration before running the job.',
      ),
    );
  }
}

/** The stable code out of an ApiErrorBody, for the failure list. */
function errorCodeOf(error: unknown): string {
  const body = (error as { response?: { error?: { code?: string } } } | null)?.response?.error;
  return body?.code ?? ErrorCode.INTERNAL_ERROR;
}

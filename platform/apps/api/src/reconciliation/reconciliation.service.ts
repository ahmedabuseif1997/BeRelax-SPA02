import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  RECONCILIATION_STREAK_REQUIRED,
  ReconciliationVerdict,
  businessDay,
  type ReconciliationHistoryQuery,
  type SubmitReconciliationDto,
} from '@berelax/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { AuditAction, AuditService } from '../common/audit.service';
import type { AuthUser, RequestContext } from '../common/request-context';
import { businessDayColumn, tradingDayOf } from '../payments/money.support';
import { resolveReportWindow, shiftTradingDay } from '../reports/reports.support';
import { DailyReportService } from '../reports/daily-report.service';
import { systemFiguresFrom } from './close-out-sheet.service';
import { ReconciliationConfig } from './reconciliation.config';
import {
  assertNightHasHappened,
  compareNight,
  computeStreak,
  isMatch,
  type ComparisonResult,
  type NightVerdict,
  type ReconciliationLine,
  type StreakView,
  type SystemNightFigures,
} from './reconciliation.support';

/**
 * How far back the streak is counted. A pilot is two weeks (§14); a quarter is
 * a generous ceiling that keeps the query bounded on a branch that has been
 * reconciling nightly for a year.
 */
const STREAK_LOOKBACK_NIGHTS = 120;

/**
 * The nightly reconciliation of the parallel pilot. §14, Phase 7.
 *
 * Two weeks of running this system beside reception's paper, reconciled every
 * night, switching over only when the numbers match for five consecutive
 * nights. This service is the third of those clauses made checkable.
 *
 * THE SYSTEM SIDE IS NEVER COMPUTED HERE. Every figure comes off
 * `DailyReportService` — the same close-out the business already reads at
 * 02:00 — because a reconciliation tool with its own idea of what the spa took
 * last night is the thing that will need reconciling. When a figure was
 * missing, it was added THERE (`cardTerminal`, `closeOutDetail`) and this
 * module reads it.
 *
 * WHAT IS WRITTEN IS A RECORD, NOT A VIEW. The comparison is snapshotted into
 * the row: the paper figures, the system figures as they stood, the variance,
 * the tolerance in force, and the full line-by-line list exactly as it was
 * presented. A refund filed on Thursday against Tuesday's payment legitimately
 * moves Tuesday's live total; it must not silently un-match a night somebody
 * signed off on Tuesday, and it must not change the streak underneath them.
 *
 * A VARIANCE IS A FINDING, NOT AN ERROR. Nothing here refuses a submission
 * because the figures disagree — disagreement is the output. §15.4 is explicit
 * that cash is trust with a paper trail: the trail is this table, the variance
 * recorded and attributed to whoever was taking money at the desk.
 */
@Injectable()
export class ReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dailyReport: DailyReportService,
    private readonly config: ReconciliationConfig,
    private readonly audit: AuditService,
  ) {}

  /* ───────────────────────── submit ───────────────────────── */

  async submit(
    day: string,
    dto: SubmitReconciliationDto,
    actor: AuthUser,
    ctx: RequestContext,
  ): Promise<ReconciliationResultView> {
    assertNightHasHappened(day, businessDay(new Date()));

    const report = await this.dailyReport.daily({ businessDay: day }, actor);
    const detail = await this.dailyReport.closeOutDetail({ businessDay: day }, actor);
    const system = systemFiguresFrom(report);

    const comparison = compareNight({
      system,
      paper: dto,
      cashToleranceFils: this.config.cashToleranceFils,
    });

    const record = await this.prisma.$transaction(async (tx) => {
      // The submission this one corrects, if the night has been reconciled
      // before. Read inside the transaction so a correction filed while another
      // is in flight still names a real predecessor; if two race, both are
      // kept and the later one is the effective verdict. Nothing is overwritten
      // either way — that is the whole point of the table being append-only.
      const previous = await tx.nightlyReconciliation.findFirst({
        where: { branchId: actor.branchId, businessDay: businessDayColumn(day) },
        orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });

      const created = await tx.nightlyReconciliation.create({
        data: {
          branchId: actor.branchId,
          businessDay: businessDayColumn(day),
          verdict: comparison.verdict,

          countedCashFils: dto.countedCashFils,
          paperBookings: dto.paperBookings,
          paperCardTotalFils: dto.paperCardTotalFils,
          paperTipsCashFils: dto.paperTipsCashFils ?? null,

          systemCashFils: system.cashFils,
          systemBookings: system.bookings,
          systemCardTotalFils: system.cardFils,
          systemTipsCashFils: system.tipsDirectCashFils,

          cashVarianceFils: dto.countedCashFils - system.cashFils,
          bookingsVariance: dto.paperBookings - system.bookings,
          cardVarianceFils: dto.paperCardTotalFils - system.cardFils,
          tipsCashVarianceFils:
            dto.paperTipsCashFils === undefined
              ? null
              : dto.paperTipsCashFils - system.tipsDirectCashFils,

          cashToleranceFils: this.config.cashToleranceFils,
          openSessions: system.openSessions,
          lines: comparison.lines as unknown as Prisma.InputJsonValue,
          // §15.4: attributed to the user on shift. Whoever actually took cash
          // at the desk, not whoever happens to be signing the night off.
          cashDeskUserIds: detail.cashDesk.map((entry) => entry.userId),
          note: dto.note ?? null,
          submittedByUserId: actor.id,
          supersedesId: previous?.id ?? null,
        },
      });

      // Same transaction as the write it records, so a rolled-back submission
      // takes its audit row with it. An audit log holding entries for things
      // that never happened is worse than none, because you would believe it.
      await this.audit.write(tx, ctx, {
        action: AuditAction.RECONCILIATION_SUBMITTED,
        entityType: 'NightlyReconciliation',
        entityId: created.id,
        // No `beforeState`: nothing was changed. The predecessor is named so a
        // correction chain can be walked without reading the table.
        afterState: {
          businessDay: day,
          verdict: created.verdict,
          cashVarianceFils: created.cashVarianceFils,
          cardVarianceFils: created.cardVarianceFils,
          bookingsVariance: created.bookingsVariance,
          tipsCashVarianceFils: created.tipsCashVarianceFils,
          cashToleranceFils: created.cashToleranceFils,
          openSessions: created.openSessions,
          supersedesId: created.supersedesId,
          cashDeskUserIds: created.cashDeskUserIds,
        },
        // The number a manager searches the audit log for after a bad night.
        amountFils: created.cashVarianceFils,
      });

      return created;
    });

    const streak = await this.streak(actor);

    return {
      ...presentRecord(record, true),
      lines: comparison.lines,
      failing: comparison.failing,
      system,
      streak,
    };
  }

  /* ───────────────────────── history ───────────────────────── */

  /**
   * Every submission in the window, newest first — corrections included, and
   * marked as such.
   *
   * A correction is shown beside the attempt it replaced rather than in place
   * of it, because "we reconciled Friday three times before it matched" is
   * exactly the kind of thing two weeks of parallel running exist to surface,
   * and a history that quietly showed only the last attempt would hide it.
   */
  async history(
    query: ReconciliationHistoryQuery,
    actor: AuthUser,
  ): Promise<ReconciliationHistoryView> {
    const window = resolveReportWindow(query);

    const rows = await this.prisma.nightlyReconciliation.findMany({
      where: {
        branchId: actor.branchId,
        businessDay: {
          gte: businessDayColumn(window.from),
          lte: businessDayColumn(window.to),
        },
      },
      orderBy: [{ businessDay: 'desc' }, { submittedAt: 'desc' }, { id: 'desc' }],
    });

    const latestPerNight = new Set(latestIdPerNight(rows));

    return {
      from: window.from,
      to: window.to,
      submissions: rows.length,
      nightsReconciled: latestPerNight.size,
      entries: rows.map((row) => presentRecord(row, latestPerNight.has(row.id))),
    };
  }

  /* ───────────────────────── the streak ───────────────────────── */

  /**
   * The only question the pilot actually asks: how many consecutive nights have
   * matched, and is it five yet?
   *
   * Each night counts once, at its MOST RECENT submission. A night that was
   * reconciled, found wrong, fixed and reconciled again matched in the end —
   * that is what "the numbers match" means, and refusing to let a corrected
   * night count would make the tool punish people for using it properly. What
   * the correction cannot do is disappear: every attempt stays in the history.
   */
  async streak(actor: AuthUser): Promise<StreakView> {
    const today = businessDay(new Date());
    const rows = await this.prisma.nightlyReconciliation.findMany({
      where: {
        branchId: actor.branchId,
        businessDay: { gte: businessDayColumn(shiftTradingDay(today, -STREAK_LOOKBACK_NIGHTS)) },
      },
      orderBy: [{ businessDay: 'desc' }, { submittedAt: 'desc' }, { id: 'desc' }],
      select: { id: true, businessDay: true, verdict: true },
    });

    const effective: NightVerdict[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const day = tradingDayOf(row.businessDay);
      // Rows arrive newest-first per night, so the first one seen for a night
      // is the one that counts.
      if (seen.has(day)) continue;
      seen.add(day);
      effective.push({ businessDay: day, verdict: row.verdict });
    }

    return computeStreak(effective, today, RECONCILIATION_STREAK_REQUIRED);
  }
}

/* ───────────────────────── views ───────────────────────── */

/** One stored submission, as the history and the verdict screen read it. */
export interface ReconciliationRecordView {
  id: string;
  businessDay: string;
  verdict: ReconciliationVerdict;
  matched: boolean;
  /** False once a later submission for the same night supersedes this one. */
  isLatestForNight: boolean;
  supersedesId: string | null;

  paper: {
    countedCashFils: number;
    bookings: number;
    cardTotalFils: number;
    tipsCashFils: number | null;
  };
  system: {
    cashFils: number;
    bookings: number;
    cardFils: number;
    tipsDirectCashFils: number;
    openSessions: number;
  };
  variance: {
    cashFils: number;
    bookings: number;
    cardFils: number;
    tipsCashFils: number | null;
  };
  cashToleranceFils: number;
  /** §15.4. Whoever took cash at the desk that night; a variance belongs to somebody. */
  cashDeskUserIds: string[];
  note: string | null;
  submittedByUserId: string;
  submittedAt: string;
  /** The comparison exactly as it was presented and signed off. */
  lines: ReconciliationLine[];
}

export interface ReconciliationResultView extends ReconciliationRecordView {
  /** The failing lines, so the screen leads with what to investigate. */
  failing: ReconciliationLine[];
  /** Where the pilot now stands, recomputed after this submission landed. */
  streak: StreakView;
}

export interface ReconciliationHistoryView {
  from: string;
  to: string;
  /** Every attempt in the window, corrections included. */
  submissions: number;
  /** Distinct trading nights with at least one submission. */
  nightsReconciled: number;
  entries: ReconciliationRecordView[];
}

/* ───────────────────────── presentation ───────────────────────── */

type StoredReconciliation = Prisma.NightlyReconciliationGetPayload<
  Record<string, never>
>;

/**
 * The stored `lines` column, read back.
 *
 * It was written by `compareNight` and Postgres hands it back as `JsonValue`,
 * so the cast is the one place this module trusts its own history. A row whose
 * lines could not be read is still a row whose verdict, figures and variances
 * are real columns — so an unreadable blob degrades to an empty list rather
 * than taking the whole history down with it.
 */
function storedLines(value: Prisma.JsonValue): ReconciliationLine[] {
  return Array.isArray(value) ? (value as unknown as ReconciliationLine[]) : [];
}

function presentRecord(
  row: StoredReconciliation,
  isLatestForNight: boolean,
): ReconciliationRecordView {
  return {
    id: row.id,
    businessDay: tradingDayOf(row.businessDay),
    verdict: row.verdict,
    matched: isMatch(row.verdict),
    isLatestForNight,
    supersedesId: row.supersedesId,

    paper: {
      countedCashFils: row.countedCashFils,
      bookings: row.paperBookings,
      cardTotalFils: row.paperCardTotalFils,
      tipsCashFils: row.paperTipsCashFils,
    },
    system: {
      cashFils: row.systemCashFils,
      bookings: row.systemBookings,
      cardFils: row.systemCardTotalFils,
      tipsDirectCashFils: row.systemTipsCashFils,
      openSessions: row.openSessions,
    },
    variance: {
      cashFils: row.cashVarianceFils,
      bookings: row.bookingsVariance,
      cardFils: row.cardVarianceFils,
      tipsCashFils: row.tipsCashVarianceFils,
    },
    cashToleranceFils: row.cashToleranceFils,
    cashDeskUserIds: row.cashDeskUserIds,
    note: row.note,
    submittedByUserId: row.submittedByUserId,
    submittedAt: row.submittedAt.toISOString(),
    lines: storedLines(row.lines),
  };
}

/** The id of the most recent submission for each trading night in a sorted list. */
function latestIdPerNight(rows: StoredReconciliation[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const row of rows) {
    const day = tradingDayOf(row.businessDay);
    if (seen.has(day)) continue;
    seen.add(day);
    ids.push(row.id);
  }
  return ids;
}

/** Re-exported so the controller's return types read from one place. */
export type { ComparisonResult, StreakView, SystemNightFigures };

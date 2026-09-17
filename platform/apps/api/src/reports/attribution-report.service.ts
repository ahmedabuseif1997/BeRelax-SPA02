import { Injectable } from '@nestjs/common';
import { AttributionReportQuery } from '@berelax/contracts';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../common/request-context';
import { percentOrNull, resolveReportWindow } from './reports.support';

/** Which end of the journey the row credits. */
export const TouchModel = { FIRST: 'FIRST', LAST: 'LAST' } as const;
export type TouchModel = (typeof TouchModel)[keyof typeof TouchModel];

/**
 * What the gap between the two models says about a channel. A channel that
 * earns more on first touch than on last DISCOVERS guests somebody else closes;
 * one that earns more on last touch CLOSES guests somebody else found.
 */
export const ChannelRole = {
  DISCOVERS: 'DISCOVERS',
  CLOSES: 'CLOSES',
  BALANCED: 'BALANCED',
} as const;
export type ChannelRole = (typeof ChannelRole)[keyof typeof ChannelRole];

/** Below this the two models are telling the same story: 5% of the larger side. */
const BALANCED_TOLERANCE = 0.05;

export interface AttributionChannelView {
  source: string;
  medium: string;
  campaign: string | null;
  /** Snapshots captured in the window. The top of the funnel. */
  visitors: number;
  /** `booking_requests` rows — enquiries off the website form. §10.6. */
  enquiries: number;
  /** Reservations carrying this attribution, whatever their status. */
  bookings: number;
  completedVisits: number;
  /** BASE payments on those bookings, net of base refunds. Tips are never in here. */
  revenueFils: number;
  /** completed visits over enquiries, per §10.6. NULL when nothing enquired. */
  conversionPct: number | null;
  /** completed visits over bookings — the same question asked of bookings taken at the desk. */
  completionPct: number | null;
}

export interface AttributionGapView {
  source: string;
  medium: string;
  campaign: string | null;
  firstTouchRevenueFils: number;
  lastTouchRevenueFils: number;
  /** first minus last. Positive means the channel finds guests it does not close. */
  differenceFils: number;
  firstTouchCompletedVisits: number;
  lastTouchCompletedVisits: number;
  role: ChannelRole;
}

export interface AttributionReportView {
  from: string;
  to: string;
  generatedAt: string;
  firstTouch: AttributionChannelView[];
  lastTouch: AttributionChannelView[];
  /** The most useful number in the report, at the top of it rather than derived. §10.6. */
  gap: AttributionGapView[];
  totals: {
    visitors: number;
    enquiries: number;
    bookings: number;
    completedVisits: number;
    revenueFils: number;
  };
  basis: string;
}

const BASIS =
  'A cohort report: the window selects the visitors first captured in it, and every booking and ' +
  'dirham those visitors went on to spend is counted against them, whenever it landed. The two ' +
  'tables are the same money split two ways — first touch credits the channel that FOUND the ' +
  'guest, last touch the one that CLOSED them — so both sides total the same, and the gap between ' +
  'a channel’s two rows is the difference between cutting it and crediting it elsewhere. §10.6. ' +
  'Revenue is BASE payments only: a tip is not revenue in either mode (§9.1). Where `enquiries` ' +
  'is zero the channel produced no website enquiry — those guests were booked at the desk — so ' +
  'the conversion rate is null rather than a fabricated 0%.';

/**
 * Channel ROI, first touch and last touch, over one cohort. §10.6, MANAGER+ (§6.4).
 *
 * §10.6's query is the shape of this, with three deliberate changes:
 *
 *  1. The window is `business_day(a.captured_at)`, not `captured_at >= $1`. The
 *     visitor who enquired at 01:30 belongs to the night before, the same as the
 *     booking they made and the payment that followed it (§3.3). It is the one
 *     table in this module with no stored `business_day` column, so the SQL
 *     function is called on the timestamp directly.
 *  2. Both models come back from one pass over the cohort rather than two runs
 *     of the same statement with `first_touch` swapped for `last_touch`. Two
 *     runs can disagree if a snapshot is written between them, and the gap is
 *     read as a difference — a difference between two inconsistent totals is
 *     noise presented as insight.
 *  3. The per-snapshot facts are counted in a LATERAL, not joined in flat. The
 *     published query survives its own join only because `attribution_id` is
 *     unique on `booking_requests`; let a snapshot carry two enquiries and
 *     `SUM(p.amount_fils)` doubles. Counted once per snapshot, it cannot fan out.
 *
 * `attribution_snapshots` carries no `branch_id` — the public site has no branch
 * context until an enquiry lands — so `visitors` is the whole funnel, while
 * every enquiry, booking and dirham below it is scoped to the caller's branch.
 */
@Injectable()
export class AttributionReportService {
  constructor(private readonly prisma: PrismaService) {}

  async attribution(
    query: AttributionReportQuery,
    actor: AuthUser,
  ): Promise<AttributionReportView> {
    const { from, to } = resolveReportWindow(query);
    const branchId = actor.branchId;

    const rows = await this.prisma.$queryRaw<ChannelRow[]>`
      WITH snapshot AS (
        SELECT
          -- A touch with no source is a direct arrival, not a blank row. The
          -- retention job (§5.6) strips everything but source/medium/campaign at
          -- ninety days, so those three keys outlive the identifiers by design.
          COALESCE(NULLIF(a.first_touch->>'source', ''), '(direct)')   AS "firstSource",
          COALESCE(NULLIF(a.first_touch->>'medium', ''), '(none)')     AS "firstMedium",
          NULLIF(a.first_touch->>'campaign', '')                       AS "firstCampaign",
          COALESCE(NULLIF(a.last_touch->>'source', ''), '(direct)')    AS "lastSource",
          COALESCE(NULLIF(a.last_touch->>'medium', ''), '(none)')      AS "lastMedium",
          NULLIF(a.last_touch->>'campaign', '')                        AS "lastCampaign",
          f.enquiries, f.bookings, f.completed_visits, f.revenue_fils
        FROM attribution_snapshots a
        CROSS JOIN LATERAL (
          SELECT
            (SELECT count(*)::int FROM booking_requests br
              WHERE br.attribution_id = a.id AND br.branch_id = ${branchId}::uuid)  AS enquiries,
            (SELECT count(*)::int FROM reservations r
              WHERE r.attribution_id = a.id AND r.branch_id = ${branchId}::uuid)    AS bookings,
            (SELECT count(*)::int FROM reservations r
              WHERE r.attribution_id = a.id AND r.branch_id = ${branchId}::uuid
                AND r.status = 'COMPLETED')                                         AS completed_visits,
            (SELECT COALESCE(SUM(p.amount_fils), 0)::int
               FROM payments p
               JOIN reservations r ON r.id = p.reservation_id
               LEFT JOIN payments orig ON orig.id = p.reverses_payment_id
              WHERE r.attribution_id = a.id
                AND p.branch_id = ${branchId}::uuid
                AND (p.kind = 'BASE'
                     OR (p.kind = 'REFUND' AND orig.kind IS DISTINCT FROM 'TIP')))  AS revenue_fils
        ) f
        WHERE business_day(a.captured_at) BETWEEN ${from}::date AND ${to}::date
      )
      SELECT 'FIRST'                     AS "touch",
             "firstSource"               AS "source",
             "firstMedium"               AS "medium",
             "firstCampaign"             AS "campaign",
             count(*)::int               AS "visitors",
             SUM(enquiries)::int         AS "enquiries",
             SUM(bookings)::int          AS "bookings",
             SUM(completed_visits)::int  AS "completedVisits",
             SUM(revenue_fils)::int      AS "revenueFils"
        FROM snapshot
       GROUP BY 1, 2, 3, 4
      UNION ALL
      SELECT 'LAST',
             "lastSource", "lastMedium", "lastCampaign",
             count(*)::int, SUM(enquiries)::int, SUM(bookings)::int,
             SUM(completed_visits)::int, SUM(revenue_fils)::int
        FROM snapshot
       GROUP BY 1, 2, 3, 4
       ORDER BY 9 DESC, 2, 3, 4`;

    const firstTouch = rows.filter((row) => row.touch === TouchModel.FIRST).map(present);
    const lastTouch = rows.filter((row) => row.touch === TouchModel.LAST).map(present);

    return {
      from,
      to,
      generatedAt: new Date().toISOString(),
      firstTouch,
      lastTouch,
      gap: gapBetween(firstTouch, lastTouch),
      // Totalled from ONE side. Both sides are the same cohort split two ways,
      // so adding them together would double every figure on the page — which
      // is exactly the mistake a two-model report invites.
      totals: totalOf(lastTouch),
      basis: BASIS,
    };
  }
}

interface ChannelRow {
  touch: TouchModel;
  source: string;
  medium: string;
  campaign: string | null;
  visitors: number;
  enquiries: number;
  bookings: number;
  completedVisits: number;
  revenueFils: number;
}

function present(row: ChannelRow): AttributionChannelView {
  return {
    source: row.source,
    medium: row.medium,
    campaign: row.campaign,
    visitors: row.visitors,
    enquiries: row.enquiries,
    bookings: row.bookings,
    completedVisits: row.completedVisits,
    revenueFils: row.revenueFils,
    conversionPct: percentOrNull(row.completedVisits, row.enquiries),
    completionPct: percentOrNull(row.completedVisits, row.bookings),
  };
}

/** Source, medium and campaign identify a channel. JSON, so no separator can collide. */
function channelKey(row: { source: string; medium: string; campaign: string | null }): string {
  return JSON.stringify([row.source, row.medium, row.campaign]);
}

/**
 * Every channel that appears on either side, with both its numbers and the
 * difference between them — sorted by how far apart the two models are, largest
 * first, because that ordering IS the finding. A channel present in one model
 * and absent from the other is the strongest version of it: it discovers guests
 * it never closes, or closes guests it never found.
 */
function gapBetween(
  firstTouch: AttributionChannelView[],
  lastTouch: AttributionChannelView[],
): AttributionGapView[] {
  const byKey = new Map<string, AttributionGapView>();

  const lineFor = (row: AttributionChannelView): AttributionGapView =>
    byKey.get(channelKey(row)) ?? {
      source: row.source,
      medium: row.medium,
      campaign: row.campaign,
      firstTouchRevenueFils: 0,
      lastTouchRevenueFils: 0,
      differenceFils: 0,
      firstTouchCompletedVisits: 0,
      lastTouchCompletedVisits: 0,
      role: ChannelRole.BALANCED,
    };

  for (const row of firstTouch) {
    const entry = lineFor(row);
    entry.firstTouchRevenueFils = row.revenueFils;
    entry.firstTouchCompletedVisits = row.completedVisits;
    byKey.set(channelKey(row), entry);
  }
  for (const row of lastTouch) {
    const entry = lineFor(row);
    entry.lastTouchRevenueFils = row.revenueFils;
    entry.lastTouchCompletedVisits = row.completedVisits;
    byKey.set(channelKey(row), entry);
  }

  return [...byKey.values()]
    .map((entry) => {
      const differenceFils = entry.firstTouchRevenueFils - entry.lastTouchRevenueFils;
      const scale = Math.max(entry.firstTouchRevenueFils, entry.lastTouchRevenueFils);
      return { ...entry, differenceFils, role: roleOf(differenceFils, scale) };
    })
    .sort(
      (a, b) =>
        Math.abs(b.differenceFils) - Math.abs(a.differenceFils) ||
        a.source.localeCompare(b.source) ||
        a.medium.localeCompare(b.medium),
    );
}

function roleOf(differenceFils: number, scale: number): ChannelRole {
  if (scale === 0 || Math.abs(differenceFils) <= scale * BALANCED_TOLERANCE) {
    return ChannelRole.BALANCED;
  }
  return differenceFils > 0 ? ChannelRole.DISCOVERS : ChannelRole.CLOSES;
}

function totalOf(rows: AttributionChannelView[]): AttributionReportView['totals'] {
  return rows.reduce(
    (total, row) => ({
      visitors: total.visitors + row.visitors,
      enquiries: total.enquiries + row.enquiries,
      bookings: total.bookings + row.bookings,
      completedVisits: total.completedVisits + row.completedVisits,
      revenueFils: total.revenueFils + row.revenueFils,
    }),
    { visitors: 0, enquiries: 0, bookings: 0, completedVisits: 0, revenueFils: 0 },
  );
}

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  DailyReportQuery,
  PaymentKind,
  PaymentMethod,
  ReservationStatus,
  TipType,
  businessDay,
} from '@berelax/contracts';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../common/request-context';
import { MONEY_LINE_LABELS, NO_TIPS, type TipLine } from './reports.support';

/**
 * §8.4: an IN_PROGRESS booking still open this long after its room was released
 * is one somebody forgot, and it is tomorrow's report being wrong tonight.
 */
const NEEDS_CHECKOUT_AFTER_HOURS = 2;

export interface DailyBookingsView {
  total: number;
  scheduled: number;
  inProgress: number;
  completed: number;
  cancelled: number;
  noShow: number;
  /** IN_PROGRESS more than two hours past `blockedUntil`. The close-out list. §8.4. */
  needingCheckout: number;
}

export interface DailyTakingsView {
  /** SUM(amount_fils) over every payment filed to this trading day. Signed. */
  grossFils: number;
  baseCollectedFils: number;
  /** Negative. A refund of a BASE payment, filed on the day the money went back. */
  baseRefundedFils: number;
  /** TIP payments net of TIP refunds. A pass-through, not revenue. §9.1. */
  tipsCollectedFils: number;
  /** Signed. Discounts and late corrections. */
  adjustmentsFils: number;
  byMethod: Array<{ method: PaymentMethod; entries: number; amountFils: number }>;
}

export interface DailyTipsView {
  directCash: TipLine;
  collectedByBusiness: TipLine;
  /** Both modes. What the therapists earned tonight, whoever ends up holding it. */
  totalFils: number;
  /** Of that, what the business now owes out. §9.2. */
  payableFils: number;
  labels: { directCash: string; collectedByBusiness: string };
}

export interface CashDrawerView {
  /** Count the till against this. SUM(payments WHERE method = 'CASH') for the day. */
  expectedCashFils: number;
  baseCashFils: number;
  tipCashFils: number;
  refundedCashFils: number;
  adjustmentCashFils: number;
  note: string;
}

export interface DailyReportView {
  businessDay: string;
  generatedAt: string;
  bookings: DailyBookingsView;
  /** Reservations that actually arrived — COMPLETED plus still IN_PROGRESS. */
  guestsSeen: number;
  therapists: { worked: number; rostered: number };
  takings: DailyTakingsView;
  tips: DailyTipsView;
  cashDrawer: CashDrawerView;
}

const DRAWER_NOTE =
  'Cash the business took in on this trading day, refunds already deducted. A DIRECT_CASH ' +
  'tip is NOT in here — the guest handed that straight to the therapist and it never entered the till.';

/**
 * The close-out sheet. §7.4, and MANAGER+ only for the reason §6.4 gives: the
 * person handling cash all evening is not the person auditing it.
 *
 * Every figure is filed to the TRADING day (§3.3), which is the whole difference
 * between this report and a wrong one: the 01:30 booking, the payment taken for
 * it and the tip recorded after it all belong to the night before, and
 * `business_day` is a stored, trigger-maintained column on every table read
 * here. Grouping these by `date_trunc('day', ...)` would move the last hour and
 * a half of every night onto the next day's sheet, quietly, for ever.
 *
 * Four statements, in one REPEATABLE READ transaction. A close-out sheet is read
 * while reception is still checking guests out, and the manager counting the
 * till must not be handed a drawer figure from one instant and a takings figure
 * from another.
 */
@Injectable()
export class DailyReportService {
  constructor(private readonly prisma: PrismaService) {}

  async daily(query: DailyReportQuery, actor: AuthUser): Promise<DailyReportView> {
    const day = query.businessDay ?? businessDay(new Date());
    const branchId = actor.branchId;

    const [statusRows, [floor], paymentRows, tipRows] = await this.prisma.$transaction(
      [
        // 1. Bookings by status, and the ones left open. §8.4.
        this.prisma.$queryRaw<StatusRow[]>`
          SELECT r.status::text                   AS "status",
                 count(*)::int                    AS "bookings",
                 count(*) FILTER (
                   -- ::int, because Prisma binds a JS number as bigint and
                   -- make_interval takes an int. A cast here rather than a
                   -- literal so the constant above stays the single source of it.
                   WHERE r.blocked_until < now() - make_interval(hours => ${NEEDS_CHECKOUT_AFTER_HOURS}::int)
                 )::int                           AS "overdue"
            FROM reservations r
           WHERE r.branch_id = ${branchId}::uuid
             AND r.business_day = ${day}::date
           GROUP BY r.status`,

        // 2. Who was on the floor. Rostered comes from `shifts`, not from who
        //    happened to take a booking — a therapist on shift with an empty
        //    night is still a therapist the business paid to be there.
        this.prisma.$queryRaw<FloorRow[]>`
          SELECT (SELECT count(DISTINCT r.employee_id)::int
                    FROM reservations r
                   WHERE r.branch_id = ${branchId}::uuid
                     AND r.business_day = ${day}::date
                     AND r.status IN ('COMPLETED', 'IN_PROGRESS'))          AS "worked",
                 (SELECT count(*)::int
                    FROM shifts s
                   WHERE s.branch_id = ${branchId}::uuid
                     AND s.business_day = ${day}::date
                     AND s.status <> 'ABSENT')                              AS "rostered"`,

        // 3. Every payment, by kind and method. `orig.kind` is what keeps a
        //    refunded TIP from reading as a shortfall on the base — the same
        //    distinction §13.3's invariant 4b is built on.
        this.prisma.$queryRaw<PaymentRow[]>`
          SELECT p.kind::text                        AS "kind",
                 p.method::text                      AS "method",
                 orig.kind::text                     AS "reversesKind",
                 count(*)::int                       AS "entries",
                 COALESCE(SUM(p.amount_fils), 0)::int AS "amountFils"
            FROM payments p
            LEFT JOIN payments orig ON orig.id = p.reverses_payment_id
           WHERE p.branch_id = ${branchId}::uuid
             AND p.business_day = ${day}::date
           GROUP BY p.kind, p.method, orig.kind`,

        // 4. Tips, both modes, reversed pairs excluded from both sides. §9.2.
        this.prisma.$queryRaw<TipRow[]>`
          SELECT t.type::text                        AS "type",
                 count(*)::int                       AS "tipCount",
                 COALESCE(SUM(t.amount_fils), 0)::int AS "totalFils"
            FROM tips t
           WHERE t.branch_id = ${branchId}::uuid
             AND t.business_day = ${day}::date
             AND t.reversed_by_tip_id IS NULL
           GROUP BY t.type`,
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return {
      businessDay: day,
      generatedAt: new Date().toISOString(),
      bookings: presentBookings(statusRows),
      guestsSeen: countOf(statusRows, ReservationStatus.COMPLETED) +
        countOf(statusRows, ReservationStatus.IN_PROGRESS),
      therapists: { worked: floor?.worked ?? 0, rostered: floor?.rostered ?? 0 },
      takings: presentTakings(paymentRows),
      tips: presentTips(tipRows),
      cashDrawer: presentCashDrawer(paymentRows),
    };
  }
}

interface StatusRow {
  status: ReservationStatus;
  bookings: number;
  overdue: number;
}

interface FloorRow {
  worked: number;
  rostered: number;
}

interface PaymentRow {
  kind: PaymentKind;
  method: PaymentMethod;
  /** The kind of the payment this row reverses; null unless this row is a REFUND. */
  reversesKind: PaymentKind | null;
  entries: number;
  amountFils: number;
}

interface TipRow {
  type: TipType;
  tipCount: number;
  totalFils: number;
}

function countOf(rows: StatusRow[], status: ReservationStatus): number {
  return rows.find((row) => row.status === status)?.bookings ?? 0;
}

function presentBookings(rows: StatusRow[]): DailyBookingsView {
  return {
    total: rows.reduce((sum, row) => sum + row.bookings, 0),
    scheduled: countOf(rows, ReservationStatus.SCHEDULED),
    inProgress: countOf(rows, ReservationStatus.IN_PROGRESS),
    completed: countOf(rows, ReservationStatus.COMPLETED),
    cancelled: countOf(rows, ReservationStatus.CANCELLED),
    noShow: countOf(rows, ReservationStatus.NO_SHOW),
    needingCheckout:
      rows.find((row) => row.status === ReservationStatus.IN_PROGRESS)?.overdue ?? 0,
  };
}

/**
 * A REFUND is filed against the kind it reverses, so sending a 50 AED tip back
 * never shows up as a shortfall on a 250 AED base. A refund whose original
 * cannot be resolved falls to the base line rather than the tip line: that is
 * the conservative reading — it reduces revenue instead of hiding inside a
 * pass-through — and it keeps the four lines summing to `grossFils` exactly.
 */
function isTipRefund(row: PaymentRow): boolean {
  return row.kind === PaymentKind.REFUND && row.reversesKind === PaymentKind.TIP;
}

function sumWhere(rows: PaymentRow[], predicate: (row: PaymentRow) => boolean): number {
  return rows.reduce((total, row) => (predicate(row) ? total + row.amountFils : total), 0);
}

function presentTakings(rows: PaymentRow[]): DailyTakingsView {
  const byMethod = new Map<PaymentMethod, { entries: number; amountFils: number }>();
  for (const row of rows) {
    const line = byMethod.get(row.method) ?? { entries: 0, amountFils: 0 };
    line.entries += row.entries;
    line.amountFils += row.amountFils;
    byMethod.set(row.method, line);
  }

  return {
    grossFils: sumWhere(rows, () => true),
    baseCollectedFils: sumWhere(rows, (row) => row.kind === PaymentKind.BASE),
    baseRefundedFils: sumWhere(rows, (row) => row.kind === PaymentKind.REFUND && !isTipRefund(row)),
    tipsCollectedFils: sumWhere(rows, (row) => row.kind === PaymentKind.TIP || isTipRefund(row)),
    adjustmentsFils: sumWhere(rows, (row) => row.kind === PaymentKind.ADJUSTMENT),
    byMethod: [...byMethod.entries()]
      .map(([method, line]) => ({ method, ...line }))
      .sort((a, b) => b.amountFils - a.amountFils || a.method.localeCompare(b.method)),
  };
}

function tipLine(rows: TipRow[], type: TipType): TipLine {
  const row = rows.find((candidate) => candidate.type === type);
  return row ? { tipCount: row.tipCount, totalFils: row.totalFils } : NO_TIPS;
}

function presentTips(rows: TipRow[]): DailyTipsView {
  const directCash = tipLine(rows, TipType.DIRECT_CASH);
  const collectedByBusiness = tipLine(rows, TipType.COLLECTED_BY_BUSINESS);

  return {
    directCash,
    collectedByBusiness,
    totalFils: directCash.totalFils + collectedByBusiness.totalFils,
    // The only one of the two the business owes. Adding them together and
    // paying that out is how a spa pays a tip twice. §9.1.
    payableFils: collectedByBusiness.totalFils,
    labels: {
      directCash: MONEY_LINE_LABELS.tipsDirectCash,
      collectedByBusiness: MONEY_LINE_LABELS.tipsCollectedByBusiness,
    },
  };
}

/**
 * What should be in the drawer at 02:00. Signed, so a cash refund taken back out
 * of the till during the evening is already deducted — which is what a manager
 * counting notes against this number needs it to be.
 */
function presentCashDrawer(rows: PaymentRow[]): CashDrawerView {
  const cash = rows.filter((row) => row.method === PaymentMethod.CASH);

  return {
    expectedCashFils: sumWhere(cash, () => true),
    baseCashFils: sumWhere(cash, (row) => row.kind === PaymentKind.BASE),
    tipCashFils: sumWhere(cash, (row) => row.kind === PaymentKind.TIP || isTipRefund(row)),
    refundedCashFils: sumWhere(cash, (row) => row.kind === PaymentKind.REFUND && !isTipRefund(row)),
    adjustmentCashFils: sumWhere(cash, (row) => row.kind === PaymentKind.ADJUSTMENT),
    note: DRAWER_NOTE,
  };
}

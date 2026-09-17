import type {
  PaymentMethod,
  ReservationStatus,
  SourceChannel,
  TipType,
  UserRole,
} from '@berelax/contracts';

/**
 * These mirror the API's response types by hand.
 *
 * `ReservationView`, `CheckInView` and `CheckoutView` are declared inside
 * apps/api (reservations.service.ts, check-in.handler.ts, checkout.handler.ts)
 * and are not exported from @berelax/contracts, so there is nothing to import.
 * Every field below was read off those files — if one of them moves into the
 * contracts package, delete the copy here and import it instead.
 *
 * Money is an integer number of fils on the wire and stays that way until
 * `formatAed` renders it. Spec §3.1.
 */

export interface AuthUser {
  id: string;
  role: UserRole;
  branchId: string;
  employeeId?: string | null;
  email: string;
  fullName: string;
}

/** POST /auth/login, /auth/refresh, /auth/change-password. */
export interface SessionResponse {
  accessToken: string;
  tokenType: 'Bearer';
  /** Seconds until the access token expires. */
  expiresIn: number;
  mustChangePassword: boolean;
  user: AuthUser;
}

export interface GuestRef {
  id: string;
  fullName: string;
  phone: string;
}

export interface EmployeeRef {
  id: string;
  displayName: string;
}

export interface ServiceRef {
  id: string;
  name: string;
  durationMinutes: number;
}

export interface RoomRef {
  id: string;
  name: string;
}

/** GET /reservations, GET /reservations/:id, POST /reservations. */
export interface ReservationView {
  id: string;
  ref: string;
  status: ReservationStatus;
  /** ISO-8601 with an offset. Rendered in Asia/Dubai, never parsed by hand. */
  startsAt: string;
  endsAt: string;
  /** endsAt plus the turnaround buffer: the slot is not free until this passes. */
  blockedUntil: string;
  /** YYYY-MM-DD — the TRADING day, not the calendar day. Spec §3.3. */
  businessDay: string;
  durationMinutes: number;
  baseCostFils: number;
  sourceChannel: string;
  actualArrivalAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  notes: string | null;
  guest?: GuestRef | null;
  employee?: EmployeeRef | null;
  service?: ServiceRef | null;
  room?: RoomRef | null;
}

/** POST /reservations/:id/check-in. */
export interface CheckInView extends ReservationView {
  basePaidFils: number;
  payments: Array<{
    id: string;
    kind: string;
    method: PaymentMethod;
    amountFils: number;
  }>;
}

/** POST /reservations/:id/checkout. */
export interface CheckoutView extends ReservationView {
  totals: {
    baseCollectedFils: number;
    tipFils: number;
    tipType: TipType | null;
    businessReceivedFils: number;
    therapistOwedFromThisVisitFils: number;
  };
}

/* ───────────────────────── request bodies ───────────────────────── */

export interface CreateReservationBody {
  employeeId: string;
  serviceId: string;
  roomId?: string;
  guestId?: string;
  guestName?: string;
  guestPhone?: string;
  guestEmail?: string;
  startsAt: string;
  durationMinutes?: number;
  sourceChannel: SourceChannel;
  notes?: string;
}

export interface CheckInBody {
  actualArrivalAt?: string;
  basePayments: Array<{
    method: PaymentMethod;
    amountFils: number;
    externalRef?: string;
  }>;
  note?: string;
}

export interface CheckoutBody {
  completedAt?: string;
  tip: {
    amountFils: number;
    type: TipType;
    method?: PaymentMethod;
    externalRef?: string;
  } | null;
  confirmLargeTip?: boolean;
  note?: string;
}

/* ───────────────────────── catalogue and guests ───────────────────────── */

/**
 * `GET /services` and `GET /rooms` are readable by ALL staff (the controller
 * overrides its MANAGER+ class guard on the two list routes) — reception cannot
 * price a booking without them. `GET /employees` is MANAGER+ with no override
 * and no public equivalent, which is why the therapist columns fall back to the
 * day's bookings for a receptionist. See `catalogue.ts`.
 */
export interface ServiceSummary extends ServiceRef {
  categoryId: string;
  priceFils: number;
  description: string | null;
  /** A service that needs a room must not be booked without one. */
  requiresRoom: boolean;
  isActive: boolean;
  sortOrder: number;
}

export interface RoomSummary extends RoomRef {
  capacity: number;
  isActive: boolean;
}

export interface EmployeeSummary extends EmployeeRef {
  status?: string;
  phone?: string | null;
  commissionBps?: number;
}

/**
 * `GET /availability?businessDay=` — ALL staff, unlike `/employees`. It carries
 * no guest, no money and no booking ids, only who is on shift and which hours
 * are open, so it is the roster a receptionist is actually allowed to read.
 * Only the fields the grid columns need are declared here.
 */
export interface AvailabilityView {
  businessDay: string;
  generatedAt: string;
  therapists: Array<{
    employeeId: string;
    displayName: string;
    shift: { startsAt: string; endsAt: string; status: string };
  }>;
}

/** `GET /guests?search=` — matched against name and phone at once. */
export interface GuestSummary {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
  notes: string | null;
  isBlocked: boolean;
}

/* ───────────────────────── reports (§7.4, MANAGER+) ───────────────────────── */

/**
 * Mirrors `apps/api/src/reports/*.service.ts`, by hand and for the same reason
 * as everything above it: those view types live inside the API and are not
 * exported from @berelax/contracts.
 *
 * Every money field is integer fils and stays that way until `formatAed`
 * renders it (§3.1). Every date field is a TRADING day — `YYYY-MM-DD` after the
 * 06:00 cutover — so a 01:30 booking is filed to the night before (§3.3).
 */

export interface TipLine {
  tipCount: number;
  totalFils: number;
}

/** `GET /reports/daily?businessDay=` */
export interface DailyReportView {
  businessDay: string;
  generatedAt: string;
  bookings: {
    total: number;
    scheduled: number;
    inProgress: number;
    completed: number;
    cancelled: number;
    noShow: number;
    /** IN_PROGRESS more than two hours past `blockedUntil`. §8.4. */
    needingCheckout: number;
  };
  guestsSeen: number;
  therapists: { worked: number; rostered: number };
  takings: {
    grossFils: number;
    baseCollectedFils: number;
    baseRefundedFils: number;
    tipsCollectedFils: number;
    adjustmentsFils: number;
    byMethod: Array<{ method: PaymentMethod; entries: number; amountFils: number }>;
  };
  tips: {
    directCash: TipLine;
    collectedByBusiness: TipLine;
    totalFils: number;
    payableFils: number;
    labels: { directCash: string; collectedByBusiness: string };
  };
  cashDrawer: {
    expectedCashFils: number;
    baseCashFils: number;
    tipCashFils: number;
    refundedCashFils: number;
    adjustmentCashFils: number;
    note: string;
  };
}

export type ReportGroupBy = 'day' | 'week' | 'month';

export interface RevenuePeriodView {
  periodStart: string;
  periodEnd: string;
  label: string;
  completedVisits: number;
  noShows: number;
  cancellations: number;
  baseCollectedFils: number;
  baseRefundedFils: number;
  adjustmentsFils: number;
  /** base + refunds + adjustments. The only revenue line — tips are never in it. */
  netRevenueFils: number;
  tipsCollectedByBusinessFils: number;
  tipsDirectCashFils: number;
}

/** `GET /reports/revenue?from=&to=&groupBy=` */
export interface RevenueReportView {
  from: string;
  to: string;
  groupBy: ReportGroupBy;
  generatedAt: string;
  periods: RevenuePeriodView[];
  totals: Omit<RevenuePeriodView, 'periodStart' | 'periodEnd' | 'label'>;
  legend: { revenue: string; tipsCollectedByBusiness: string; tipsDirectCash: string };
}

export interface TherapistUtilisationView {
  employeeId: string;
  displayName: string;
  sessions: number;
  minutesBooked: number;
  minutesRostered: number;
  minutesClocked: number;
  shifts: number;
  daysWorked: number;
  /** booked over ROSTERED. `null` when nothing was rostered — never a made-up 0. */
  utilisationPct: number | null;
  noShows: number;
  minutesLostToNoShows: number;
  revenueGeneratedFils: number;
  tips: { directCash: TipLine; collectedByBusiness: TipLine };
}

/** `GET /reports/therapist-utilisation?from=&to=` */
export interface UtilisationReportView {
  from: string;
  to: string;
  generatedAt: string;
  therapists: TherapistUtilisationView[];
  totals: {
    sessions: number;
    minutesBooked: number;
    minutesRostered: number;
    utilisationPct: number | null;
    revenueGeneratedFils: number;
    tipsDirectCashFils: number;
    tipsCollectedByBusinessFils: number;
  };
  basis: string;
}

/** `GET /reports/tips?from=&to=` */
export interface TipsReportView {
  from: string;
  to: string;
  generatedAt: string;
  byMode: {
    directCash: TipLine;
    collectedByBusiness: TipLine;
    totalFils: number;
    labels: { directCash: string; collectedByBusiness: string };
  };
  byTherapist: Array<{
    employeeId: string;
    displayName: string;
    directCash: TipLine;
    collectedByBusiness: TipLine;
    totalEarnedFils: number;
    /** Whole-ledger balance, all time. Not window-scoped — a balance is a balance. §9.3. */
    outstandingPayableFils: number;
    unbatchedPayableFils: number;
  }>;
  byDay: Array<{
    businessDay: string;
    directCash: TipLine;
    collectedByBusiness: TipLine;
    totalFils: number;
  }>;
  payable: { totalOutstandingFils: number; totalUnbatchedFils: number; basis: string };
}

export type ChannelRole = 'DISCOVERS' | 'CLOSES' | 'BALANCED';

export interface AttributionChannelView {
  source: string;
  medium: string;
  campaign: string | null;
  visitors: number;
  enquiries: number;
  bookings: number;
  completedVisits: number;
  revenueFils: number;
  /** §10.6's rate. `null` where nothing enquired — never a fabricated 0%. */
  conversionPct: number | null;
  completionPct: number | null;
}

/** `GET /reports/attribution?from=&to=` */
export interface AttributionReportView {
  from: string;
  to: string;
  generatedAt: string;
  firstTouch: AttributionChannelView[];
  lastTouch: AttributionChannelView[];
  gap: Array<{
    source: string;
    medium: string;
    campaign: string | null;
    firstTouchRevenueFils: number;
    lastTouchRevenueFils: number;
    differenceFils: number;
    firstTouchCompletedVisits: number;
    lastTouchCompletedVisits: number;
    role: ChannelRole;
  }>;
  totals: {
    visitors: number;
    enquiries: number;
    bookings: number;
    completedVisits: number;
    revenueFils: number;
  };
  basis: string;
}

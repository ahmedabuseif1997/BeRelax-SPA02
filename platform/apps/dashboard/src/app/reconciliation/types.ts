import type { ReconciliationVerdict } from '@berelax/contracts';

/**
 * The reconciliation API's response types, mirrored by hand.
 *
 * Same reason `src/lib/api-types.ts` mirrors the booking ones: these live in
 * `apps/api/src/reconciliation/` and are not exported from `@berelax/contracts`,
 * so there is nothing to import. Every field below was read off
 * `close-out-sheet.service.ts` and `reconciliation.service.ts` — if they ever
 * move into the contracts package, delete this file and import them instead.
 *
 * Money is an integer number of fils on the wire and stays that way until
 * `formatAed` renders it (§3.1). There is no field on this page that a decimal
 * point could get into.
 */

export type LineKey =
  | 'CASH'
  | 'CARD'
  | 'BOOKINGS'
  | 'TIPS_DIRECT_CASH'
  | 'OPEN_SESSIONS';

export type LineUnit = 'FILS' | 'COUNT';

export interface ReconciliationLine {
  key: LineKey;
  label: string;
  unit: LineUnit;
  system: number;
  /** Null when the figure was optional and nobody wrote it down. */
  paper: number | null;
  /** Paper minus system. Positive means the paper is higher. */
  difference: number | null;
  toleranceFils: number;
  withinTolerance: boolean;
  compared: boolean;
  basis: string;
}

/* ───────────────────────── the sheet ───────────────────────── */

export interface TipLine {
  tipCount: number;
  totalFils: number;
}

export interface TherapistNightLine {
  employeeId: string;
  displayName: string;
  sessions: number;
  completed: number;
  inProgress: number;
  scheduled: number;
  noShow: number;
  cancelled: number;
  tipsDirectCashFils: number;
  tipsCollectedByBusinessFils: number;
}

export interface OpenSessionLine {
  reservationId: string;
  ref: string;
  therapist: string;
  room: string | null;
  startsAt: string;
  blockedUntil: string;
  actualArrivalAt: string | null;
  baseCostFils: number;
  overdue: boolean;
}

export interface CashDeskLine {
  userId: string;
  fullName: string;
  entries: number;
  amountFils: number;
}

export interface CheckLine {
  key: LineKey;
  label: string;
  unit: LineUnit;
  systemFigure: number;
  required: boolean;
  from: string;
}

export interface CloseOutSheetView {
  businessDay: string;
  generatedAt: string;
  isTonight: boolean;
  bookings: {
    total: number;
    scheduled: number;
    inProgress: number;
    completed: number;
    cancelled: number;
    noShow: number;
    needingCheckout: number;
  };
  guestsSeen: number;
  therapists: { worked: number; rostered: number };
  byTherapist: TherapistNightLine[];
  cash: {
    expectedCashFils: number;
    baseCashFils: number;
    tipCashFils: number;
    refundedCashFils: number;
    adjustmentCashFils: number;
    note: string;
  };
  card: {
    expectedCardFils: number;
    baseCardFils: number;
    tipCardFils: number;
    refundedCardFils: number;
    adjustmentCardFils: number;
    note: string;
  };
  tips: {
    directCash: TipLine;
    collectedByBusiness: TipLine;
    totalFils: number;
    payableFils: number;
    labels: { directCash: string; collectedByBusiness: string };
  };
  openSessions: OpenSessionLine[];
  cashDesk: CashDeskLine[];
  toCheck: CheckLine[];
  warnings: string[];
}

/* ───────────────────────── the record ───────────────────────── */

export interface ReconciliationRecordView {
  id: string;
  businessDay: string;
  verdict: ReconciliationVerdict;
  matched: boolean;
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
  cashDeskUserIds: string[];
  note: string | null;
  submittedByUserId: string;
  submittedAt: string;
  lines: ReconciliationLine[];
}

export interface StreakView {
  consecutiveMatchedNights: number;
  requiredNights: number;
  readyToSwitch: boolean;
  nights: Array<{ businessDay: string; verdict: ReconciliationVerdict }>;
  lastReconciledNight: string | null;
  brokenBy: {
    businessDay: string;
    reason: 'MISMATCHED' | 'NOT_RECONCILED' | 'NO_EARLIER_NIGHTS';
  } | null;
  unreconciledNights: string[];
  asOf: string;
}

export interface ReconciliationResultView extends ReconciliationRecordView {
  failing: ReconciliationLine[];
  streak: StreakView;
}

export interface ReconciliationHistoryView {
  from: string;
  to: string;
  submissions: number;
  nightsReconciled: number;
  entries: ReconciliationRecordView[];
}

/* ───────────────────────── the request ───────────────────────── */

export interface SubmitReconciliationBody {
  countedCashFils: number;
  paperBookings: number;
  paperCardTotalFils: number;
  paperTipsCashFils?: number;
  note?: string;
}

/**
 * Stable, machine-readable error codes. Spec §3.6 and Appendix B.
 * `code` is an enum the dashboard switches on; `message` is safe to show a
 * receptionist verbatim.
 */
export const ErrorCode = {
  // Booking conflicts -- raised by the database exclusion constraints (SQLSTATE 23P01)
  THERAPIST_ALREADY_BOOKED: 'THERAPIST_ALREADY_BOOKED',
  ROOM_ALREADY_BOOKED: 'ROOM_ALREADY_BOOKED',
  GUEST_ALREADY_BOOKED: 'GUEST_ALREADY_BOOKED',
  SLOT_CONFLICT: 'SLOT_CONFLICT',

  // Reservation lifecycle
  RESERVATION_NOT_FOUND: 'RESERVATION_NOT_FOUND',
  RESERVATION_NOT_SCHEDULED: 'RESERVATION_NOT_SCHEDULED',
  RESERVATION_NOT_IN_PROGRESS: 'RESERVATION_NOT_IN_PROGRESS',
  ILLEGAL_STATUS_TRANSITION: 'ILLEGAL_STATUS_TRANSITION',

  // The intake pipeline. A request holds no resource, so none of these are conflicts
  // over a slot -- they are conflicts over who is dealing with the enquiry.
  BOOKING_REQUEST_NOT_FOUND: 'BOOKING_REQUEST_NOT_FOUND',
  BOOKING_REQUEST_ALREADY_HANDLED: 'BOOKING_REQUEST_ALREADY_HANDLED',

  // Money
  BASE_PAYMENT_MISMATCH: 'BASE_PAYMENT_MISMATCH',
  BASE_PAYMENT_OUTSTANDING: 'BASE_PAYMENT_OUTSTANDING',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  TIP_METHOD_REQUIRED: 'TIP_METHOD_REQUIRED',
  TIP_METHOD_NOT_ALLOWED: 'TIP_METHOD_NOT_ALLOWED',
  TIP_EXCEEDS_SANITY_LIMIT: 'TIP_EXCEEDS_SANITY_LIMIT',
  TIP_ALREADY_REVERSED: 'TIP_ALREADY_REVERSED',
  TIP_ALREADY_PAID_OUT: 'TIP_ALREADY_PAID_OUT',
  PAYOUT_NOT_POSITIVE: 'PAYOUT_NOT_POSITIVE',
  ARRIVAL_TIME_IMPLAUSIBLE: 'ARRIVAL_TIME_IMPLAUSIBLE',
  COMPLETION_BEFORE_ARRIVAL: 'COMPLETION_BEFORE_ARRIVAL',

  // Corrections. Nothing is edited or deleted: a refund, an adjustment and a tip
  // reversal are all NEW signed rows pointing back at what they correct (§9.4),
  // so every one of these codes is about what may still be corrected -- never
  // about a failed write to history.
  PAYMENT_NOT_FOUND: 'PAYMENT_NOT_FOUND',
  /** The row is itself a correction (a REFUND), or carries no positive amount to return. */
  PAYMENT_NOT_REFUNDABLE: 'PAYMENT_NOT_REFUNDABLE',
  PAYMENT_ALREADY_REFUNDED: 'PAYMENT_ALREADY_REFUNDED',
  REFUND_EXCEEDS_PAYMENT: 'REFUND_EXCEEDS_PAYMENT',
  TIP_NOT_FOUND: 'TIP_NOT_FOUND',
  PAYOUT_BATCH_NOT_FOUND: 'PAYOUT_BATCH_NOT_FOUND',
  PAYOUT_ALREADY_ACKNOWLEDGED: 'PAYOUT_ALREADY_ACKNOWLEDGED',

  // Guests -- `notes` is preferences, never a medical history. Spec §11.5.
  GUEST_NOTES_MEDICAL_CONTENT: 'GUEST_NOTES_MEDICAL_CONTENT',
  GUEST_PHONE_TAKEN: 'GUEST_PHONE_TAKEN',

  // Data subject rights and retention (§11.4, §11.6). An erasure is an
  // ANONYMISATION, so "already erased" is a state of the row rather than a
  // missing one -- a second erase must not re-hash a number that is no longer
  // there, and must say so plainly instead of silently doing nothing.
  GUEST_ALREADY_ERASED: 'GUEST_ALREADY_ERASED',
  /** No consent of that type was ever recorded for this guest. */
  CONSENT_NOT_FOUND: 'CONSENT_NOT_FOUND',
  /** There is one, but it is already withdrawn or was a refusal. Nothing to end. */
  CONSENT_ALREADY_WITHDRAWN: 'CONSENT_ALREADY_WITHDRAWN',
  /** `prune_attribution()` is not installed -- the §5.6 migration never ran. */
  RETENTION_FUNCTION_MISSING: 'RETENTION_FUNCTION_MISSING',

  // Employees and the catalogue
  EMPLOYEE_HAS_FUTURE_BOOKINGS: 'EMPLOYEE_HAS_FUTURE_BOOKINGS',
  ROOM_NAME_TAKEN: 'ROOM_NAME_TAKEN',
  CATEGORY_NAME_TAKEN: 'CATEGORY_NAME_TAKEN',

  // Shifts and attendance
  SHIFT_ALREADY_PLANNED: 'SHIFT_ALREADY_PLANNED',
  SHIFT_ENDS_BEFORE_START: 'SHIFT_ENDS_BEFORE_START',
  SHIFT_ALREADY_CLOCKED_IN: 'SHIFT_ALREADY_CLOCKED_IN',
  SHIFT_NOT_CLOCKED_IN: 'SHIFT_NOT_CLOCKED_IN',
  SHIFT_ALREADY_CLOCKED_OUT: 'SHIFT_ALREADY_CLOCKED_OUT',
  SHIFT_CLOCK_OUT_BEFORE_CLOCK_IN: 'SHIFT_CLOCK_OUT_BEFORE_CLOCK_IN',

  // Idempotency
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  REQUEST_IN_PROGRESS: 'REQUEST_IN_PROGRESS',

  // Auth
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  PASSWORD_CHANGE_REQUIRED: 'PASSWORD_CHANGE_REQUIRED',
  INVALID_REFRESH_TOKEN: 'INVALID_REFRESH_TOKEN',
  REFRESH_TOKEN_EXPIRED: 'REFRESH_TOKEN_EXPIRED',
  REFRESH_TOKEN_REUSED: 'REFRESH_TOKEN_REUSED',
  INSUFFICIENT_ROLE: 'INSUFFICIENT_ROLE',
  PASSWORD_TOO_COMMON: 'PASSWORD_TOO_COMMON',

  // Configuration. Public routes have no token to take a branch from, so they
  // read DEFAULT_BRANCH_ID; if that is unset and the branch is ambiguous there
  // is nothing safe to guess at.
  BRANCH_NOT_CONFIGURED: 'BRANCH_NOT_CONFIGURED',

  // Reporting (§7.4). Reports are read-only, so the only thing they can refuse
  // is the QUESTION: a window so wide that answering it would take the daily
  // close-out off its 600 ms budget for everyone else on the branch (§12.1).
  // A period that ends before it starts is still VALIDATION_FAILED -- it is the
  // same mistake `resolveTradingWindow` already names everywhere else in the
  // money layer, and a second code for it would only split the dashboard's
  // handling in two.
  REPORT_RANGE_TOO_LARGE: 'REPORT_RANGE_TOO_LARGE',

  // The parallel pilot (§14, Phase 7). A reconciliation RECORDS a variance --
  // it does not refuse one, because a variance is a finding and suppressing it
  // is how a pilot passes on optimism. So there is exactly one thing this
  // endpoint will not do: certify a night that has not happened yet. The
  // figures for a future trading day are all zero, and a paper sheet compared
  // against them would read as a mismatch caused entirely by the calendar.
  //
  // A misconfigured cash tolerance gets no code here and deliberately so: it
  // fails the PROCESS at boot, not a request, and every code in this enum is
  // something the dashboard receives and switches on (§3.6).
  RECONCILIATION_DAY_IN_FUTURE: 'RECONCILIATION_DAY_IN_FUTURE',

  // Generic
  RATE_LIMITED: 'RATE_LIMITED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ApiErrorBody {
  error: {
    code: ErrorCode | string;
    message: string;
    details?: Record<string, unknown>;
    requestId?: string;
  };
}

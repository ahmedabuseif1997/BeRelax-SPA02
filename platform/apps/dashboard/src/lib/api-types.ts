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

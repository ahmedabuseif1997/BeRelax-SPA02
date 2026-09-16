import { z } from 'zod';
import {
  BookingRequestStatus, ConsentType, EmployeeStatus, PaymentMethod, ShiftStatus, SourceChannel, TipType, UserRole,
} from './enums';

const uuid = z.string().uuid();
const isoDateTime = z.string().datetime({ offset: true });
const fils = z.number().int().positive().max(100_000_000); // 1,000,000 AED ceiling per line

/* ─────────────────────────── auth ─────────────────────────── */

export const loginSchema = z.object({
  email: z.string().email().max(254).transform((s) => s.toLowerCase().trim()),
  password: z.string().min(1).max(64),
});
export type LoginDto = z.infer<typeof loginSchema>;

/**
 * Length beats character-class theatre: a 12-character minimum with a common-password
 * check stops far more real attacks than "must contain a symbol" ever did.
 * Capped at 64 because bcrypt silently truncates past 72 BYTES -- the cap makes that
 * limit unreachable rather than surprising. Spec §6.1.
 */
export const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters.')
  .max(64)
  .refine((s) => s.trim().length >= 12, 'Whitespace alone does not count.');

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(64),
  newPassword: passwordSchema,
});
export type ChangePasswordDto = z.infer<typeof changePasswordSchema>;

export const createUserSchema = z.object({
  email: z.string().email().max(254).transform((s) => s.toLowerCase().trim()),
  fullName: z.string().min(2).max(120),
  role: z.nativeEnum(UserRole),
  employeeId: uuid.optional(),
});
export type CreateUserDto = z.infer<typeof createUserSchema>;

/* ──────────────────────── reservations ─────────────────────── */

export const createReservationSchema = z
  .object({
    employeeId: uuid,
    serviceId: uuid,
    roomId: uuid.optional(),
    guestId: uuid.optional(),
    guestName: z.string().min(2).max(120).optional(),
    guestPhone: z.string().regex(/^\+9715\d{8}$/, 'Use E.164 format, e.g. +971501234567').optional(),
    guestEmail: z.string().email().max(254).optional(),
    startsAt: isoDateTime,
    durationMinutes: z.number().int().min(15).max(480).optional(),
    sourceChannel: z.nativeEnum(SourceChannel),
    notes: z.string().max(500).optional(),
  })
  .refine((v) => v.guestId || (v.guestName && v.guestPhone) || v.sourceChannel === 'WALK_IN', {
    message: 'Provide an existing guest, or a name and phone, unless this is an anonymous walk-in.',
  });
export type CreateReservationDto = z.infer<typeof createReservationSchema>;

/* ───────────────── the two-step financial workflow ─────────── */

/** Step 1. Base service cost is collected UP FRONT, before the treatment. Spec §8.2. */
export const checkInSchema = z.object({
  actualArrivalAt: isoDateTime.optional(),
  basePayments: z
    .array(
      z.object({
        method: z.nativeEnum(PaymentMethod),
        amountFils: fils,
        externalRef: z.string().max(64).optional(),
      }),
    )
    .min(1, 'Record at least one payment line.')
    .max(4, 'More than four payment lines is almost certainly a mistake.'),
  note: z.string().max(500).optional(),
});
export type CheckInDto = z.infer<typeof checkInSchema>;

/**
 * Step 2. The tip is decided AFTER the treatment, and `tip` is nullable because
 * most checkouts have none -- a fully recorded, perfectly valid outcome. Spec §8.3.
 */
export const checkoutSchema = z.object({
  completedAt: isoDateTime.optional(),
  tip: z
    .object({
      amountFils: fils,
      type: z.nativeEnum(TipType),
      method: z.nativeEnum(PaymentMethod).optional(),
      externalRef: z.string().max(64).optional(),
    })
    // Deliberately NOT refined here. Cross-field tip rules are enforced by the
    // checkout handler so it can return TIP_METHOD_REQUIRED and
    // TIP_METHOD_NOT_ALLOWED (Appendix B). A refine at this layer would fire
    // first and flatten both into a generic VALIDATION_FAILED, which tells a
    // receptionist nothing about what to fix.
    .nullable()
    .optional()
    .default(null),
  /** MANAGER+ override for the 3x sanity limit. */
  confirmLargeTip: z.boolean().optional().default(false),
  note: z.string().max(500).optional(),
});
export type CheckoutDto = z.infer<typeof checkoutSchema>;

export const cancelReservationSchema = z.object({
  reason: z.string().min(3).max(300),
});
export type CancelReservationDto = z.infer<typeof cancelReservationSchema>;

/* ─────────────────────────── guests ────────────────────────── */

/**
 * Reception types a number the way the guest says it. Normalising BEFORE the
 * pattern is applied is what makes "+971 50 123 4567", "0501234567" and
 * "+971501234567" the SAME guest rather than three of them -- the (branch,
 * phone) unique index is only ever as good as what reaches it.
 */
export function normaliseUaePhone(input: string): string {
  const compact = input.replace(/[\s().-]/g, '');
  if (compact.startsWith('00971')) return `+971${compact.slice(5)}`;
  if (compact.startsWith('971')) return `+971${compact.slice(3)}`;
  if (compact.startsWith('0')) return `+971${compact.slice(1)}`;
  return compact;
}

export const uaePhoneSchema = z
  .string()
  .min(1)
  .max(32)
  .transform(normaliseUaePhone)
  .refine((s) => /^\+9715\d{8}$/.test(s), 'Use a UAE mobile number, e.g. +971501234567');

/**
 * Preferences ONLY -- "no jasmine oil", "prefers firm pressure". The medical-term
 * screen is deliberately NOT a refine here: it belongs in the handler, so a
 * receptionist gets GUEST_NOTES_MEDICAL_CONTENT and the instruction to keep
 * medical information on paper instead of a flat VALIDATION_FAILED. §11.5.
 */
export const guestNotesSchema = z.string().max(500, 'Guest notes are capped at 500 characters.');

export const createGuestSchema = z.object({
  fullName: z.string().min(2).max(120),
  phone: uaePhoneSchema,
  email: z.string().email().max(254).optional(),
  notes: guestNotesSchema.optional(),
});
export type CreateGuestDto = z.infer<typeof createGuestSchema>;

export const updateGuestSchema = z
  .object({
    fullName: z.string().min(2).max(120).optional(),
    phone: uaePhoneSchema.optional(),
    email: z.string().email().max(254).nullable().optional(),
    notes: guestNotesSchema.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field to change.');
export type UpdateGuestDto = z.infer<typeof updateGuestSchema>;

/**
 * `ipAddress` is absent on purpose: proof of consent needs the address the
 * request actually came from, not one the caller nominates. §7.5, §11.3.
 */
export const createGuestConsentSchema = z.object({
  type: z.nativeEnum(ConsentType),
  granted: z.boolean(),
  source: z.string().min(2).max(120),
  policyVersion: z.string().min(1).max(40),
});
export type CreateGuestConsentDto = z.infer<typeof createGuestConsentSchema>;

/* ────────────────────────── employees ──────────────────────── */

/** 10000 bps = 100% of the base service. §3.1. */
const commissionBps = z.number().int().min(0).max(10_000);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date in YYYY-MM-DD form.');

export const createEmployeeSchema = z.object({
  displayName: z.string().min(2).max(120),
  /** HR only. Restricted on the way out by §6.4, not on the way in. */
  legalName: z.string().min(2).max(160).optional(),
  phone: uaePhoneSchema.optional(),
  status: z.nativeEnum(EmployeeStatus).optional(),
  commissionBps: commissionBps.optional(),
  hiredOn: isoDate.optional(),
  photoUrl: z.string().url().max(500).optional(),
});
export type CreateEmployeeDto = z.infer<typeof createEmployeeSchema>;

/**
 * `commissionBps` is absent: a commission change is audited with before/after
 * and has its own endpoint, so it cannot ride along in a name edit. §9.6.
 */
export const updateEmployeeSchema = z
  .object({
    displayName: z.string().min(2).max(120).optional(),
    legalName: z.string().min(2).max(160).nullable().optional(),
    phone: uaePhoneSchema.nullable().optional(),
    hiredOn: isoDate.nullable().optional(),
    photoUrl: z.string().url().max(500).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field to change.');
export type UpdateEmployeeDto = z.infer<typeof updateEmployeeSchema>;

export const updateEmployeeStatusSchema = z.object({
  status: z.nativeEnum(EmployeeStatus),
});
export type UpdateEmployeeStatusDto = z.infer<typeof updateEmployeeStatusSchema>;

export const updateEmployeeCommissionSchema = z.object({
  commissionBps,
  note: z.string().max(300).optional(),
});
export type UpdateEmployeeCommissionDto = z.infer<typeof updateEmployeeCommissionSchema>;

/* ────────────────────────── catalogue ──────────────────────── */

export const createServiceSchema = z.object({
  categoryId: uuid,
  name: z.string().min(2).max(120),
  durationMinutes: z.number().int().min(15).max(480),
  priceFils: fils,
  description: z.string().max(1000).optional(),
  requiresRoom: z.boolean().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9_999).optional(),
});
export type CreateServiceDto = z.infer<typeof createServiceSchema>;

/**
 * `priceFils` stays here -- a price change is audited with before/after and
 * never touches an existing booking, because `Reservation.baseCostFils` is a
 * snapshot taken at booking time. §9.6, §4.
 */
export const updateServiceSchema = z
  .object({
    categoryId: uuid.optional(),
    name: z.string().min(2).max(120).optional(),
    durationMinutes: z.number().int().min(15).max(480).optional(),
    priceFils: fils.optional(),
    description: z.string().max(1000).nullable().optional(),
    requiresRoom: z.boolean().optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(9_999).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field to change.');
export type UpdateServiceDto = z.infer<typeof updateServiceSchema>;

export const createServiceCategorySchema = z.object({
  name: z.string().min(2).max(120),
  sortOrder: z.number().int().min(0).max(9_999).optional(),
  isActive: z.boolean().optional(),
});
export type CreateServiceCategoryDto = z.infer<typeof createServiceCategorySchema>;

export const updateServiceCategorySchema = z
  .object({
    name: z.string().min(2).max(120).optional(),
    sortOrder: z.number().int().min(0).max(9_999).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field to change.');
export type UpdateServiceCategoryDto = z.infer<typeof updateServiceCategorySchema>;

export const createRoomSchema = z.object({
  name: z.string().min(1).max(60),
  capacity: z.number().int().min(1).max(20).optional(),
  isActive: z.boolean().optional(),
});
export type CreateRoomDto = z.infer<typeof createRoomSchema>;

export const updateRoomSchema = z
  .object({
    name: z.string().min(1).max(60).optional(),
    capacity: z.number().int().min(1).max(20).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field to change.');
export type UpdateRoomDto = z.infer<typeof updateRoomSchema>;

/* ──────────────────────────── shifts ───────────────────────── */

/**
 * No `businessDay` field: the trading day is DERIVED from `plannedStart`, so a
 * shift starting at 23:00 and a shift starting at 01:00 the next morning cannot
 * be filed under different days by a caller who got the date box wrong. §3.3.
 *
 * `plannedEnd > plannedStart` is checked in the handler, not refined here, so
 * the reply carries SHIFT_ENDS_BEFORE_START rather than VALIDATION_FAILED.
 */
export const createShiftSchema = z.object({
  employeeId: uuid,
  plannedStart: isoDateTime,
  plannedEnd: isoDateTime,
  note: z.string().max(300).optional(),
});
export type CreateShiftDto = z.infer<typeof createShiftSchema>;

export const updateShiftSchema = z
  .object({
    plannedStart: isoDateTime.optional(),
    plannedEnd: isoDateTime.optional(),
    status: z.nativeEnum(ShiftStatus).optional(),
    note: z.string().max(300).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Send at least one field to change.');
export type UpdateShiftDto = z.infer<typeof updateShiftSchema>;

/** `at` is for correcting a clock a receptionist forgot to press, not the norm. */
export const clockShiftSchema = z.object({
  at: isoDateTime.optional(),
});
export type ClockShiftDto = z.infer<typeof clockShiftSchema>;

/* ───────────────────────── attribution ─────────────────────── */

export const touchSchema = z.object({
  ts: isoDateTime,
  source: z.string().max(120),
  medium: z.string().max(60),
  campaign: z.string().max(200).optional(),
  term: z.string().max(200).optional(),
  content: z.string().max(200).optional(),
  gclid: z.string().max(200).optional(),
  fbclid: z.string().max(200).optional(),
  referrer: z.string().max(253).optional(),
  landing: z.string().max(300).optional(),
});
export type Touch = z.infer<typeof touchSchema>;

export const attributionSchema = z.object({
  v: z.literal(1),
  visitorId: uuid,
  first: touchSchema,
  last: touchSchema,
  touches: z.array(touchSchema).max(10),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type AttributionPayload = z.infer<typeof attributionSchema>;

/* ────────────────────────── availability ───────────────────── */

/**
 * The query behind the booking grid's free-slot view. Every field is optional
 * except in effect the day, which defaults to today's trading day in the
 * handler -- reception opens the grid far more often than it navigates it.
 */
export const availabilityQuerySchema = z.object({
  businessDay: isoDate.optional(),
  /** Narrows the windows to those long enough to hold this treatment. */
  serviceId: uuid.optional(),
  employeeId: uuid.optional(),
});
export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;

/* ──────────────────── booking requests (inbox) ─────────────── */

export const listBookingRequestsQuerySchema = z.object({
  status: z.nativeEnum(BookingRequestStatus).optional(),
  /** Coerced because this arrives as a query string, never as JSON. */
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});
export type ListBookingRequestsQuery = z.infer<typeof listBookingRequestsQuerySchema>;

/**
 * Turning an enquiry into a held slot. The therapist, the time and the room are
 * reception's decision, not the guest's -- the request only ever carried a
 * preference. `serviceId` overrides whatever the website form asked for, for
 * the very common case of the guest changing their mind on the phone.
 *
 * Deliberately NOT refined against the request's own fields: the handler needs
 * to answer with NOT_FOUND for a service off this branch's menu rather than a
 * flat VALIDATION_FAILED.
 */
export const convertBookingRequestSchema = z.object({
  employeeId: uuid,
  serviceId: uuid.optional(),
  roomId: uuid.optional(),
  startsAt: isoDateTime,
  durationMinutes: z.number().int().min(15).max(480).optional(),
  notes: z.string().max(500).optional(),
});
export type ConvertBookingRequestDto = z.infer<typeof convertBookingRequestSchema>;

/*
 * There is deliberately NO schema for declining or marking spam, and those
 * routes take no body. `booking_requests` has nowhere to put a free-text
 * reason, and an endpoint that accepts a field it then silently drops is worse
 * than one that never offered it: `status`, `handledByUserId` and `handledAt`
 * are the whole accountability trail the table can actually keep. Add the
 * column first on the day the business asks why an enquiry was turned away.
 */

/* ───────────────────────── the public site ─────────────────── */

/**
 * Looser than `uaePhoneSchema` on purpose. Reception types a number it has just
 * heard, so the desk insists on a UAE mobile and catches the typo at the
 * keyboard. The website is read by hotel guests and visitors whose only number
 * is a foreign one, and turning those enquiries away to keep one regex tidy
 * would cost real bookings. UAE forms still normalise to +9715... first, so the
 * (branch, phone) unique index keeps finding the same returning guest.
 */
export const publicPhoneSchema = z
  .string()
  .min(1)
  .max(32)
  .transform(normaliseUaePhone)
  .refine(
    (s) => /^\+9715\d{8}$/.test(s) || /^\+[1-9]\d{7,14}$/.test(s),
    'Enter a phone number in international format, e.g. +971501234567',
  );

/**
 * The website booking form. `attribution` is the blob `attribution.js` keeps in
 * localStorage; it is optional because a visitor who declined the consent gate
 * (§11.3) still gets to book, they are simply unattributed.
 */
export const publicBookingRequestSchema = z.object({
  guestName: z.string().min(2).max(120),
  guestPhone: publicPhoneSchema,
  guestEmail: z.string().email().max(254).optional(),
  requestedServiceId: uuid.optional(),
  requestedAt: isoDateTime.optional(),
  message: z.string().max(1000).optional(),
  /** Verified by Cloudflare before this handler runs. §7.1. */
  turnstileToken: z.string().max(4096).optional(),
  attribution: attributionSchema.nullish(),
});
export type PublicBookingRequestDto = z.infer<typeof publicBookingRequestSchema>;

/**
 * The `/r/wa` and `/r/call` click-out query. `text` is the pre-composed WhatsApp
 * message; it is length-capped here and scrubbed in the handler, because this
 * URL is pasted into ads and social posts and is therefore attacker-reachable.
 */
export const redirectQuerySchema = z.object({
  ctx: z.string().max(60).optional(),
  /**
   * Bounded here only so an oversized body is a cheap rejection. The real limit
   * is applied in the handler, which trims to a sane message length rather than
   * 422-ing a guest who tapped a WhatsApp button on an old advert.
   */
  text: z.string().max(2_000).optional(),
  path: z.string().max(300).optional(),
  utm_source: z.string().max(120).optional(),
  utm_medium: z.string().max(60).optional(),
  utm_campaign: z.string().max(200).optional(),
  gclid: z.string().max(200).optional(),
  fbclid: z.string().max(200).optional(),
});
export type RedirectQuery = z.infer<typeof redirectQuerySchema>;

/* ────────── corrections, payout batches and the audit trail (§9) ────────── */

/**
 * Signed, because a correction goes whichever way the mistake went: a discount
 * is negative, a missed upsell recorded late is positive. Zero is rejected by
 * the handler rather than here, so it answers `INVALID_AMOUNT` instead of a
 * flat `VALIDATION_FAILED` -- same reasoning as the tip rules above.
 */
const signedFils = z.number().int().min(-100_000_000).max(100_000_000);

/**
 * `amountFils` is OPTIONAL and omitting it refunds whatever is left of the
 * original, which is the overwhelmingly common case. A partial refund names its
 * amount. Either way the original payment row is untouched: what this creates is
 * a new negative REFUND row pointing back at it. §9.4.
 */
export const refundPaymentSchema = z.object({
  amountFils: fils.optional(),
  reason: z.string().min(3, 'Say why the money is going back.').max(300),
  /** Defaults to the method the money arrived by -- it normally goes back the same way. */
  method: z.nativeEnum(PaymentMethod).optional(),
  externalRef: z.string().max(64).optional(),
});
export type RefundPaymentDto = z.infer<typeof refundPaymentSchema>;

/**
 * A discount, a goodwill write-down or a correction to what was collected.
 * The reason is mandatory: an adjustment without one is indistinguishable from
 * a till shortfall six months later. §8.2, §9.4.
 */
export const createAdjustmentSchema = z.object({
  reservationId: uuid,
  amountFils: signedFils,
  method: z.nativeEnum(PaymentMethod),
  reason: z.string().min(3, 'An adjustment needs a reason.').max(300),
  externalRef: z.string().max(64).optional(),
});
export type CreateAdjustmentDto = z.infer<typeof createAdjustmentSchema>;

export const reverseTipSchema = z.object({
  reason: z.string().min(3, 'Say what was wrong with the tip.').max(300),
});
export type ReverseTipDto = z.infer<typeof reverseTipSchema>;

/** §9.5. The period is in trading days, so a 01:30 tip settles with the night it belongs to. */
export const createPayoutSchema = z.object({
  employeeId: uuid,
  periodStart: isoDate,
  periodEnd: isoDate,
  method: z.nativeEnum(PaymentMethod),
  note: z.string().max(500).optional(),
});
export type CreatePayoutDto = z.infer<typeof createPayoutSchema>;

/** Query strings arrive as text, hence `coerce` on every number below. */
export const ledgerQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(200),
});
export type LedgerQuery = z.infer<typeof ledgerQuerySchema>;

export const earningsQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
});
export type EarningsQuery = z.infer<typeof earningsQuerySchema>;

/** What a manager opens during a dispute. §9.7. */
export const auditQuerySchema = z.object({
  entityType: z.string().min(1).max(60).optional(),
  entityId: uuid.optional(),
  /** The person who did it, not the person it was done to. */
  actorUserId: uuid.optional(),
  action: z.string().min(1).max(60).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).max(100_000).optional().default(0),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

import { z } from 'zod';
import {
  PaymentMethod, SourceChannel, TipType, UserRole,
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
    .refine((t) => (t.type === 'COLLECTED_BY_BUSINESS' ? !!t.method : !t.method), {
      message:
        'A tip collected by the business needs a payment method; cash handed straight to the therapist must not have one.',
    })
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

/** Mirrors the Postgres enums in prisma/schema.prisma. Keep the two in step. */

export const UserRole = {
  OWNER: 'OWNER',
  MANAGER: 'MANAGER',
  RECEPTIONIST: 'RECEPTIONIST',
  THERAPIST: 'THERAPIST',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

/** Ordered most- to least-privileged, for `atLeast` checks. */
export const ROLE_RANK: Record<UserRole, number> = {
  OWNER: 40,
  MANAGER: 30,
  RECEPTIONIST: 20,
  THERAPIST: 10,
};

export const ReservationStatus = {
  SCHEDULED: 'SCHEDULED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  NO_SHOW: 'NO_SHOW',
} as const;
export type ReservationStatus = (typeof ReservationStatus)[keyof typeof ReservationStatus];

/** The state machine, mirrored from the `trg_reservations_status` database trigger. */
export const ALLOWED_STATUS_TRANSITIONS: Record<ReservationStatus, readonly ReservationStatus[]> = {
  SCHEDULED: ['IN_PROGRESS', 'CANCELLED', 'NO_SHOW'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
};

export const PaymentKind = {
  BASE: 'BASE',
  TIP: 'TIP',
  REFUND: 'REFUND',
  ADJUSTMENT: 'ADJUSTMENT',
} as const;
export type PaymentKind = (typeof PaymentKind)[keyof typeof PaymentKind];

export const PaymentMethod = {
  CASH: 'CASH',
  CARD: 'CARD',
  BANK_TRANSFER: 'BANK_TRANSFER',
  VOUCHER: 'VOUCHER',
  COMPLIMENTARY: 'COMPLIMENTARY',
} as const;
export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod];

export const TipType = {
  /** Guest hands cash to the therapist. The business never holds it, so it owes nothing. */
  DIRECT_CASH: 'DIRECT_CASH',
  /** Added to the bill. The business holds it and now owes the therapist. */
  COLLECTED_BY_BUSINESS: 'COLLECTED_BY_BUSINESS',
} as const;
export type TipType = (typeof TipType)[keyof typeof TipType];

export const LedgerEntryType = {
  TIP_ACCRUAL: 'TIP_ACCRUAL',
  COMMISSION_ACCRUAL: 'COMMISSION_ACCRUAL',
  PAYOUT: 'PAYOUT',
  ADJUSTMENT: 'ADJUSTMENT',
  REVERSAL: 'REVERSAL',
} as const;
export type LedgerEntryType = (typeof LedgerEntryType)[keyof typeof LedgerEntryType];

export const SourceChannel = {
  WEBSITE_FORM: 'WEBSITE_FORM',
  WHATSAPP: 'WHATSAPP',
  PHONE: 'PHONE',
  WALK_IN: 'WALK_IN',
  INSTAGRAM: 'INSTAGRAM',
  GOOGLE_MAPS: 'GOOGLE_MAPS',
  REFERRAL: 'REFERRAL',
  OTHER: 'OTHER',
} as const;
export type SourceChannel = (typeof SourceChannel)[keyof typeof SourceChannel];

export const BookingRequestStatus = {
  NEW: 'NEW',
  CONTACTED: 'CONTACTED',
  CONVERTED: 'CONVERTED',
  DECLINED: 'DECLINED',
  SPAM: 'SPAM',
} as const;
export type BookingRequestStatus = (typeof BookingRequestStatus)[keyof typeof BookingRequestStatus];

export const EmployeeStatus = { ACTIVE: 'ACTIVE', ON_LEAVE: 'ON_LEAVE', INACTIVE: 'INACTIVE' } as const;
export type EmployeeStatus = (typeof EmployeeStatus)[keyof typeof EmployeeStatus];

export const ShiftStatus = { PLANNED: 'PLANNED', ACTIVE: 'ACTIVE', ENDED: 'ENDED', ABSENT: 'ABSENT' } as const;
export type ShiftStatus = (typeof ShiftStatus)[keyof typeof ShiftStatus];

export const ConsentType = {
  DATA_PROCESSING: 'DATA_PROCESSING',
  MARKETING: 'MARKETING',
  PHOTO: 'PHOTO',
} as const;
export type ConsentType = (typeof ConsentType)[keyof typeof ConsentType];

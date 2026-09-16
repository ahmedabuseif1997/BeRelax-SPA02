-- The heart of the system: double-booking is prevented BY THE DATABASE.
-- Spec §5.2.
--
-- There is no "check then insert" anywhere in the application. That pattern has
-- a race window and will double-book on a busy Friday when two receptionists tap
-- Confirm at the same moment. The service layer inserts and lets these
-- constraints arbitrate; SQLSTATE 23P01 is mapped to a 409.

-- 1. A therapist cannot be in two places at once.
ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_no_therapist_overlap"
  EXCLUDE USING gist (
    "branch_id"   WITH =,
    "employee_id" WITH =,
    tstzrange("starts_at", "blocked_until", '[)') WITH &&
  )
  WHERE ("status" IN ('SCHEDULED', 'IN_PROGRESS'));

-- 2. A room cannot hold two guests at once.
--    Rows with a NULL room_id are skipped automatically: NULL = NULL is never
--    true, so services that need no room never conflict.
ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_no_room_overlap"
  EXCLUDE USING gist (
    "branch_id" WITH =,
    "room_id"   WITH =,
    tstzrange("starts_at", "blocked_until", '[)') WITH &&
  )
  WHERE ("status" IN ('SCHEDULED', 'IN_PROGRESS') AND "room_id" IS NOT NULL);

-- 3. A guest cannot be booked into two overlapping treatments.
--    Catches the classic reception double-entry. Uses ends_at rather than
--    blocked_until: the guest is free the moment their treatment ends, even
--    though the room still needs cleaning.
ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_no_guest_overlap"
  EXCLUDE USING gist (
    "branch_id" WITH =,
    "guest_id"  WITH =,
    tstzrange("starts_at", "ends_at", '[)') WITH &&
  )
  WHERE ("status" IN ('SCHEDULED', 'IN_PROGRESS') AND "guest_id" IS NOT NULL);

-- Half-open '[)' ranges above mean a 13:00-14:00 booking and a 14:00-15:00
-- booking do NOT overlap. With the default '[]' they would, and reception
-- could never book back-to-back sessions.

ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_positive_duration"  CHECK ("duration_minutes" > 0),
  ADD CONSTRAINT "reservations_ends_after_starts"  CHECK ("ends_at" > "starts_at"),
  ADD CONSTRAINT "reservations_blocked_after_ends" CHECK ("blocked_until" >= "ends_at"),
  ADD CONSTRAINT "reservations_nonneg_base"        CHECK ("base_cost_fils" >= 0);

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_nonzero" CHECK ("amount_fils" <> 0);

ALTER TABLE "tips"
  ADD CONSTRAINT "tips_nonzero" CHECK ("amount_fils" <> 0),
  -- A DIRECT_CASH tip never entered the business, so it can carry neither a
  -- payment method nor a payment row. Enforcing the invariant here means the
  -- ledger's meaning cannot be corrupted by a bug in the checkout handler.
  ADD CONSTRAINT "tips_direct_cash_has_no_payment" CHECK (
    ("type" = 'DIRECT_CASH'           AND "payment_id" IS NULL AND "method" IS NULL)
 OR ("type" = 'COLLECTED_BY_BUSINESS' AND "method" IS NOT NULL)
  );

ALTER TABLE "therapist_payout_ledger"
  ADD CONSTRAINT "ledger_nonzero" CHECK ("amount_fils" <> 0);

-- Case-insensitive unique email, live users only. A soft-deleted user frees
-- their address for reuse.
CREATE UNIQUE INDEX "users_email_unique_active"
  ON "users" (lower("email"))
  WHERE "deleted_at" IS NULL;

-- Data minimisation, enforced rather than documented. `notes` holds operational
-- preferences -- pressure, oil, preferred therapist -- and a hard length cap
-- stops the field quietly becoming a medical history. This system stores no
-- health data at all; see the specification §11.5.
ALTER TABLE "guests"
  ADD CONSTRAINT "guests_notes_are_preferences_not_history"
  CHECK ("notes" IS NULL OR length("notes") <= 500);

-- Balance queries are SUM(amount_fils) over the ledger; there is deliberately
-- no stored balance column. INCLUDE makes that sum an index-only scan.
CREATE INDEX "therapist_payout_ledger_balance_idx"
  ON "therapist_payout_ledger" ("employee_id") INCLUDE ("amount_fils");

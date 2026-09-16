-- `payments` carried only `collected_at`, which is a BUSINESS timestamp: the
-- moment money changed hands, supplied by reception. Check-in accepts a
-- retro-dated arrival (§8.2) — a guest who walked in twenty minutes ago — so
-- that value can legitimately sit in the past.
--
-- Invariant 7 asks a different question: was this row recorded in the same
-- breath as its audit entry? Answering it against `collected_at` makes every
-- retro-dated check-in look like an unaudited write. The two timestamps mean
-- different things and the table needs both.

ALTER TABLE "payments"
  ADD COLUMN "created_at" timestamptz(6) NOT NULL DEFAULT now();

-- Backfilling is a genuine row UPDATE, and the append-only guard from
-- 20260916200300 refuses it — correctly: that trigger is the reason the
-- financial history can be trusted, and a migration is not exempt by accident.
-- It is suspended here deliberately, for one statement, inside this migration's
-- transaction, and restored immediately. If this block ever needs to grow
-- beyond a backfill of a newly added column, that is the signal to stop and
-- write a reversing entry instead.
ALTER TABLE "payments" DISABLE TRIGGER "trg_payments_no_update";

UPDATE "payments" SET "created_at" = "collected_at";

ALTER TABLE "payments" ENABLE TRIGGER "trg_payments_no_update";

CREATE INDEX "payments_created_at_idx" ON "payments" ("created_at");

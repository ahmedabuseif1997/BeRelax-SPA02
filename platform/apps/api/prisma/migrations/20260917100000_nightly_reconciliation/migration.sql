-- The parallel pilot's nightly reconciliation. Spec §14 (Phase 7) and §15.4.
--
-- Phase 7 runs this CRM alongside reception's existing paper process for two
-- weeks and switches over "only when the numbers match for five consecutive
-- nights". This table is what makes that sentence checkable: one row per
-- submission, holding what the paper said, what the system said at that moment,
-- and the difference between them.
--
-- WHY THE SYSTEM FIGURES ARE STORED AND NOT RECOMPUTED
--
-- A night signed off on Tuesday must still read the way it read on Tuesday. A
-- refund filed on Thursday against a Tuesday payment legitimately moves
-- Tuesday's live total; if this table only held the paper side and recomputed
-- the rest on read, that refund would silently turn a matched night into a
-- mismatched one months later, and the streak would change underneath the
-- people who signed it off. So the comparison is snapshotted -- including
-- `lines`, the full line-by-line record exactly as it was presented -- and the
-- live report stays the live report.
--
-- WHY THERE IS NO UNIQUE CONSTRAINT ON (branch_id, business_day)
--
-- A night can be reconciled more than once: the manager finds the missing slip,
-- closes the session somebody forgot, and runs it again. That correction is a
-- NEW row pointing at the one it supersedes -- never an edit -- which is the
-- same rule §9.4 applies to money, for the same reason. The effective verdict
-- for a night is its most recent submission; every earlier attempt stays
-- visible, because "we reconciled it three times before it matched" is exactly
-- the kind of thing a pilot exists to surface.

-- CreateEnum
CREATE TYPE "ReconciliationVerdict" AS ENUM ('MATCHED', 'MATCHED_WITH_NOTE', 'MISMATCHED');

-- CreateTable
CREATE TABLE "nightly_reconciliations" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "branch_id" UUID NOT NULL,
    "business_day" DATE NOT NULL,
    "verdict" "ReconciliationVerdict" NOT NULL,
    "counted_cash_fils" INTEGER NOT NULL,
    "paper_bookings" INTEGER NOT NULL,
    "paper_card_total_fils" INTEGER NOT NULL,
    "paper_tips_cash_fils" INTEGER,
    "system_cash_fils" INTEGER NOT NULL,
    "system_bookings" INTEGER NOT NULL,
    "system_card_total_fils" INTEGER NOT NULL,
    "system_tips_cash_fils" INTEGER NOT NULL,
    "cash_variance_fils" INTEGER NOT NULL,
    "bookings_variance" INTEGER NOT NULL,
    "card_variance_fils" INTEGER NOT NULL,
    "tips_cash_variance_fils" INTEGER,
    "cash_tolerance_fils" INTEGER NOT NULL,
    "open_sessions" INTEGER NOT NULL,
    "lines" JSONB NOT NULL,
    "cash_desk_user_ids" UUID[],
    "note" TEXT,
    "submitted_by_user_id" UUID NOT NULL,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersedes_id" UUID,

    CONSTRAINT "nightly_reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "nightly_reconciliations_branch_id_business_day_submitted_at_idx" ON "nightly_reconciliations"("branch_id", "business_day", "submitted_at");

-- CreateIndex
CREATE INDEX "nightly_reconciliations_branch_id_submitted_at_idx" ON "nightly_reconciliations"("branch_id", "submitted_at");

-- AddForeignKey
ALTER TABLE "nightly_reconciliations" ADD CONSTRAINT "nightly_reconciliations_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────
-- HAND-WRITTEN, BELOW THIS LINE. Prisma cannot express any of it. §5.
-- ─────────────────────────────────────────────────────────────

-- Money is integer fils and a count is a count (§3.1). These are the arithmetic
-- facts the application already enforces, asserted again where they cannot be
-- bypassed: a counted drawer and a terminal total are never negative, a night
-- never had a negative number of bookings, and a tolerance is never negative --
-- a negative tolerance would widen into a window that accepts anything.
ALTER TABLE "nightly_reconciliations"
  ADD CONSTRAINT "nightly_reconciliations_non_negative_paper_chk"
  CHECK ("counted_cash_fils" >= 0
     AND "paper_bookings" >= 0
     AND "paper_card_total_fils" >= 0
     AND ("paper_tips_cash_fils" IS NULL OR "paper_tips_cash_fils" >= 0)),
  ADD CONSTRAINT "nightly_reconciliations_tolerance_chk"
  CHECK ("cash_tolerance_fils" >= 0 AND "open_sessions" >= 0);

-- The variance columns are DERIVED -- paper minus system -- and storing a
-- derived value is only safe if it cannot drift from what it was derived from.
-- Without this, a bad write could record a matched verdict beside figures that
-- plainly disagree, and the one table the switchover decision rests on would be
-- the one telling the story wrong.
ALTER TABLE "nightly_reconciliations"
  ADD CONSTRAINT "nightly_reconciliations_variance_chk"
  CHECK ("cash_variance_fils" = "counted_cash_fils" - "system_cash_fils"
     AND "bookings_variance" = "paper_bookings" - "system_bookings"
     AND "card_variance_fils" = "paper_card_total_fils" - "system_card_total_fils"
     AND ("paper_tips_cash_fils" IS NULL) = ("tips_cash_variance_fils" IS NULL)
     AND ("paper_tips_cash_fils" IS NULL
          OR "tips_cash_variance_fils" = "paper_tips_cash_fils" - "system_tips_cash_fils"));

-- The terminal's Z-report is authoritative and must agree TO THE FIL (§15.4 is
-- about cash; a card total has no counting error to forgive). Cash gets the
-- configured tolerance, which defaults to zero. A row claiming a match while
-- one of its lines is outside those bounds is a lie the streak would then
-- count, so the database refuses to hold one.
ALTER TABLE "nightly_reconciliations"
  ADD CONSTRAINT "nightly_reconciliations_verdict_chk"
  CHECK (
    "verdict" = CASE
      WHEN NOT (abs("cash_variance_fils") <= "cash_tolerance_fils"
                AND "card_variance_fils" = 0
                AND "bookings_variance" = 0
                AND "open_sessions" = 0
                AND ("tips_cash_variance_fils" IS NULL
                     OR abs("tips_cash_variance_fils") <= "cash_tolerance_fils"))
        THEN 'MISMATCHED'::"ReconciliationVerdict"
      WHEN "note" IS NOT NULL
        THEN 'MATCHED_WITH_NOTE'::"ReconciliationVerdict"
      ELSE 'MATCHED'::"ReconciliationVerdict"
    END
  );

-- A correction points at the submission it replaces, and it must be a real one
-- for the same branch and the same night. Self-reference is excluded by the
-- primary key being generated on insert, so the only way to hit it is deliberate.
ALTER TABLE "nightly_reconciliations"
  ADD CONSTRAINT "nightly_reconciliations_supersedes_id_fkey"
  FOREIGN KEY ("supersedes_id") REFERENCES "nightly_reconciliations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "nightly_reconciliations_supersedes_idx"
  ON "nightly_reconciliations" ("supersedes_id") WHERE "supersedes_id" IS NOT NULL;

-- Append-only, enforced the way §5.4 enforces it on payments and the audit log,
-- and with the same function. A reconciliation that can be edited after the fact
-- certifies nothing: the entire value of "five consecutive nights matched" is
-- that nobody could have gone back and made it so.
--
-- `forbid_mutation()` was created by 20260916200300_append_only.
CREATE TRIGGER trg_reconciliation_no_update BEFORE UPDATE ON "nightly_reconciliations"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER trg_reconciliation_no_delete BEFORE DELETE ON "nightly_reconciliations"
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Append-only enforcement. Spec §5.4.
--
-- An audit log that can be edited is not an audit log. These three tables are
-- locked at the database level so that even a compromised API key or a careless
-- console session cannot rewrite history. During a breach, financial_audit_log
-- is the only record you can still trust -- which is precisely why it must not
-- be mutable.

CREATE OR REPLACE FUNCTION forbid_mutation()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    '% is append-only; correct by inserting a reversing row, never by %',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- financial_audit_log: absolutely immutable.
CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON financial_audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON financial_audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- payments: never edited, never deleted. A mistake is corrected by a REFUND or
-- ADJUSTMENT row pointing back via reverses_payment_id.
--
-- Note: this makes Prisma's `payment.update()` and `payment.upsert()` throw.
-- That is intentional -- the repository layer exposes `create` only.
CREATE TRIGGER trg_payments_no_update BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER trg_payments_no_delete BEFORE DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- therapist_payout_ledger: immutable EXCEPT for attaching a payout batch, which
-- is how a pending accrual becomes a paid one. That is the single permitted
-- mutation, it only ever goes from NULL, and every other column must be
-- untouched in the same statement.
CREATE OR REPLACE FUNCTION ledger_guard()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'therapist_payout_ledger rows are never deleted; insert a REVERSAL'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
    IF NEW.payout_batch_id IS DISTINCT FROM OLD.payout_batch_id
       AND OLD.payout_batch_id IS NULL
       AND ROW(NEW.branch_id, NEW.employee_id, NEW.entry_type, NEW.amount_fils,
               NEW.business_day, NEW.reservation_id, NEW.tip_id,
               NEW.created_by_user_id, NEW.created_at)
         IS NOT DISTINCT FROM
           ROW(OLD.branch_id, OLD.employee_id, OLD.entry_type, OLD.amount_fils,
               OLD.business_day, OLD.reservation_id, OLD.tip_id,
               OLD.created_by_user_id, OLD.created_at)
    THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'therapist_payout_ledger amounts are immutable; insert a REVERSAL'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_ledger_guard BEFORE UPDATE OR DELETE ON therapist_payout_ledger
  FOR EACH ROW EXECUTE FUNCTION ledger_guard();

-- Derived columns and the status state machine. Spec §5.3.

-- ── Why ends_at and blocked_until are STORED columns ──────────────────────
-- The obvious design computes the end inside the exclusion constraint:
--
--   tstzrange(starts_at, starts_at + (duration_minutes || ' minutes')::interval)
--
-- PostgreSQL rejects it: "functions in index expression must be marked
-- IMMUTABLE". Adding an interval to a timestamptz is STABLE, not immutable,
-- because month and day components depend on the session TimeZone. A
-- GENERATED ALWAYS ... STORED column fails for exactly the same reason.
--
-- You will find advice to wrap the arithmetic in a hand-written IMMUTABLE
-- function. Do not. Lying to the planner about volatility produces an index
-- that silently disagrees with the data, and the failure mode is a corrupt
-- constraint that lets a double-booking through months later.
--
-- A BEFORE trigger is free to use stable functions, so that is what this is.
-- The application never writes these three columns; anything it sends is
-- overwritten here.
CREATE OR REPLACE FUNCTION reservations_derive_columns()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_turnaround int;
BEGIN
  SELECT turnaround_mins INTO v_turnaround FROM branches WHERE id = NEW.branch_id;
  v_turnaround := COALESCE(v_turnaround, 0);

  NEW.ends_at       := NEW.starts_at + make_interval(mins => NEW.duration_minutes);
  NEW.blocked_until := NEW.ends_at   + make_interval(mins => v_turnaround);
  NEW.business_day  := business_day(NEW.starts_at);
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_reservations_derive
  BEFORE INSERT OR UPDATE OF starts_at, duration_minutes, branch_id
  ON reservations
  FOR EACH ROW EXECUTE FUNCTION reservations_derive_columns();

-- ── Status state machine ──────────────────────────────────────────────────
--   SCHEDULED   -> IN_PROGRESS | CANCELLED | NO_SHOW
--   IN_PROGRESS -> COMPLETED   | CANCELLED
--   COMPLETED, CANCELLED, NO_SHOW are terminal.
--
-- Defence in depth. The service layer enforces this too, but a bad migration
-- script or a console session should not be able to move a COMPLETED
-- reservation back to SCHEDULED.
CREATE OR REPLACE FUNCTION reservations_guard_status()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  IF NOT (
       (OLD.status = 'SCHEDULED'   AND NEW.status IN ('IN_PROGRESS','CANCELLED','NO_SHOW'))
    OR (OLD.status = 'IN_PROGRESS' AND NEW.status IN ('COMPLETED','CANCELLED'))
  ) THEN
    RAISE EXCEPTION
      'illegal reservation status transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_reservations_status
  BEFORE UPDATE OF status ON reservations
  FOR EACH ROW EXECUTE FUNCTION reservations_guard_status();

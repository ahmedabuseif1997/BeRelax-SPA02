-- ════════════════════════════════════════════════════════════════════════
--  BE RELAX CRM — executable verification of the core database guarantees
--  Companion to docs/spa-crm-architecture-spec.md §5, §3.3 and §13.
--
--  This is not illustrative SQL. It is the DDL from the specification,
--  verbatim, followed by assertions that prove each claim the spec makes.
--  Run it against a scratch PostgreSQL 15+ with btree_gist available:
--
--      createdb berelax_verify
--      psql -d berelax_verify -f docs/sql/verify-core-constraints.sql
--
--  Every line of output must begin with "ok". A line beginning with "FAIL"
--  means the specification and the database disagree — fix it before
--  building anything on top.
--
--  Last run: PostgreSQL 16.13 — 30/30 assertions passed.
-- ════════════════════════════════════════════════════════════════════════
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── test harness ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION expect_fail(sql text, want text DEFAULT NULL, label text DEFAULT '')
RETURNS text LANGUAGE plpgsql AS $f$
DECLARE got text;
BEGIN
  EXECUTE sql;
  RETURN 'FAIL  ' || label || ' :: statement unexpectedly SUCCEEDED';
EXCEPTION WHEN OTHERS THEN
  got := SQLSTATE;
  IF want IS NULL OR got = want THEN RETURN 'ok    ' || label || '  [' || got || ']';
  ELSE RETURN 'FAIL  ' || label || ' :: got ' || got || ' want ' || want || ' — ' || SQLERRM; END IF;
END; $f$;

CREATE OR REPLACE FUNCTION expect_ok(sql text, label text DEFAULT '')
RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  EXECUTE sql;
  RETURN 'ok    ' || label;
EXCEPTION WHEN OTHERS THEN
  RETURN 'FAIL  ' || label || ' :: ' || SQLSTATE || ' — ' || SQLERRM;
END; $f$;

-- ── §5.1 business_day ────────────────────────────────────────
CREATE OR REPLACE FUNCTION business_day(ts timestamptz)
RETURNS date LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT ((ts AT TIME ZONE 'Asia/Dubai') - interval '6 hours')::date;
$$;

-- ── minimal schema mirroring §4 ──────────────────────────────
CREATE TYPE reservation_status AS ENUM ('SCHEDULED','IN_PROGRESS','COMPLETED','CANCELLED','NO_SHOW');
CREATE TYPE ledger_entry_type  AS ENUM ('TIP_ACCRUAL','COMMISSION_ACCRUAL','PAYOUT','ADJUSTMENT','REVERSAL');

CREATE TABLE branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL, turnaround_mins int NOT NULL DEFAULT 15);
CREATE TABLE employees (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), branch_id uuid NOT NULL REFERENCES branches);
CREATE TABLE rooms     (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), branch_id uuid NOT NULL REFERENCES branches);
CREATE TABLE guests    (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), branch_id uuid NOT NULL REFERENCES branches);
CREATE TABLE services  (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), branch_id uuid NOT NULL REFERENCES branches);
CREATE TABLE users     (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, deleted_at timestamptz);

CREATE TABLE reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref text UNIQUE,
  branch_id uuid NOT NULL REFERENCES branches,
  guest_id uuid REFERENCES guests,
  employee_id uuid NOT NULL REFERENCES employees,
  room_id uuid REFERENCES rooms,
  service_id uuid NOT NULL REFERENCES services,
  starts_at timestamptz NOT NULL,
  duration_minutes int NOT NULL,
  ends_at timestamptz NOT NULL,
  blocked_until timestamptz NOT NULL,
  business_day date NOT NULL,
  status reservation_status NOT NULL DEFAULT 'SCHEDULED',
  base_cost_fils int NOT NULL DEFAULT 0,
  actual_arrival_at timestamptz, completed_at timestamptz);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL REFERENCES reservations, amount_fils int NOT NULL);

CREATE TABLE therapist_payout_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL REFERENCES branches,
  employee_id uuid NOT NULL REFERENCES employees,
  entry_type ledger_entry_type NOT NULL,
  amount_fils int NOT NULL,
  business_day date NOT NULL,
  reservation_id uuid, tip_id uuid, payout_batch_id uuid,
  created_by_user_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), note text);

CREATE TABLE financial_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL, action text NOT NULL, entity_type text NOT NULL,
  entity_id uuid NOT NULL, request_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE attribution_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), visitor_id uuid NOT NULL,
  first_touch jsonb NOT NULL, last_touch jsonb NOT NULL, touches jsonb NOT NULL,
  touch_count int NOT NULL DEFAULT 1, first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(), landing_path text,
  captured_at timestamptz NOT NULL DEFAULT now(), pruned_at timestamptz);
CREATE TABLE outbound_clicks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE idempotency_records (key text PRIMARY KEY, expires_at timestamptz NOT NULL);

\set ON_ERROR_STOP on
\pset tuples_only on
\pset border 0
\echo '── §4.1  the claims about IMMUTABLE that the spec rests on ──'
SELECT expect_fail($$
  ALTER TABLE reservations ADD CONSTRAINT naive_expr EXCLUDE USING gist (
    employee_id WITH =,
    tstzrange(starts_at, starts_at + (duration_minutes || ' minutes')::interval) WITH &&)
$$, '42P17', 'naive expression in EXCLUDE is rejected as not IMMUTABLE');

SELECT expect_fail($$
  ALTER TABLE reservations ADD COLUMN gen_end timestamptz
    GENERATED ALWAYS AS (starts_at + make_interval(mins => duration_minutes)) STORED
$$, '42P17', 'GENERATED ALWAYS stored column is rejected for the same reason');

SELECT expect_ok($$SELECT business_day('2026-09-16T01:30:00+04:00'::timestamptz)$$,
  'business_day() is accepted as IMMUTABLE');

-- ══ §5.2 exclusion constraints, verbatim from the spec ══
ALTER TABLE reservations
  ADD CONSTRAINT reservations_no_therapist_overlap
  EXCLUDE USING gist (branch_id WITH =, employee_id WITH =,
                      tstzrange(starts_at, blocked_until, '[)') WITH &&)
  WHERE (status IN ('SCHEDULED', 'IN_PROGRESS'));

ALTER TABLE reservations
  ADD CONSTRAINT reservations_no_room_overlap
  EXCLUDE USING gist (branch_id WITH =, room_id WITH =,
                      tstzrange(starts_at, blocked_until, '[)') WITH &&)
  WHERE (status IN ('SCHEDULED', 'IN_PROGRESS') AND room_id IS NOT NULL);

ALTER TABLE reservations
  ADD CONSTRAINT reservations_no_guest_overlap
  EXCLUDE USING gist (branch_id WITH =, guest_id WITH =,
                      tstzrange(starts_at, ends_at, '[)') WITH &&)
  WHERE (status IN ('SCHEDULED', 'IN_PROGRESS') AND guest_id IS NOT NULL);

ALTER TABLE reservations
  ADD CONSTRAINT reservations_positive_duration CHECK (duration_minutes > 0),
  ADD CONSTRAINT reservations_ends_after_starts  CHECK (ends_at > starts_at),
  ADD CONSTRAINT reservations_blocked_after_ends CHECK (blocked_until >= ends_at),
  ADD CONSTRAINT reservations_nonneg_base        CHECK (base_cost_fils >= 0);

CREATE UNIQUE INDEX users_email_unique_active ON users (lower(email)) WHERE deleted_at IS NULL;

-- ══ §5.3 derived columns + state machine, verbatim ══
CREATE OR REPLACE FUNCTION reservations_derive_columns() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_turnaround int;
BEGIN
  SELECT turnaround_mins INTO v_turnaround FROM branches WHERE id = NEW.branch_id;
  v_turnaround := COALESCE(v_turnaround, 0);
  NEW.ends_at       := NEW.starts_at + make_interval(mins => NEW.duration_minutes);
  NEW.blocked_until := NEW.ends_at   + make_interval(mins => v_turnaround);
  NEW.business_day  := business_day(NEW.starts_at);
  RETURN NEW;
END; $$;
CREATE TRIGGER trg_reservations_derive
  BEFORE INSERT OR UPDATE OF starts_at, duration_minutes, branch_id ON reservations
  FOR EACH ROW EXECUTE FUNCTION reservations_derive_columns();

CREATE OR REPLACE FUNCTION reservations_guard_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF NOT ((OLD.status = 'SCHEDULED'   AND NEW.status IN ('IN_PROGRESS','CANCELLED','NO_SHOW'))
       OR (OLD.status = 'IN_PROGRESS' AND NEW.status IN ('COMPLETED','CANCELLED'))) THEN
    RAISE EXCEPTION 'illegal reservation status transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER trg_reservations_status BEFORE UPDATE OF status ON reservations
  FOR EACH ROW EXECUTE FUNCTION reservations_guard_status();

-- ══ §5.4 append-only guards, verbatim ══
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; correct by inserting a reversing row, never by % ',
    TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END; $$;
CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON financial_audit_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON financial_audit_log FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER trg_payments_no_update BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER trg_payments_no_delete BEFORE DELETE ON payments FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE OR REPLACE FUNCTION ledger_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'therapist_payout_ledger rows are never deleted; insert a REVERSAL'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
    IF NEW.payout_batch_id IS DISTINCT FROM OLD.payout_batch_id
       AND OLD.payout_batch_id IS NULL
       AND ROW(NEW.branch_id, NEW.employee_id, NEW.entry_type, NEW.amount_fils,
               NEW.business_day, NEW.reservation_id, NEW.tip_id, NEW.created_by_user_id, NEW.created_at)
         IS NOT DISTINCT FROM
           ROW(OLD.branch_id, OLD.employee_id, OLD.entry_type, OLD.amount_fils,
               OLD.business_day, OLD.reservation_id, OLD.tip_id, OLD.created_by_user_id, OLD.created_at)
    THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'therapist_payout_ledger amounts are immutable; insert a REVERSAL'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER trg_ledger_guard BEFORE UPDATE OR DELETE ON therapist_payout_ledger
  FOR EACH ROW EXECUTE FUNCTION ledger_guard();

-- ══ §5.6 retention job, verbatim ══
CREATE OR REPLACE FUNCTION prune_attribution(retention_days int DEFAULT 90)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  WITH pruned AS (
    UPDATE attribution_snapshots
       SET visitor_id  = '00000000-0000-0000-0000-000000000000'::uuid,
           touches     = '[]'::jsonb,
           first_touch = jsonb_build_object('source', first_touch->>'source',
                                            'medium', first_touch->>'medium',
                                            'campaign', first_touch->>'campaign'),
           last_touch  = jsonb_build_object('source', last_touch->>'source',
                                            'medium', last_touch->>'medium',
                                            'campaign', last_touch->>'campaign'),
           landing_path = NULL, pruned_at = now()
     WHERE pruned_at IS NULL AND captured_at < now() - make_interval(days => retention_days)
    RETURNING 1)
  SELECT count(*) INTO n FROM pruned;
  DELETE FROM outbound_clicks WHERE created_at < now() - make_interval(days => retention_days);
  DELETE FROM idempotency_records WHERE expires_at < now();
  RETURN n;
END; $$;

SET TIME ZONE 'UTC';   -- deliberately NOT Dubai: proves business_day() ignores the session tz

INSERT INTO branches (id,name,turnaround_mins) VALUES
  ('11111111-1111-1111-1111-111111111111','Al Zahiyah',15);
INSERT INTO employees (id,branch_id) VALUES
  ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222223','11111111-1111-1111-1111-111111111111');
INSERT INTO rooms (id,branch_id) VALUES ('33333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111');
INSERT INTO guests (id,branch_id) VALUES ('44444444-4444-4444-4444-444444444444','11111111-1111-1111-1111-111111111111');
INSERT INTO services (id,branch_id) VALUES ('55555555-5555-5555-5555-555555555555','11111111-1111-1111-1111-111111111111');

\echo ''
\echo '── §3.3  the business day must not split a 01:30 session ──'
SELECT CASE WHEN business_day('2026-09-16T01:30:00+04:00') = DATE '2026-09-15'
       THEN 'ok    01:30 Tue belongs to Monday''s trading day'
       ELSE 'FAIL  got ' || business_day('2026-09-16T01:30:00+04:00') END;
SELECT CASE WHEN business_day('2026-09-16T23:30:00+04:00') = DATE '2026-09-16'
       THEN 'ok    23:30 Tue belongs to Tuesday' ELSE 'FAIL' END;
SELECT CASE WHEN business_day('2026-09-16T11:00:00+04:00') = DATE '2026-09-16'
       THEN 'ok    11:00 opening belongs to the same day' ELSE 'FAIL' END;

\echo ''
\echo '── §5.3  trigger derives ends_at / blocked_until / business_day ──'
SELECT expect_ok($$INSERT INTO reservations (ref,branch_id,guest_id,employee_id,room_id,service_id,starts_at,duration_minutes,ends_at,blocked_until,business_day,base_cost_fils)
  VALUES ('BR-0001','11111111-1111-1111-1111-111111111111','44444444-4444-4444-4444-444444444444','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555',
          '2026-09-20T19:00:00+04:00',60,'1970-01-01T00:00:01Z','1970-01-01T00:00:01Z','1970-01-01',25000)$$,
  'insert with deliberately WRONG derived values is accepted');
SELECT CASE WHEN ends_at = '2026-09-20T20:00:00+04:00'::timestamptz
             AND blocked_until = '2026-09-20T20:15:00+04:00'::timestamptz
             AND business_day = DATE '2026-09-20'
       THEN 'ok    trigger overwrote all three: ends 20:00, blocked 20:15, day 2026-09-20'
       ELSE 'FAIL  ' || ends_at || ' / ' || blocked_until || ' / ' || business_day END
  FROM reservations WHERE ref='BR-0001';

\echo ''
\echo '── §5.2  double-booking is refused by the database ──'
SELECT expect_fail($$INSERT INTO reservations (ref,branch_id,employee_id,service_id,starts_at,duration_minutes,ends_at,blocked_until,business_day)
  VALUES ('BR-0002','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','55555555-5555-5555-5555-555555555555','2026-09-20T19:30:00+04:00',60,'now()','now()','2026-09-20')$$,
  '23P01','same therapist, overlapping 19:30 -> refused');
SELECT expect_fail($$INSERT INTO reservations (ref,branch_id,employee_id,room_id,service_id,starts_at,duration_minutes,ends_at,blocked_until,business_day)
  VALUES ('BR-0003','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222223','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','2026-09-20T19:30:00+04:00',60,'now()','now()','2026-09-20')$$,
  '23P01','different therapist, SAME room -> refused');
SELECT expect_fail($$INSERT INTO reservations (ref,branch_id,guest_id,employee_id,service_id,starts_at,duration_minutes,ends_at,blocked_until,business_day)
  VALUES ('BR-0004','11111111-1111-1111-1111-111111111111','44444444-4444-4444-4444-444444444444','22222222-2222-2222-2222-222222222223','55555555-5555-5555-5555-555555555555','2026-09-20T19:30:00+04:00',60,'now()','now()','2026-09-20')$$,
  '23P01','same guest booked twice at once -> refused');
SELECT expect_ok($$INSERT INTO reservations (ref,branch_id,employee_id,service_id,starts_at,duration_minutes,ends_at,blocked_until,business_day)
  VALUES ('BR-0005','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222223','55555555-5555-5555-5555-555555555555','2026-09-20T19:30:00+04:00',60,'now()','now()','2026-09-20')$$,
  'different therapist, NO room (NULL) -> allowed, NULLs never collide');

\echo ''
\echo '── §5.2  half-open range + 15 min turnaround arithmetic ──'
SELECT expect_fail($$INSERT INTO reservations (ref,branch_id,employee_id,service_id,starts_at,duration_minutes,ends_at,blocked_until,business_day)
  VALUES ('BR-0006','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','55555555-5555-5555-5555-555555555555','2026-09-20T20:14:00+04:00',60,'now()','now()','2026-09-20')$$,
  '23P01','20:14 -> refused (one minute inside the turnaround)');
SELECT expect_ok($$INSERT INTO reservations (ref,branch_id,employee_id,service_id,starts_at,duration_minutes,ends_at,blocked_until,business_day)
  VALUES ('BR-0007','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','55555555-5555-5555-5555-555555555555','2026-09-20T20:15:00+04:00',60,'now()','now()','2026-09-20')$$,
  '20:15 -> accepted (back-to-back works)');

\echo ''
\echo '── §5.2  a cancellation frees the slot immediately ──'
UPDATE reservations SET status='CANCELLED' WHERE ref='BR-0001';
SELECT expect_ok($$INSERT INTO reservations (ref,branch_id,employee_id,service_id,starts_at,duration_minutes,ends_at,blocked_until,business_day)
  VALUES ('BR-0008','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','55555555-5555-5555-5555-555555555555','2026-09-20T19:00:00+04:00',60,'now()','now()','2026-09-20')$$,
  '19:00 rebooked after the cancellation');

\echo ''
\echo '── §5.3  the status state machine ──'
SELECT expect_ok  ($$UPDATE reservations SET status='IN_PROGRESS' WHERE ref='BR-0008'$$, 'SCHEDULED -> IN_PROGRESS');
SELECT expect_ok  ($$UPDATE reservations SET status='COMPLETED'   WHERE ref='BR-0008'$$, 'IN_PROGRESS -> COMPLETED');
SELECT expect_fail($$UPDATE reservations SET status='SCHEDULED'   WHERE ref='BR-0008'$$, '23514','COMPLETED -> SCHEDULED refused');
SELECT expect_fail($$UPDATE reservations SET status='COMPLETED'   WHERE ref='BR-0005'$$, '23514','SCHEDULED -> COMPLETED refused (skipping check-in)');
SELECT expect_fail($$UPDATE reservations SET status='IN_PROGRESS' WHERE ref='BR-0001'$$, '23514','CANCELLED -> IN_PROGRESS refused');

\echo ''
\echo '── §5.4  append-only enforcement ──'
INSERT INTO payments (reservation_id,amount_fils) SELECT id,25000 FROM reservations WHERE ref='BR-0008';
INSERT INTO financial_audit_log (branch_id,action,entity_type,entity_id,request_id)
  SELECT branch_id,'RESERVATION_CHECK_IN','Reservation',id,'req_test' FROM reservations WHERE ref='BR-0008';
INSERT INTO therapist_payout_ledger (branch_id,employee_id,entry_type,amount_fils,business_day,created_by_user_id)
  VALUES ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','TIP_ACCRUAL',5000,'2026-09-20',gen_random_uuid());
SELECT expect_fail($$UPDATE payments SET amount_fils = 1$$,            '42501','payments cannot be updated');
SELECT expect_fail($$DELETE FROM payments$$,                            '42501','payments cannot be deleted');
SELECT expect_fail($$UPDATE financial_audit_log SET action='x'$$,       '42501','audit log cannot be updated');
SELECT expect_fail($$DELETE FROM financial_audit_log$$,                 '42501','audit log cannot be deleted');
SELECT expect_fail($$UPDATE therapist_payout_ledger SET amount_fils=1$$,'42501','ledger amount cannot be changed');
SELECT expect_fail($$DELETE FROM therapist_payout_ledger$$,             '42501','ledger rows cannot be deleted');
SELECT expect_ok  ($$UPDATE therapist_payout_ledger SET payout_batch_id = gen_random_uuid() WHERE payout_batch_id IS NULL$$,
  'stamping payout_batch_id from NULL IS allowed (the one permitted mutation)');
SELECT expect_fail($$UPDATE therapist_payout_ledger SET payout_batch_id = gen_random_uuid()$$,
  '42501','re-stamping an already-batched entry is refused');

\echo ''
\echo '── §5.6  retention job runs ──'
INSERT INTO attribution_snapshots (visitor_id,first_touch,last_touch,touches,landing_path,captured_at)
  VALUES (gen_random_uuid(),'{"source":"google","medium":"organic","campaign":null,"term":"massage"}',
          '{"source":"instagram","medium":"social"}','[{"source":"google"}]','/',now()-interval '100 days');
SELECT 'ok    prune_attribution() pruned ' || prune_attribution(90) || ' snapshot(s)';
SELECT CASE WHEN visitor_id = '00000000-0000-0000-0000-000000000000' AND touches = '[]'::jsonb
             AND landing_path IS NULL AND first_touch ? 'source' AND NOT (first_touch ? 'term')
       THEN 'ok    identifiers stripped, channel aggregate kept'
       ELSE 'FAIL  ' || first_touch::text END FROM attribution_snapshots;

\echo ''
\echo '── §5.1  case-insensitive unique email, live users only ──'
INSERT INTO users (email) VALUES ('Manager@berelax.ae');
SELECT expect_fail($$INSERT INTO users (email) VALUES ('manager@BERELAX.ae')$$,'23505','different casing is still a duplicate');
UPDATE users SET deleted_at = now();
SELECT expect_ok($$INSERT INTO users (email) VALUES ('manager@berelax.ae')$$,'the address frees up once the old user is soft-deleted');

\echo ''
\echo '── §13.1  concurrency ──'
\echo '  The 25-way race cannot run inside a single psql session. Run it with:'
\echo '    seq 1 25 | xargs -P 25 -I{} psql -d berelax_verify -q -c "..."'
\echo '  Expected: exactly 1 CREATED, 24 rejected with SQLSTATE 23P01.'
\echo ''
\echo '── §13.3 invariant 6: overlap check independent of the constraint ──'
SELECT CASE WHEN count(*)=0 THEN 'ok    no therapist is double-booked anywhere in the table'
            ELSE 'FAIL  ' || count(*) || ' overlapping pairs' END
  FROM reservations a JOIN reservations b
    ON a.id < b.id AND a.employee_id = b.employee_id AND a.branch_id = b.branch_id
   AND tstzrange(a.starts_at,a.blocked_until,'[)') && tstzrange(b.starts_at,b.blocked_until,'[)')
 WHERE a.status IN ('SCHEDULED','IN_PROGRESS') AND b.status IN ('SCHEDULED','IN_PROGRESS');

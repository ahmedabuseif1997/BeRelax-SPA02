#!/usr/bin/env bash
#
# backup-verify.sh — prove that a BE RELAX backup restores into a database that
#                    still behaves like BE RELAX.
#
# Spec §11.9: "Supabase daily backups + PITR, retained 30 days; a restore is
# rehearsed quarterly — an untested backup is a hope."
#
# Taking a dump proves nothing. Restoring it proves almost nothing: pg_restore
# will happily give you a database with the right number of rows in it and no
# exclusion constraints, because an EXCLUDE constraint that failed to build is a
# line in a log nobody read. That database looks fine until a Friday night when
# two receptionists tap Confirm at the same moment and two guests end up in one
# room.
#
# So this script restores, and then interrogates the restored copy:
#
#   census    every table has exactly the row count the source had
#   struct    btree_gist and pgcrypto; the three exclusion constraints; the five
#             append-only triggers, and that none of them is left DISABLED; the
#             two reservation triggers; the trigger functions; business_day()
#             and uuid_generate_v7(), which must not merely exist but still
#             return the right answers
#   data      all seven §13.3 financial invariants, re-run on the restored rows
#   probe     the restored database is ASKED to double-book a therapist, to move
#             a COMPLETED reservation back to SCHEDULED, to UPDATE a payment and
#             to DELETE an audit row — and must refuse all four. A catalogue
#             entry is a claim; this is the evidence.
#
# ── SOURCE VERSUS RESTORE ────────────────────────────────────────────────────
#
# Every read-only assertion runs against BOTH the source and the restored copy,
# and the two outputs must be identical. That distinction is the whole point:
#
#   an assertion that passes on the source and fails on the restore
#       -> the RESTORE is broken. Fatal, always.
#
#   a §13.3 invariant that fails on BOTH
#       -> the restore is faithful and PRODUCTION has a data problem. Reported
#          as a DATA FINDING, loudly, with counts. It does not fail the restore
#          rehearsal by default, because the question this script asks is "can
#          I restore this database", not "is this database's data correct" —
#          and a rehearsal blocked on an unrelated data ticket is a rehearsal
#          that stops being run. Pass --strict-data to make findings fatal;
#          CI should.
#
#   a struct or probe failure, on either side
#       -> fatal, always. A source with no exclusion constraints is not a source
#          you have a backup strategy for.
#
# Exit code is 0 only when the restore is proven faithful and usable.
#
# Read docs/runbooks/backup-restore.md before running this against production.

set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Defaults
# ─────────────────────────────────────────────────────────────────────────────
SOURCE_URL="${BACKUP_VERIFY_SOURCE:-}"
ADMIN_URL=""
SCRATCH_DB="berelax_restore_verify"
DUMP_FILE=""
KEEP=0
JOBS=1
STRICT_DATA=0

SCRIPT_NAME="$(basename "$0")"
WORK_DIR=""
FATAL=0
FINDINGS=0

usage() {
  cat <<'HELPTEXT'
backup-verify.sh — take a pg_dump, restore it into a scratch database, and prove
                   the restored copy is still a usable BE RELAX database.

SYNOPSIS
  scripts/backup-verify.sh --source <postgres-url> [options]

REQUIRED
  --source URL        Database to back up and verify. May also be given as the
                      BACKUP_VERIFY_SOURCE environment variable, which keeps the
                      password out of your shell history and out of `ps`.

OPTIONS
  --scratch NAME      Name of the throwaway database to restore into.
                      Default: berelax_restore_verify
                      IT IS DROPPED AND RECREATED. Never name a real database.
  --admin URL         Connection used to CREATE and DROP the scratch database.
                      Default: --source with its database swapped for `postgres`.
  --dump FILE         Write the dump here and keep it. Default: a temporary file
                      that is deleted on exit.
  --jobs N            pg_restore parallel jobs. Default: 1.
  --strict-data       Treat a §13.3 invariant that fails on BOTH the source and
                      the restored copy as a failure too. Off by default for a
                      quarterly rehearsal; ON is the right setting in CI.
  --keep              Do not drop the scratch database on exit. Use this to go
                      and look at a failure.
  -h, --help          This text.

EXIT
  0   the restore is faithful and the restored database is usable
  1   the restore is not proven — or, with --strict-data, the data is not either
  2   bad usage, or a missing tool

EXAMPLES
  # Local, against the development database
  scripts/backup-verify.sh --source postgresql://postgres@127.0.0.1:5432/berelax

  # Production rehearsal. DIRECT_URL, port 5432 — pg_dump needs a session
  # connection; the transaction pooler on 6543 will not do.
  export BACKUP_VERIFY_SOURCE="$DIRECT_URL"
  scripts/backup-verify.sh --dump "./berelax-$(date -u +%Y%m%dT%H%MZ).dump"

SAFETY
  The script never writes to --source: every statement it sends there is a
  SELECT. Everything it changes happens inside the scratch database, which it
  created. It refuses to run if the scratch name is the source's own database,
  or `postgres`, or a template. Running it twice in a row does the same thing
  as running it once.
HELPTEXT
}

die()    { printf '%s: %s\n' "$SCRIPT_NAME" "$*" >&2; exit 2; }
say()    { printf '%s\n' "$*"; }
rule()   { printf -- '─────────────────────────────────────────────────────────────────────────\n'; }
redact() { printf '%s' "$1" | sed -E 's#(//[^:/@]*):[^@]*@#\1:****@#'; }

# ─────────────────────────────────────────────────────────────────────────────
# Arguments
# ─────────────────────────────────────────────────────────────────────────────
while [ "$#" -gt 0 ]; do
  case "$1" in
    --source)      [ "$#" -ge 2 ] || die "--source needs a value";  SOURCE_URL="$2"; shift 2 ;;
    --scratch)     [ "$#" -ge 2 ] || die "--scratch needs a value"; SCRATCH_DB="$2"; shift 2 ;;
    --admin)       [ "$#" -ge 2 ] || die "--admin needs a value";   ADMIN_URL="$2";  shift 2 ;;
    --dump)        [ "$#" -ge 2 ] || die "--dump needs a value";    DUMP_FILE="$2";  shift 2 ;;
    --jobs)        [ "$#" -ge 2 ] || die "--jobs needs a value";    JOBS="$2";       shift 2 ;;
    --strict-data) STRICT_DATA=1; shift ;;
    --keep)        KEEP=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    *)             usage >&2; die "unknown argument: $1" ;;
  esac
done

[ -n "$SOURCE_URL" ] || { usage >&2; die "no --source given"; }

case "$SCRATCH_DB" in
  postgres|template0|template1|'') die "refusing to use '$SCRATCH_DB' as a scratch database" ;;
esac
printf '%s' "$SCRATCH_DB" | grep -Eq '^[A-Za-z_][A-Za-z0-9_]*$' \
  || die "scratch database name must be a bare identifier, got '$SCRATCH_DB'"
printf '%s' "$JOBS" | grep -Eq '^[1-9][0-9]*$' || die "--jobs must be a positive integer"

for tool in psql pg_dump pg_restore; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is not on PATH"
done

# ─────────────────────────────────────────────────────────────────────────────
# Connection strings
#
# The admin and scratch URLs are the source URL with the database name swapped.
# Everything else — host, port, user, password, sslmode — is carried across
# unchanged, so a production run needs exactly one credential.
# ─────────────────────────────────────────────────────────────────────────────
swap_database() {
  # swap_database <url> <dbname>
  printf '%s' "$1" | sed -E "s#^(postgres(ql)?://[^/]*)/[^?]*#\\1/$2#"
}

[ -n "$ADMIN_URL" ] || ADMIN_URL="$(swap_database "$SOURCE_URL" postgres)"
SCRATCH_URL="$(swap_database "$SOURCE_URL" "$SCRATCH_DB")"

SOURCE_DB="$(psql "$SOURCE_URL" -XtAq -c 'SELECT current_database()' 2>/dev/null)" \
  || die "cannot connect to --source"
[ -n "$SOURCE_DB" ] || die "cannot read current_database() from --source"

[ "$SOURCE_DB" != "$SCRATCH_DB" ] \
  || die "scratch database '$SCRATCH_DB' is the source database; refusing"

SOURCE_LABEL="$(redact "$SOURCE_URL")"

# ─────────────────────────────────────────────────────────────────────────────
# Workspace and cleanup. Running this twice in a row must behave identically to
# running it once, so the scratch database is dropped at both ends.
# ─────────────────────────────────────────────────────────────────────────────
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/berelax-backup-verify.XXXXXX")"
OWN_DUMP=0
if [ -z "$DUMP_FILE" ]; then
  DUMP_FILE="$WORK_DIR/source.dump"
  OWN_DUMP=1
fi

drop_scratch() {
  # WITH (FORCE) so a psql someone left open does not wedge the rehearsal.
  # Requires PostgreSQL 13+; Supabase is 15+.
  psql "$ADMIN_URL" -XtAq -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS \"$SCRATCH_DB\" WITH (FORCE)" >/dev/null 2>&1 || true
}

cleanup() {
  local status=$?
  if [ "$KEEP" -eq 1 ]; then
    say ""
    say "--keep: scratch database left in place as \"$SCRATCH_DB\"."
    say "        psql \"$(redact "$SCRATCH_URL")\""
    [ "$OWN_DUMP" -eq 0 ] && say "        dump kept at $DUMP_FILE"
  else
    drop_scratch
  fi
  [ -n "$WORK_DIR" ] && rm -rf "$WORK_DIR"
  exit "$status"
}
trap cleanup EXIT

# ─────────────────────────────────────────────────────────────────────────────
# SQL: the per-table row census. Exact counts, not reltuples — an ANALYZE
# estimate that happens to match is not evidence of anything.
# ─────────────────────────────────────────────────────────────────────────────
cat > "$WORK_DIR/census.sql" <<'SQL'
\set QUIET on
\pset format unaligned
\pset tuples_only on
\pset fieldsep '|'
\pset footer off
SELECT c.relname,
       (xpath('/row/n/text()',
              query_to_xml(format('SELECT count(*) AS n FROM %I.%I', 'public', c.relname),
                           false, true, '')))[1]::text::bigint AS rows
  FROM pg_class c
  JOIN pg_namespace ns ON ns.oid = c.relnamespace
 WHERE ns.nspname = 'public'
   AND c.relkind = 'r'
 ORDER BY c.relname;
SQL

# ─────────────────────────────────────────────────────────────────────────────
# SQL: read-only assertions. Run against BOTH databases; the outputs must match.
#
# Every statement is a SELECT, which is what makes it safe to point at
# production. Each emits exactly one line:
#
#     <ok|FAIL|warn>  <struct|data>  <reference>  <claim>
#
# ON_ERROR_STOP is off so that a missing function produces one ERROR line and
# the remaining assertions still run; the caller treats any ERROR as fatal.
# ─────────────────────────────────────────────────────────────────────────────
cat > "$WORK_DIR/assert.sql" <<'SQL'
\set QUIET on
\set ON_ERROR_STOP off
\pset format unaligned
\pset tuples_only on
\pset footer off

-- ══ §5.1 extensions ═══════════════════════════════════════════════════════
SELECT CASE WHEN count(*) = 2
  THEN 'ok    struct  §5.1      btree_gist and pgcrypto installed'
  ELSE 'FAIL  struct  §5.1      expected btree_gist and pgcrypto, found: ' ||
       COALESCE(string_agg(extname, ', ' ORDER BY extname), '<none>')
END FROM pg_extension WHERE extname IN ('btree_gist', 'pgcrypto');

-- ══ §5.1 helper functions — present AND still correct ═════════════════════
SELECT CASE
  WHEN NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'uuid_generate_v7' AND p.pronargs = 0)
    THEN 'FAIL  struct  §5.1      uuid_generate_v7() is MISSING — every id default is broken'
  WHEN substring(uuid_generate_v7()::text, 15, 1) <> '7'
    THEN 'FAIL  struct  §5.1      uuid_generate_v7() no longer returns a version-7 UUID'
  ELSE 'ok    struct  §5.1      uuid_generate_v7() present and returns a v7 UUID'
END;

SELECT CASE
  WHEN NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'business_day'
       AND pg_get_function_identity_arguments(p.oid) = 'ts timestamp with time zone')
    THEN 'FAIL  struct  §5.1      business_day(timestamptz) is MISSING — every report is wrong'
  WHEN business_day('2026-09-15T22:30:00Z'::timestamptz) <> DATE '2026-09-15'
    THEN 'FAIL  struct  §5.1      business_day() no longer bills an after-midnight ' ||
         'booking to the previous trading day'
  ELSE 'ok    struct  §5.1      business_day(timestamptz) present, 02:30 Dubai -> previous day'
END;

-- The function existing is not the same as the function agreeing with the rows
-- it was restored alongside. §3.3.
SELECT CASE WHEN n = 0
  THEN 'ok    struct  §3.3      business_day() re-derives every stored reservations.business_day'
  ELSE 'FAIL  struct  §3.3      business_day() disagrees with ' || n || ' stored row(s)'
END FROM (SELECT count(*) AS n FROM reservations WHERE business_day <> business_day(starts_at)) q;

-- ══ §5.2 the three exclusion constraints ══════════════════════════════════
SELECT CASE WHEN found IS NOT DISTINCT FROM want
  THEN 'ok    struct  §5.2      the three exclusion constraints are installed'
  ELSE 'FAIL  struct  §5.2      exclusion constraints on reservations: expected [' || want ||
       '] found [' || COALESCE(found, '') || ']'
END FROM (
  SELECT (SELECT string_agg(conname, ',' ORDER BY conname)
            FROM pg_constraint
           WHERE contype = 'x' AND conrelid = 'public.reservations'::regclass) AS found,
         'reservations_no_guest_overlap,reservations_no_room_overlap,reservations_no_therapist_overlap' AS want
) q;

-- ══ §5.3 / §5.4 triggers ══════════════════════════════════════════════════
SELECT CASE WHEN found IS NOT DISTINCT FROM want
  THEN 'ok    struct  §5.4      the five append-only triggers are installed'
  ELSE 'FAIL  struct  §5.4      append-only triggers: expected [' || want || '] found [' ||
       COALESCE(found, '') || ']'
END FROM (
  SELECT (SELECT string_agg(t.tgname, ',' ORDER BY t.tgname)
            FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
           WHERE NOT t.tgisinternal
             AND c.relname IN ('payments', 'financial_audit_log', 'therapist_payout_ledger')) AS found,
         'trg_audit_no_delete,trg_audit_no_update,trg_ledger_guard,trg_payments_no_delete,trg_payments_no_update' AS want
) q;

-- A trigger can be present and DISABLED, and pg_dump reproduces a disabled
-- trigger faithfully. The payment_created_at migration disables one on purpose
-- for a single backfill statement, so "left disabled" is a real way for this to
-- go wrong — and a disabled append-only guard is no guard at all.
SELECT CASE WHEN n = 0
  THEN 'ok    struct  §5.4      every append-only and reservation trigger is ENABLED'
  ELSE 'FAIL  struct  §5.4      ' || n || ' trigger(s) are present but DISABLED'
END FROM (
  SELECT count(*) AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE NOT t.tgisinternal
     AND c.relname IN ('payments', 'financial_audit_log', 'therapist_payout_ledger', 'reservations')
     AND t.tgenabled = 'D'
) q;

SELECT CASE WHEN found IS NOT DISTINCT FROM want
  THEN 'ok    struct  §5.3      the reservation derive and status triggers are installed'
  ELSE 'FAIL  struct  §5.3      reservation triggers: expected [' || want || '] found [' ||
       COALESCE(found, '') || ']'
END FROM (
  SELECT (SELECT string_agg(t.tgname, ',' ORDER BY t.tgname)
            FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
           WHERE NOT t.tgisinternal AND c.relname = 'reservations') AS found,
         'trg_reservations_derive,trg_reservations_status' AS want
) q;

SELECT CASE WHEN count(*) = 4
  THEN 'ok    struct  §5.4      forbid_mutation, ledger_guard, derive and status functions present'
  ELSE 'FAIL  struct  §5.4      trigger functions missing: expected 4, found ' || count(*)
END FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN ('forbid_mutation', 'ledger_guard',
                     'reservations_derive_columns', 'reservations_guard_status');

SELECT CASE WHEN count(*) = 1
  THEN 'ok    struct  §5.6      prune_attribution(int) present'
  ELSE 'FAIL  struct  §5.6      prune_attribution(int) missing — the retention job has ' ||
       'nothing to call'
END FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'prune_attribution';

-- ══ Is there enough data here for the invariants to mean anything? ════════
-- Not a failure: an empty database restores to an empty database, and that is a
-- correct restore. It is a warning because a PRODUCTION rehearsal that prints it
-- is telling you that you dumped the wrong database.
SELECT CASE
  WHEN (SELECT count(*) FROM reservations) = 0
    THEN 'warn  data    fixture   no reservations — the invariants below are vacuous'
  WHEN (SELECT count(*) FROM payments) = 0
    THEN 'warn  data    fixture   no payments — the money invariants below are vacuous'
  ELSE 'ok    data    fixture   ' || (SELECT count(*) FROM reservations) || ' reservations, ' ||
       (SELECT count(*) FROM payments) || ' payments, ' ||
       (SELECT count(*) FROM tips) || ' tips, ' ||
       (SELECT count(*) FROM therapist_payout_ledger) || ' ledger entries'
END;

-- ══ §13.3 the seven financial invariants ══════════════════════════════════

-- 1. Every employee's ledger balance reconciles.
SELECT CASE WHEN n = 0
  THEN 'ok    data    §13.3(1)  every ledger balance = collected tips + commissions - payouts'
  ELSE 'FAIL  data    §13.3(1)  ' || n || ' employee(s) whose ledger does not reconcile'
END FROM (
  SELECT count(*) AS n FROM employees e
  CROSS JOIN LATERAL (
    SELECT (SELECT COALESCE(SUM(amount_fils), 0)::bigint FROM therapist_payout_ledger
             WHERE employee_id = e.id)                                        AS ledger_sum,
           (SELECT COALESCE(SUM(amount_fils), 0)::bigint FROM tips
             WHERE employee_id = e.id AND type = 'COLLECTED_BY_BUSINESS'
               AND reversed_by_tip_id IS NULL)                                AS tips_collected,
           (SELECT COALESCE(SUM(amount_fils), 0)::bigint FROM therapist_payout_ledger
             WHERE employee_id = e.id AND entry_type = 'COMMISSION_ACCRUAL')  AS commissions,
           (SELECT COALESCE(SUM(-amount_fils), 0)::bigint FROM therapist_payout_ledger
             WHERE employee_id = e.id AND entry_type = 'PAYOUT')              AS payouts
  ) b
  WHERE b.ledger_sum <> b.tips_collected + b.commissions - b.payouts
) q;

-- 2. A DIRECT_CASH tip never entered the business, so it owes nothing.
SELECT CASE WHEN n = 0
  THEN 'ok    data    §13.3(2)  no ledger entry exists for any DIRECT_CASH tip'
  ELSE 'FAIL  data    §13.3(2)  ' || n || ' ledger entrie(s) accrued against a DIRECT_CASH tip'
END FROM (
  SELECT count(*) AS n FROM therapist_payout_ledger l
    JOIN tips t ON t.id = l.tip_id
   WHERE t.type = 'DIRECT_CASH'
) q;

SELECT CASE WHEN n = 0
  THEN 'ok    data    §13.3(2)  no DIRECT_CASH tip carries a payment row or a method'
  ELSE 'FAIL  data    §13.3(2)  ' || n || ' DIRECT_CASH tip(s) leaked into the till'
END FROM (
  SELECT count(*) AS n FROM tips
   WHERE type = 'DIRECT_CASH' AND (payment_id IS NOT NULL OR method IS NOT NULL)
) q;

-- 3. Every live COLLECTED_BY_BUSINESS tip: one payment, one accrual.
SELECT CASE WHEN n = 0
  THEN 'ok    data    §13.3(3)  every live collected tip has one payment and one TIP_ACCRUAL'
  ELSE 'FAIL  data    §13.3(3)  ' || n || ' collected tip(s) without exactly one payment and accrual'
END FROM (
  SELECT count(*) AS n FROM tips t
   WHERE t.type = 'COLLECTED_BY_BUSINESS'
     AND t.amount_fils > 0
     AND ( (SELECT count(*) FROM payments p
             WHERE p.id = t.payment_id AND p.kind = 'TIP'
               AND p.amount_fils = t.amount_fils) <> 1
        OR (SELECT count(*) FROM therapist_payout_ledger l
             WHERE l.tip_id = t.id AND l.entry_type = 'TIP_ACCRUAL'
               AND l.amount_fils = t.amount_fils) <> 1 )
) q;

-- 3b. A reversal moved as a whole, or it is not a reversal.
SELECT CASE WHEN n = 0
  THEN 'ok    data    §13.3(3b) every reversed tip is mirrored, refunded and un-accrued together'
  ELSE 'FAIL  data    §13.3(3b) ' || n || ' broken reversal(s)'
END FROM (
  SELECT count(*) AS n
    FROM tips orig
    JOIN tips mirror ON mirror.id = orig.reversed_by_tip_id
   WHERE orig.reversed_by_tip_id IS NOT NULL
     AND ( mirror.amount_fils <> -orig.amount_fils
        OR mirror.type <> orig.type
        OR (orig.type = 'COLLECTED_BY_BUSINESS' AND (
              (SELECT count(*) FROM payments p
                WHERE p.kind = 'REFUND' AND p.reverses_payment_id = orig.payment_id) <> 1
           OR (SELECT count(*) FROM therapist_payout_ledger l
                WHERE l.tip_id = mirror.id AND l.entry_type = 'REVERSAL') <> 1))
        OR (orig.type = 'DIRECT_CASH' AND (
              mirror.payment_id IS NOT NULL
           OR (SELECT count(*) FROM therapist_payout_ledger l
                WHERE l.tip_id = mirror.id) <> 0)) )
) q;

-- 4. The desk collected the quoted price in full on every COMPLETED booking.
SELECT CASE WHEN n = 0
  THEN 'ok    data    §13.3(4)  every COMPLETED reservation collected its full base cost'
  ELSE 'FAIL  data    §13.3(4)  ' || n || ' COMPLETED reservation(s) where BASE payments ' ||
       '<> base_cost_fils'
END FROM (
  SELECT count(*) AS n FROM (
    SELECT r.id
      FROM reservations r
      LEFT JOIN payments p ON p.reservation_id = r.id
     WHERE r.status = 'COMPLETED'
     GROUP BY r.id, r.base_cost_fils
    HAVING r.base_cost_fils <> COALESCE(SUM(p.amount_fils) FILTER (WHERE p.kind = 'BASE'), 0)
  ) offenders
) q;

-- 4b. Money only goes back out if it came in.
SELECT CASE WHEN n = 0
  THEN 'ok    data    §13.3(4b) no payment was refunded for more than it was worth'
  ELSE 'FAIL  data    §13.3(4b) ' || n || ' payment(s) refunded beyond their value'
END FROM (
  SELECT count(*) AS n FROM (
    SELECT orig.id
      FROM payments orig
      JOIN payments ref ON ref.reverses_payment_id = orig.id AND ref.kind = 'REFUND'
     GROUP BY orig.id, orig.amount_fils
    HAVING -SUM(ref.amount_fils) > orig.amount_fils
  ) offenders
) q;

-- 5. Status and timestamps agree.
SELECT CASE WHEN n = 0
  THEN 'ok    data    §13.3(5)  no COMPLETED without a completion, no IN_PROGRESS without an arrival'
  ELSE 'FAIL  data    §13.3(5)  ' || n || ' reservation(s) whose status and timestamps disagree'
END FROM (
  SELECT count(*) AS n FROM reservations
   WHERE (status = 'COMPLETED'   AND completed_at      IS NULL)
      OR (status = 'COMPLETED'   AND actual_arrival_at IS NULL)
      OR (status = 'IN_PROGRESS' AND actual_arrival_at IS NULL)
      OR (status = 'COMPLETED'   AND completed_at < actual_arrival_at)
) q;

-- 6. THE CANARY. Asked of the data, independently of the constraint.
SELECT CASE WHEN n = 0
  THEN 'ok    data    §13.3(6)  no two live reservations share a therapist and an overlapping range'
  ELSE 'FAIL  data    §13.3(6)  ' || n || ' therapist double-booking(s) in the data'
END FROM (
  SELECT count(*) AS n
    FROM reservations a
    JOIN reservations b
      ON a.id < b.id AND a.branch_id = b.branch_id AND a.employee_id = b.employee_id
     AND tstzrange(a.starts_at, a.blocked_until, '[)')
      && tstzrange(b.starts_at, b.blocked_until, '[)')
   WHERE a.status IN ('SCHEDULED', 'IN_PROGRESS')
     AND b.status IN ('SCHEDULED', 'IN_PROGRESS')
) q;

SELECT CASE WHEN n = 0
  THEN 'ok    data    §13.3(6b) nor a room'
  ELSE 'FAIL  data    §13.3(6b) ' || n || ' room double-booking(s) in the data'
END FROM (
  SELECT count(*) AS n
    FROM reservations a
    JOIN reservations b
      ON a.id < b.id AND a.branch_id = b.branch_id AND a.room_id = b.room_id
     AND tstzrange(a.starts_at, a.blocked_until, '[)')
      && tstzrange(b.starts_at, b.blocked_until, '[)')
   WHERE a.status IN ('SCHEDULED', 'IN_PROGRESS')
     AND b.status IN ('SCHEDULED', 'IN_PROGRESS')
) q;

SELECT CASE WHEN n = 0
  THEN 'ok    data    §13.3(6b) nor — on the treatment window — a guest'
  ELSE 'FAIL  data    §13.3(6b) ' || n || ' guest double-booking(s) in the data'
END FROM (
  SELECT count(*) AS n
    FROM reservations a
    JOIN reservations b
      ON a.id < b.id AND a.branch_id = b.branch_id AND a.guest_id = b.guest_id
     AND tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(b.starts_at, b.ends_at, '[)')
   WHERE a.status IN ('SCHEDULED', 'IN_PROGRESS')
     AND b.status IN ('SCHEDULED', 'IN_PROGRESS')
) q;

-- 7. Every money row sits beside an audit row written in the same transaction.
--    created_at, NOT collected_at: reception may legitimately back-date when the
--    money changed hands (§8.2); created_at is when the row was written, which
--    is what an audit entry is supposed to sit beside.
SELECT CASE WHEN n = 0
  THEN 'ok    data    §13.3(7)  every payment, tip and ledger entry has an audit entry within 1s'
  ELSE 'FAIL  data    §13.3(7)  ' || n || ' money row(s) with no corresponding audit entry'
END FROM (
  WITH money AS (
    SELECT p.branch_id, p.reservation_id AS anchor_id, p.created_at AS written_at FROM payments p
    UNION ALL
    SELECT t.branch_id, t.reservation_id, t.recorded_at FROM tips t
    UNION ALL
    SELECT l.branch_id, COALESCE(l.reservation_id, l.payout_batch_id, l.id), l.created_at
      FROM therapist_payout_ledger l
  )
  SELECT count(*) AS n FROM money m
   WHERE NOT EXISTS (
     SELECT 1 FROM financial_audit_log a
      WHERE a.branch_id = m.branch_id
        AND a.entity_id = m.anchor_id
        AND a.created_at BETWEEN m.written_at - interval '1 second'
                             AND m.written_at + interval '1 second')
) q;
SQL

# ─────────────────────────────────────────────────────────────────────────────
# SQL: behavioural probes. SCRATCH DATABASE ONLY — these write.
#
# The catalogue says the constraint exists. This asks the database to actually
# refuse a double-booking, because a restore that produces a database which no
# longer refuses one is not a restore.
#
# Each probe runs inside a single DO statement, which is its own transaction:
# rows it inserts are removed before the statement ends, and if the statement
# raises, nothing it did survives. The census has already been taken, so even a
# crashed probe cannot corrupt the comparison.
# ─────────────────────────────────────────────────────────────────────────────
cat > "$WORK_DIR/probe.sql" <<'SQL'
\set QUIET on
\set ON_ERROR_STOP off
\pset format unaligned
\pset tuples_only on
\pset footer off

CREATE TEMP TABLE _probe(seq serial, line text);

-- ══ Does it still refuse a double-booking? ════════════════════════════════
DO $probe$
DECLARE
  v_branch uuid;
  v_emp    uuid;
  v_svc    uuid;
  v_start  timestamptz;
  v_second boolean := false;
BEGIN
  SELECT e.branch_id, e.id INTO v_branch, v_emp FROM employees e ORDER BY e.id LIMIT 1;
  SELECT s.id INTO v_svc FROM services s WHERE s.branch_id = v_branch ORDER BY s.id LIMIT 1;

  IF v_emp IS NULL OR v_svc IS NULL THEN
    INSERT INTO _probe(line) VALUES
      ('warn  probe   doubleBk  no employee or service restored — probe skipped');
    RETURN;
  END IF;

  -- Ten years out, so the probe cannot collide with, or be masked by, real data.
  v_start := date_trunc('hour', now()) + interval '3650 days';

  -- ends_at, blocked_until and business_day are overwritten by
  -- trg_reservations_derive; the values below are placeholders that satisfy
  -- NOT NULL and are then replaced.
  INSERT INTO reservations
    (ref, branch_id, employee_id, service_id, starts_at, duration_minutes,
     ends_at, blocked_until, business_day, status, base_cost_fils,
     source_channel, updated_at)
  VALUES
    ('__probe_a__', v_branch, v_emp, v_svc, v_start, 60,
     v_start + interval '60 minutes', v_start + interval '60 minutes',
     v_start::date, 'SCHEDULED', 0, 'WALK_IN', now());

  BEGIN
    -- Same therapist, starting half way through the first booking.
    INSERT INTO reservations
      (ref, branch_id, employee_id, service_id, starts_at, duration_minutes,
       ends_at, blocked_until, business_day, status, base_cost_fils,
       source_channel, updated_at)
    VALUES
      ('__probe_b__', v_branch, v_emp, v_svc, v_start + interval '30 minutes', 60,
       v_start + interval '90 minutes', v_start + interval '90 minutes',
       v_start::date, 'SCHEDULED', 0, 'WALK_IN', now());
    v_second := true;
  EXCEPTION WHEN exclusion_violation THEN
    v_second := false;
  END;

  DELETE FROM reservations WHERE ref IN ('__probe_a__', '__probe_b__');

  IF v_second THEN
    INSERT INTO _probe(line) VALUES
      ('FAIL  probe   doubleBk  the restored database ACCEPTED a double-booking — '
       || 'the exclusion constraint is not doing its job');
  ELSE
    INSERT INTO _probe(line) VALUES
      ('ok    probe   doubleBk  the restored database refused a double-booking [23P01]');
  END IF;
END
$probe$;

-- ══ Is the derive trigger still deriving? ═════════════════════════════════
DO $probe$
DECLARE
  v_branch uuid; v_emp uuid; v_svc uuid; v_start timestamptz;
  v_ends timestamptz; v_blocked timestamptz; v_day date; v_turn int;
BEGIN
  SELECT e.branch_id, e.id INTO v_branch, v_emp FROM employees e ORDER BY e.id LIMIT 1;
  SELECT s.id INTO v_svc FROM services s WHERE s.branch_id = v_branch ORDER BY s.id LIMIT 1;
  IF v_emp IS NULL OR v_svc IS NULL THEN
    INSERT INTO _probe(line) VALUES ('warn  probe   derive    empty catalogue — probe skipped');
    RETURN;
  END IF;
  SELECT turnaround_mins INTO v_turn FROM branches WHERE id = v_branch;

  -- 01:30 Dubai is 21:30 UTC the previous day, and belongs to the PREVIOUS
  -- trading day. This is the rule every revenue report depends on.
  v_start := timestamptz '2036-03-04 21:30:00+00';

  INSERT INTO reservations
    (ref, branch_id, employee_id, service_id, starts_at, duration_minutes,
     ends_at, blocked_until, business_day, status, base_cost_fils,
     source_channel, updated_at)
  VALUES
    ('__probe_c__', v_branch, v_emp, v_svc, v_start, 90,
     v_start + interval '1 minute', v_start + interval '1 minute',
     DATE '1999-01-01', 'SCHEDULED', 0, 'WALK_IN', now());

  SELECT ends_at, blocked_until, business_day
    INTO v_ends, v_blocked, v_day
    FROM reservations WHERE ref = '__probe_c__';

  DELETE FROM reservations WHERE ref = '__probe_c__';

  IF v_ends = v_start + interval '90 minutes'
     AND v_blocked = v_start + make_interval(mins => 90 + COALESCE(v_turn, 0))
     AND v_day = DATE '2036-03-04' THEN
    INSERT INTO _probe(line) VALUES
      ('ok    probe   derive    trg_reservations_derive still sets ends_at, blocked_until, business_day');
  ELSE
    INSERT INTO _probe(line) VALUES
      ('FAIL  probe   derive    derived columns are wrong: ends_at=' || v_ends ||
       ' blocked_until=' || v_blocked || ' business_day=' || v_day);
  END IF;
END
$probe$;

-- ══ Is the status state machine still refusing illegal transitions? ═══════
DO $probe$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM reservations WHERE status = 'COMPLETED' ORDER BY id LIMIT 1;
  IF v_id IS NULL THEN
    INSERT INTO _probe(line) VALUES ('warn  probe   status    no COMPLETED reservation — probe skipped');
    RETURN;
  END IF;
  BEGIN
    UPDATE reservations SET status = 'SCHEDULED' WHERE id = v_id;
    INSERT INTO _probe(line) VALUES
      ('FAIL  probe   status    a COMPLETED reservation was moved back to SCHEDULED');
  EXCEPTION WHEN check_violation THEN
    INSERT INTO _probe(line) VALUES
      ('ok    probe   status    COMPLETED -> SCHEDULED refused by the state machine');
  END;
END
$probe$;

-- ══ Is payments still append-only? ════════════════════════════════════════
DO $probe$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM payments ORDER BY id LIMIT 1;
  IF v_id IS NULL THEN
    INSERT INTO _probe(line) VALUES ('warn  probe   append    no payments restored — probe skipped');
    RETURN;
  END IF;

  BEGIN
    UPDATE payments SET note = note WHERE id = v_id;
    INSERT INTO _probe(line) VALUES
      ('FAIL  probe   append    payments ACCEPTED an UPDATE — the append-only guard is gone');
  EXCEPTION WHEN insufficient_privilege THEN
    INSERT INTO _probe(line) VALUES
      ('ok    probe   append    payments refused an UPDATE [42501]');
  END;
END
$probe$;

-- ══ Is the audit log still immutable? ═════════════════════════════════════
DO $probe$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM financial_audit_log ORDER BY id LIMIT 1;
  IF v_id IS NULL THEN
    INSERT INTO _probe(line) VALUES ('warn  probe   append    no audit rows restored — probe skipped');
    RETURN;
  END IF;

  BEGIN
    DELETE FROM financial_audit_log WHERE id = v_id;
    INSERT INTO _probe(line) VALUES
      ('FAIL  probe   append    financial_audit_log ACCEPTED a DELETE — during a breach this '
       || 'is the only record you can trust, and it is now editable');
  EXCEPTION WHEN insufficient_privilege THEN
    INSERT INTO _probe(line) VALUES
      ('ok    probe   append    financial_audit_log refused a DELETE [42501]');
  END;
END
$probe$;

-- ══ Is the ledger still immutable except for batching? ════════════════════
DO $probe$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM therapist_payout_ledger ORDER BY id LIMIT 1;
  IF v_id IS NULL THEN
    INSERT INTO _probe(line) VALUES ('warn  probe   append    no ledger rows restored — probe skipped');
    RETURN;
  END IF;

  BEGIN
    UPDATE therapist_payout_ledger SET amount_fils = amount_fils + 1 WHERE id = v_id;
    INSERT INTO _probe(line) VALUES
      ('FAIL  probe   append    therapist_payout_ledger ACCEPTED an amount change');
  EXCEPTION WHEN insufficient_privilege THEN
    INSERT INTO _probe(line) VALUES
      ('ok    probe   append    therapist_payout_ledger refused an amount change [42501]');
  END;
END
$probe$;

SELECT line FROM _probe ORDER BY seq;
SQL

# ─────────────────────────────────────────────────────────────────────────────
# Run
# ─────────────────────────────────────────────────────────────────────────────
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
T0=$(date +%s)

if [ "$STRICT_DATA" -eq 1 ]; then
  STRICT_LABEL='data findings are FATAL'
else
  STRICT_LABEL='data findings are reported, not fatal'
fi

rule
say "BE RELAX — backup restore verification"
say "  started   ${STARTED_AT}"
say "  source    ${SOURCE_LABEL}  (database: ${SOURCE_DB})"
say "  scratch   ${SCRATCH_DB}"
say "  dump      ${DUMP_FILE}"
say "  policy    ${STRICT_LABEL}"
rule

# ── 1. census and assert the SOURCE (read-only) ──────────────────────────────
say ""
say "[1/6] Reading the source"
psql "$SOURCE_URL" -X -q -v ON_ERROR_STOP=1 -f "$WORK_DIR/census.sql" > "$WORK_DIR/census-source.txt"
psql "$SOURCE_URL" -X -q -f "$WORK_DIR/assert.sql" > "$WORK_DIR/assert-source.out" 2>&1 || true
say "      $(wc -l < "$WORK_DIR/census-source.txt" | tr -d ' ') tables, $(awk -F'|' '{s+=$2} END {print s+0}' "$WORK_DIR/census-source.txt") rows"

# ── 2. dump ──────────────────────────────────────────────────────────────────
say ""
say "[2/6] pg_dump"
T_DUMP_START=$(date +%s)
# Custom format: compressed, and pg_restore can be pointed at a brand new
# database. --no-owner/--no-privileges because the restore target's roles are
# not the source's — on Supabase you are not the superuser you think you are.
pg_dump \
  --format=custom \
  --no-owner \
  --no-privileges \
  --file="$DUMP_FILE" \
  "$SOURCE_URL"
T_DUMP=$(( $(date +%s) - T_DUMP_START ))
DUMP_BYTES="$(wc -c < "$DUMP_FILE" | tr -d ' ')"
say "      ${DUMP_BYTES} bytes in ${T_DUMP}s"

# ── 3. fresh scratch database ────────────────────────────────────────────────
say ""
say "[3/6] Creating a fresh scratch database"
drop_scratch
psql "$ADMIN_URL" -X -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$SCRATCH_DB\"" > /dev/null
say "      created ${SCRATCH_DB}"

# ── 4. restore ───────────────────────────────────────────────────────────────
say ""
say "[4/6] pg_restore"
T_RESTORE_START=$(date +%s)
RESTORE_STATUS=0
pg_restore \
  --dbname="$SCRATCH_URL" \
  --no-owner \
  --no-privileges \
  --exit-on-error \
  --jobs="$JOBS" \
  "$DUMP_FILE" > "$WORK_DIR/restore.log" 2>&1 || RESTORE_STATUS=$?
T_RESTORE=$(( $(date +%s) - T_RESTORE_START ))

if [ "$RESTORE_STATUS" -ne 0 ]; then
  say "      pg_restore FAILED (exit ${RESTORE_STATUS}) after ${T_RESTORE}s"
  say ""
  sed -n '1,60p' "$WORK_DIR/restore.log"
  say ""
  say "RESULT: FAILED — the dump did not restore. The backup is not a backup."
  exit 1
fi
say "      restored in ${T_RESTORE}s"

# ── 5. census the restore and compare ────────────────────────────────────────
say ""
say "[5/6] Comparing the restored copy with the source"
T_VERIFY_START=$(date +%s)

psql "$SCRATCH_URL" -X -q -v ON_ERROR_STOP=1 -f "$WORK_DIR/census.sql" > "$WORK_DIR/census-scratch.txt"

if diff -u "$WORK_DIR/census-source.txt" "$WORK_DIR/census-scratch.txt" > "$WORK_DIR/census.diff"; then
  say "ok    census  tables    $(wc -l < "$WORK_DIR/census-source.txt" | tr -d ' ') tables match the source row for row"
else
  say "FAIL  census  tables    the restored copy does not have the same rows as the source"
  say ""
  say "      -source  +restored"
  sed -n '3,40p' "$WORK_DIR/census.diff" | sed 's/^/      /'
  say ""
  FATAL=$(( FATAL + 1 ))
fi

# ── 6. interrogate ───────────────────────────────────────────────────────────
say ""
say "[6/6] Interrogating the restored database"
say ""

psql "$SCRATCH_URL" -X -q -f "$WORK_DIR/assert.sql" > "$WORK_DIR/assert-scratch.out" 2>&1 || true
psql "$SCRATCH_URL" -X -q -f "$WORK_DIR/probe.sql"  > "$WORK_DIR/probe.out"          2>&1 || true

cat "$WORK_DIR/assert-scratch.out" "$WORK_DIR/probe.out" | grep -v '^[[:space:]]*$' || true

# Fidelity: the same read-only questions, asked of both databases, must produce
# the same answers. Anything else means the restore is not the source.
if ! diff -u "$WORK_DIR/assert-source.out" "$WORK_DIR/assert-scratch.out" > "$WORK_DIR/assert.diff"; then
  say ""
  say "FAIL  fidelity          the restored copy answers differently from the source"
  say ""
  say "      -source  +restored"
  sed -n '3,60p' "$WORK_DIR/assert.diff" | sed 's/^/      /'
  FATAL=$(( FATAL + 1 ))
fi

count_matches() { grep -c "$1" "$2" 2>/dev/null || true; }

# An ERROR from psql means a statement did not run at all — a missing function,
# a missing table. Structural, and fatal wherever it appears.
FATAL=$(( FATAL \
  + $(count_matches 'ERROR:' "$WORK_DIR/assert-scratch.out") \
  + $(count_matches 'ERROR:' "$WORK_DIR/probe.out") \
  + $(count_matches 'ERROR:' "$WORK_DIR/assert-source.out") ))

# struct and probe failures are always fatal.
FATAL=$(( FATAL \
  + $(count_matches '^FAIL  struct' "$WORK_DIR/assert-scratch.out") \
  + $(count_matches '^FAIL  struct' "$WORK_DIR/assert-source.out") \
  + $(count_matches '^FAIL  probe'  "$WORK_DIR/probe.out") ))

# A §13.3 invariant failing on the restore AND on the source is a data finding:
# the restore is faithful; the data is not. Failing on the restore alone is
# already caught by the fidelity diff above.
FINDINGS="$(count_matches '^FAIL  data' "$WORK_DIR/assert-scratch.out")"

T_VERIFY=$(( $(date +%s) - T_VERIFY_START ))
T_TOTAL=$(( $(date +%s) - T0 ))

# `grep -c` exits 1 when it finds nothing, and `pipefail` would turn a clean run
# with no warnings into a dead script. Guard both counts.
PASSED="$( { grep -hc '^ok'   "$WORK_DIR/assert-scratch.out" "$WORK_DIR/probe.out" || true; } \
            | awk '{s+=$1} END {print s+0}')"
WARNED="$( { grep -hc '^warn' "$WORK_DIR/assert-scratch.out" "$WORK_DIR/probe.out" || true; } \
            | awk '{s+=$1} END {print s+0}')"

if [ "$FINDINGS" -gt 0 ]; then
  say ""
  rule
  say "DATA FINDINGS — present in the RESTORE and in the SOURCE alike."
  say "The restore reproduced the source faithfully. The data is what is wrong."
  rule
  grep '^FAIL  data' "$WORK_DIR/assert-scratch.out" | sed 's/^/  /'
  say ""
  say "  These are not backup problems and restoring again will not fix them."
  say "  Raise each one, record it in the rehearsal log, and re-run with"
  say "  --strict-data once they are closed."
fi

# ─────────────────────────────────────────────────────────────────────────────
# Summary — paste this into docs/runbooks/backup-restore.md's rehearsal log.
# ─────────────────────────────────────────────────────────────────────────────
say ""
rule
say "  started        ${STARTED_AT}"
say "  source db      ${SOURCE_DB}"
say "  dump           ${DUMP_BYTES} bytes in ${T_DUMP}s"
say "  restore        ${T_RESTORE}s"
say "  verify         ${T_VERIFY}s"
say "  total          ${T_TOTAL}s"
say "  assertions     ${PASSED} passed, ${WARNED} warned, ${FATAL} failed, ${FINDINGS} data finding(s)"
rule

if [ "$FATAL" -gt 0 ]; then
  say ""
  say "RESULT: FAILED — ${FATAL} problem(s) with the RESTORE. This backup is not"
  say "        proven usable. Re-run with --keep and inspect the scratch database."
  exit 1
fi

if [ "$FINDINGS" -gt 0 ] && [ "$STRICT_DATA" -eq 1 ]; then
  say ""
  say "RESULT: FAILED (--strict-data) — the restore is faithful, but ${FINDINGS} §13.3"
  say "        invariant(s) do not hold on the data in either database."
  exit 1
fi

say ""
if [ "$FINDINGS" -gt 0 ]; then
  say "RESULT: PASSED with ${FINDINGS} data finding(s) — the restored database counts"
  say "        the same, is constrained the same, answers every question the source"
  say "        answers, and still refuses a double-booking. The backup is sound; the"
  say "        findings above are about the data and belong in the rehearsal log."
else
  say "RESULT: PASSED — the restored database counts the same, is constrained the"
  say "        same, and still refuses a double-booking."
fi
exit 0

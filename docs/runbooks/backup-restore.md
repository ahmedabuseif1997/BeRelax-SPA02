# Runbook — Backup and restore

**Owner:** [TO BE COMPLETED — named engineer, with a mobile number]
**Cadence:** quarterly, and once before go-live
**Time needed:** 30 minutes, of which the script is a few minutes
**Where it runs:** any machine with `psql`, `pg_dump` and `pg_restore` at the same
major version as the database, and network access to Supabase

> Spec §11.9: *"Supabase daily backups + PITR, retained 30 days; **a restore is
> rehearsed quarterly** — an untested backup is a hope."*

A backup you have never restored is a belief, not a control. And a restore that
produces a database with all the rows and none of the exclusion constraints is
worse than no restore at all, because it looks like it worked. `scripts/backup-verify.sh`
exists to close that gap: it restores, and then asks the restored copy to
double-book a therapist and watches it refuse.

---

## 1. The rehearsal

### 1.1 Before you start

```bash
# Versions. pg_dump must be >= the server, or it refuses.
psql --version
pg_dump --version
psql "$DIRECT_URL" -tAc 'select version()'
```

`DIRECT_URL` — port **5432**, the session connection — not `DATABASE_URL` on
6543. `pg_dump` needs a session connection; PgBouncer in transaction mode will
either refuse or hand you a dump you cannot trust (spec §2.4).

You also need a connection that may `CREATE DATABASE`. On Supabase the
`postgres` role can. The script derives it from `--source` by swapping the
database name for `postgres`; pass `--admin` if that is not right for you.

### 1.2 Run it

```bash
cd /path/to/BeRelax-SPA02

# Keep the credential out of your shell history and out of `ps`.
export BACKUP_VERIFY_SOURCE="$DIRECT_URL"

scripts/backup-verify.sh --dump "./berelax-$(date -u +%Y%m%dT%H%MZ).dump"
```

Useful flags:

| Flag | When |
|---|---|
| `--keep` | Something failed and you want to go and look at the scratch database. |
| `--strict-data` | Make a §13.3 invariant that fails on *both* databases fatal. This is what CI should use. |
| `--scratch NAME` | The scratch database is dropped and recreated. Default `berelax_restore_verify`. Never name a real database. |
| `--jobs N` | Parallel restore. Worth it once the dump is over a gigabyte. |
| `--help` | Everything above, from the script itself. |

The script never writes to `--source`: every statement it sends there is a
`SELECT`. Everything it changes happens inside the scratch database it created,
and it drops that database on the way out. Running it twice does the same thing
as running it once.

### 1.3 What "passed" looks like

`RESULT: PASSED`, exit code 0, and a block of `ok` lines with no `FAIL`:

```
[5/6] Comparing the restored copy with the source
ok    census  tables    21 tables match the source row for row

[6/6] Interrogating the restored database

ok    struct  §5.1      btree_gist and pgcrypto installed
ok    struct  §5.1      uuid_generate_v7() present and returns a v7 UUID
ok    struct  §5.1      business_day(timestamptz) present, 02:30 Dubai -> previous day
ok    struct  §3.3      business_day() re-derives every stored reservations.business_day
ok    struct  §5.2      the three exclusion constraints are installed
ok    struct  §5.4      the five append-only triggers are installed
ok    struct  §5.4      every append-only and reservation trigger is ENABLED
ok    struct  §5.3      the reservation derive and status triggers are installed
ok    struct  §5.4      forbid_mutation, ledger_guard, derive and status functions present
ok    struct  §5.6      prune_attribution(int) present
ok    data    fixture   203 reservations, 213 payments, 87 tips, 133 ledger entries
ok    data    §13.3(1)  every ledger balance = collected tips + commissions - payouts
...
ok    probe   doubleBk  the restored database refused a double-booking [23P01]
ok    probe   derive    trg_reservations_derive still sets ends_at, blocked_until, business_day
ok    probe   status    COMPLETED -> SCHEDULED refused by the state machine
ok    probe   append    payments refused an UPDATE [42501]
ok    probe   append    financial_audit_log refused a DELETE [42501]
ok    probe   append    therapist_payout_ledger refused an amount change [42501]
```

The `probe` lines are the ones that matter. Everything above them is a claim
read out of the catalogue; the probes are the restored database being asked to
misbehave and refusing.

The `fixture` line is the other one to read. If it says
`warn data fixture no reservations`, you have successfully restored the wrong
database.

### 1.4 How long it takes

Record the numbers from the summary block, every time. They are the only
warning you get that a restore has quietly grown past the window you have.

| Database | Dump | Restore | Verify | Total |
|---|---|---|---|---|
| Local dev, 21 tables / 1,899 rows / 165 KB | < 1 s | < 1 s | 1 s | **1 s** |
| Production, year 1 (est. ~25k reservations + money rows) | expect seconds, not minutes | | | |

At this data volume the restore is not the slow part; getting a connection and
a scratch database is. Budget 30 minutes for the whole rehearsal including the
write-up, not because the machine is slow but because reading the output
properly is the job.

### 1.5 Where to record it

Two places, both in this repository:

1. **The rehearsal log at the bottom of this file.** Append a row. Commit it.
2. **`docs/compliance/data-processing-register.md`** — §11.9 lists backups as a
   control that carries compliance weight, and "rehearsed quarterly" is a claim
   the business makes to a regulator. A control nobody can evidence is a control
   the business does not have.

If a rehearsal produced data findings, link the ticket you raised for each.

---

## 2. When it fails

The script separates three kinds of failure, on purpose, because they need
three different responses.

### 2.1 `FAIL struct` or `FAIL probe` — the restore is broken

The restored database is missing a constraint, a trigger or a function, or it
accepted something it should have refused. **Stop. Do not treat this backup as
usable.**

```bash
scripts/backup-verify.sh --keep      # then go and look
psql "$SCRATCH_URL" -c "\d reservations"
psql "$SCRATCH_URL" -c "select tgname, tgenabled from pg_trigger where not tgisinternal"
```

Most likely causes, in the order they actually happen:

| Symptom | Cause | What to do |
|---|---|---|
| Exclusion constraints missing | `btree_gist` was not available in the target before the restore | Pre-create the extension in the scratch database, restore again. If the *source* is also missing it, the source is the problem. |
| A trigger is present but `DISABLED` | Something disabled it and did not re-enable it — the `payment_created_at` migration does this deliberately for one backfill statement | Find what disabled it. A disabled append-only guard means the financial history has been writable for however long it has been off. |
| `pg_restore` itself failed | Version skew, or a role/ownership problem | Check `pg_dump --version` against the server. Re-dump with `--no-owner --no-privileges` (the script already does). |
| Census mismatch | The dump was taken while something was writing, or the dump is truncated | Re-dump. If it recurs, the dump is not completing — check disk and the connection. |

### 2.2 `FAIL fidelity` — the restore is not the source

The same read-only question got a different answer from the two databases. That
is the most serious outcome the script can report: the restore is silently
*different*. Keep the scratch database, keep the dump, and do not overwrite
either until you know why.

### 2.3 `DATA FINDINGS` — the restore is fine, the data is not

A §13.3 invariant fails identically on the source and on the restored copy. The
backup faithfully reproduced production, and production has a data problem.

The run still passes by default, because this script answers "can I restore this
database", and a rehearsal blocked on an unrelated data ticket is a rehearsal
that stops being run. But the finding is not optional:

1. Raise it as a ticket, with the count from the output.
2. Record it in the rehearsal log row.
3. Once it is closed, re-run with `--strict-data` and confirm it comes back clean.

---

## 3. Supabase specifics

### 3.1 What Supabase gives you

| | What it is | Where |
|---|---|---|
| Daily backups | A scheduled backup of the project, retained per plan | Dashboard -> Project -> Database -> Backups |
| PITR | Write-ahead-log based recovery to a chosen second, a paid add-on | Same page, once the add-on is enabled |
| Retention | §11.9 commits to **30 days**. This is a plan/add-on setting, not a default | Verify it in the dashboard and record what you saw |

**Confirm, do not assume.** Supabase's plans and the backup features on them
change. At the first rehearsal, open that page, write down exactly which
backup types the project has, what the retention actually is, and whether
"restore to a new project" is offered. Put the answer in the rehearsal log. If
retention is not 30 days, that is a §11.9 gap and it belongs in the compliance
register, not in someone's memory.

### 3.2 PITR restores the project. It does not restore your configuration.

This is the part people get wrong at 04:00.

- **Restoring in place** rolls the *same* project back to a point in time.
  Everything written after that point is gone. There is no undo. Use it only
  when you have decided that losing that window is better than keeping it.
- **Restoring to a new project** gives you a second project, at a chosen point
  in time, alongside the live one. This is what you want for anything
  investigative, and what you want for a rehearsal against real data.

Either way, the restore does not touch the application. After a restore you
have a database; you do not yet have a system.

### 3.3 After a restore to a NEW project — the honest list

A new Supabase project has a new host, a new password, and therefore **new
connection strings**. Nothing rotates itself. In order:

1. **Rotate `DATABASE_URL` and `DIRECT_URL`** — both of them, in all three
   places they live:
   - Vercel -> the API project -> Settings -> Environment Variables (Production)
     — **and then redeploy.** A saved variable does nothing to the deployment
     that is already running; a new production deployment is what carries it.
   - GitHub -> Settings -> Environments -> production -> `PRODUCTION_DATABASE_URL`, `PRODUCTION_DIRECT_URL`
   - Any operator's local `.env` used for migrations
   Remember the shapes differ: `DATABASE_URL` is the transaction pooler on
   **6543** with `?pgbouncer=true&connection_limit=1`; `DIRECT_URL` is the
   session connection on **5432**. Swapping them costs an afternoon (§2.4).
2. **Do NOT rotate `ERASURE_SALT`.** Rotating it orphans every already-erased
   guest record, because the phone hash stops matching. It is the one secret
   that must survive every incident intact.
3. **Re-check the extensions.** `btree_gist` and `pgcrypto` must be present, or
   the exclusion constraints will not have restored.
4. **Re-check the retention job.** `pg_cron` schedules do not necessarily travel
   with a restore:
   ```sql
   SELECT jobname, schedule, command FROM cron.job WHERE jobname = 'prune-attribution';
   ```
   If it is missing, re-apply the `20260917090000_retention_schedule` migration
   or schedule it by hand:
   ```sql
   SELECT cron.schedule('prune-attribution', '30 3 * * *',
                        $$SELECT prune_attribution(90)$$);
   ```
   `GET /v1/compliance/processing-register` reports `retentionJob.scheduled`, so
   an unscheduled database shows up as a finding in the register rather than as
   silence.
5. **Re-check the migration state**, before pointing the API at it:
   ```bash
   pnpm --filter api exec prisma migrate status
   ```
   A restored copy can legitimately be *behind* the deployed code.
6. **Run `scripts/backup-verify.sh` against the restored project** before it
   takes a single booking.
7. **Redeploy the API** so every instance builds a fresh Prisma pool. There is
   no "restart the service" on Vercel: a new production deployment is what
   replaces the running instances, and the warm ones still holding connections
   to a database that no longer exists go with them.
8. **Delete the old project only after** the new one has taken real traffic for
   a full trading day — and after a `pg_dump` of it is stored somewhere else.

### 3.4 The rehearsal does not need PITR

`scripts/backup-verify.sh` dumps and restores with stock `pg_dump`/`pg_restore`.
It works on any PostgreSQL 13+, on any host, whether or not Supabase's backup
features are enabled, and whether or not you can reach the dashboard. That is
deliberate: §11.7(5) says the schema is host-agnostic on purpose, and the
rehearsal should not depend on the vendor whose failure it is rehearsing for.

The quarterly rehearsal should exercise **both** paths at least once a year:
the script against a live dump, and a Supabase dashboard restore-to-new-project.
They fail in different ways.

---

## 4. Restoring for real — a disaster, not a rehearsal

Ordered. Do not skip step 1.

1. **Stop writes.** A half-restored database taking bookings is how one incident
   becomes two. Tell reception to go back to paper *now*, and write down the time
   you told them.

   **There is no "scale to zero" any more** — the API is serverless and has no
   replica count. Two things genuinely stop writes, and they are not
   interchangeable:

   - **Take the deployment out of service.** Vercel -> the API project ->
     **Settings -> Domains** -> remove `api.berelax.ae`. The hostname stops
     being served by the project within seconds, **DNS is untouched**, and
     putting it back is one action in the same screen with no TTL to wait out.
     Vercel may also offer a project-level pause in the project's advanced
     settings — if your plan has it, that is the cleaner "the whole project
     stops"; confirm it exists *before* you need it at 04:00, and if you cannot
     find it, remove the domain. **This is the right one when the API is the
     only writer and you intend to put it back within the hour** — which is
     every ordinary restore.
   - **Rotate the Supabase database password.** Supabase -> Project Settings ->
     Database -> Reset database password. This is the only one that stops
     **every** writer, including the ones you are not thinking about: a
     forgotten script, an operator's open `psql`, a warm function instance
     holding a pooled connection. **Use it when you cannot account for every
     writer, or when the restore is happening because credentials were
     compromised** (then it is `docs/compliance/runbooks/data-breach.md` 1.3 as
     well, and its clock has started). The cost is that it invalidates
     `DATABASE_URL` and `DIRECT_URL` everywhere at once — your own shell
     included — so rebuild your connection string before step 2. You were going
     to rotate both in §3.3 anyway.

   Removing the `api.berelax.ae` **DNS record** is still possible and is the
   blunt version: slower to take effect and slower to undo, because you then
   wait out the TTL twice. Prefer removing the domain in the project.
2. **Decide the target time.** Read `financial_audit_log` — it is append-only
   and database-enforced, so during an incident it is the only record you can
   still trust (§11.8). Find the last known-good moment.
3. **Restore to a NEW project**, never in place, unless you have explicitly
   decided to discard everything after the target time.
4. **Verify before connecting anything**: `scripts/backup-verify.sh --source <new DIRECT_URL>`.
   If it does not pass, you do not have a database yet.
5. **Rotate the connection strings** — §3.3 above, in order.
6. **Re-point and redeploy** the API, and put `api.berelax.ae` back on the
   project if you removed it in step 1. Watch `/health/ready` — it is a
   `SELECT 1` against the pool, so a 200 is the proof that the new connection
   strings reached the running deployment.
7. **Reconcile the gap by hand.** Everything between the target time and the
   moment you stopped writes exists only on paper. Reception re-enters it as
   normal bookings and normal check-ins, with the real `collected_at` times.
   Never by direct SQL: the append-only triggers and the audit interceptor are
   what make the reconstructed night defensible afterwards.
8. **Write the incident up** — timeline, what was lost, what was re-entered, by
   whom. If personal data was exposed rather than merely lost, this is also a
   §11.8 breach and the Data Office clock has already started.

---

## 5. Rehearsal log

Append a row after every rehearsal. Commit it. An empty table below is a §11.9
finding, not an oversight.

| Date (UTC) | Source | Result | Dump | Dump time | Restore | Verify | Total | Data findings / tickets | By |
|---|---|---|---|---|---|---|---|---|---|
| 2026-09-17 | local dev `berelax` (**script validation, not a production rehearsal**) | PASSED, 28 assertions, 1 data finding | 165 KB | <1 s | <1 s | 1 s | 1 s | §13.3(7): 7 money rows whose audit entry is not within 1 s of `created_at`. Pre-existing: rows written through the API *before* `20260916210000_payment_created_at`, whose `created_at` was back-filled from the retro-dated `collected_at`. Present identically in source and restore. | deployment config work |
| | | | | | | | | | |

---

## 6. Related

- `scripts/backup-verify.sh` — the script, and `--help`
- `docs/runbooks/go-live.md` — the rehearsed restore is a go-live gate
- `docs/runbooks/alerts.md` — "a failed nightly backup" is one of the alerts
- `docs/compliance/runbooks/data-breach.md` — when the loss is a disclosure
- `docs/sql/verify-core-constraints.sql` — the same guarantees, proven from
  scratch on an empty database rather than on a restore
- Spec §11.9 (controls), §11.7 (where the data sits), §13.3 (the invariants)

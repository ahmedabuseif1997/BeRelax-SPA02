# Runbook — Alerts

**BE RELAX Massage Center and Spa — API**

| | |
|---|---|
| **Version** | `1.0-draft` |
| **Date** | 17 September 2026 |
| **Implements** | Architecture spec [§12.3](../spa-crm-architecture-spec.md) |
| **Read this when** | Your phone went off |
| **Companion** | [`../compliance/runbooks/data-breach.md`](../compliance/runbooks/data-breach.md) — if any alert here turns out to be someone else in the data, stop and go there instead |

Six alerts. §12.3 says they go **to the owner's phone**, which means six is the
budget: a seventh that fires on a Tuesday teaches everyone to swipe the
notification away, and then the one that matters is swiped away too.

The spa trades **11:00–02:00 Dubai**. Deploys happen 03:00–09:00 (§12.2). An
alert during trading is interrupting someone who is with a guest, so each one
below says whether it can wait until closing.

---

## ⛔ BEFORE LAUNCH — these blanks must be filled

| Role | Name | Mobile |
|---|---|---|
| **On-call (receives all six)** | `[TO BE COMPLETED: NAME]` | `[TO BE COMPLETED: MOBILE]` |
| **Business owner** | `[TO BE COMPLETED: NAME]` | `[TO BE COMPLETED: MOBILE]` |
| **Manager on duty** | On the shift roster | 052 510 8633 / 02 557 6533 |

| Thing | Where |
|---|---|
| Log search | `[TO BE COMPLETED: the log platform's URL]` |
| Supabase project | `[TO BE COMPLETED]` |
| API host (Railway) | `[TO BE COMPLETED]` |

---

## How to read the log filters

Every line the API emits is one JSON object (§12.3, `src/common/logger.ts`).
The fields the filters below use:

| Field | What it is |
|---|---|
| `level` | `info` \| `warn` \| `error` \| `fatal` — a **string**, not a number |
| `msg` | the message; `request completed` / `request errored` for autologged requests |
| `requestId` | on **every** line, and in the `error.requestId` the caller was given (§3.6) and in `financial_audit_log.request_id` (§9.6) |
| `route` | the matched pattern — `/v1/reservations/:id`, never a real id |
| `userId`, `role`, `branchId` | present once the request is authenticated |
| `res.statusCode` | on the request-completed line |
| `req.method`, `req.path`, `req.ip` | path only; the query string is stripped before it is logged |

**What is deliberately not there:** guest names, phone numbers, emails, password
hashes, tokens, cookies, `authorization` headers, request bodies. Do not go
looking for them and do not add them to make an investigation easier — §11.9 and
the privacy notice are what they are. `requestId` is the join key; from it,
`financial_audit_log` gives the actor and the money, and the guest record gives
the person.

Given `requestId`:

```sql
SELECT created_at, action, entity_type, entity_id, actor_user_id, actor_role, amount_fils
FROM   financial_audit_log
WHERE  request_id = :request_id
ORDER  BY created_at;
```

---

## 1 — API 5xx rate above 1% over 5 minutes

**Condition.** Over a rolling 5-minute window, `5xx responses / total responses > 0.01`, with a floor of at least 20 responses in the window so that one failure in three requests at 01:50 does not page anybody.

**Detect it.** Autologged request lines only — `msg` is `request completed` or `request errored`:

```
# numerator
msg:("request completed" OR "request errored") AND res.statusCode >= 500
# denominator
msg:("request completed" OR "request errored")
```

Health checks and static paths are never autologged, so probe traffic does not
dilute the denominator. The route breakdown, which is the first thing you want:

```
msg:("request completed" OR "request errored") AND res.statusCode >= 500
| stats count() by route, res.statusCode
```

Every 5xx also emits a second line from the exception filter, at `level: error`,
carrying the stack:

```
level:error AND (msg:"unhandled exception" OR msg:"unhandled database error")
```

**Why it matters.** A 5xx during trading is a receptionist with a guest at the
desk and a button that does nothing. §12.2 is explicit that the failure mode has
to be *visibly* failing rather than quietly wrong — a write that 500s has not
been recorded, and if the guest has already handed over cash, the till and the
system have diverged for the rest of the night.

**When it fires.**

1. Filter to `level:error` for the window and read the `msg` on the error lines. One `route` with one repeated stack is a bug; errors spread across every route is the database or the host.
2. If they are spread, go to **alert 2** — it is usually that.
3. Take a `requestId` from a failing line and run the `financial_audit_log` query above. **If an audit row exists, the transaction committed** and the 500 happened afterwards — the money is recorded and the receptionist is about to take it a second time. Ring the manager on duty before anything else.
4. If no audit rows exist for any failing request, nothing committed; the damage is confined to the requests that failed.
5. Roll back the API to the previous deploy. §12.2 bans deploys during trading, so a 5xx rate that started during trading is almost never a deploy — but a rollback is cheap and reversible.
6. Tell the manager on duty to fall back to paper until it clears, and to keep the slips: the nightly reconciliation (`nightly_reconciliations`) is how the night gets re-entered.

**Can it wait?** No.

---

## 2 — Database connection failures

**Condition.** Any readiness failure, or any log line reporting that the pool could not hand out a connection.

**Detect it.** The readiness endpoint is the primary signal — `/health/ready` runs `SELECT 1` against the pool (§12.3) and returns 503 with `DATABASE_UNAVAILABLE` when it cannot. Alert on **two consecutive** failed probes, so that one restarting container does not page.

In the logs — connection failures surface as Prisma initialisation and pool errors, not as ordinary query errors:

```
level:error AND msg:"unhandled database error" AND (err.name:"PrismaClientInitializationError" OR err.code:("P1001" OR "P1002" OR "P1008" OR "P1017" OR "P2024"))
```

| Code | Meaning |
|---|---|
| `P1001` | cannot reach the database server |
| `P1002` | reached it, timed out |
| `P1008` | operation timed out |
| `P1017` | server closed the connection |
| `P2024` | timed out waiting for a connection **from the pool** |

`P2024` is the one to read carefully: the database is up and this API cannot get
a connection out of its own pool. §2.4 pins `connection_limit=1` against the
transaction-mode pooler, so `P2024` usually means a long-running transaction is
holding the single connection.

```sql
-- Who is holding a connection, and for how long
SELECT pid, state, wait_event_type, wait_event,
       now() - xact_start AS in_transaction,
       left(query, 120) AS query
FROM   pg_stat_activity
WHERE  datname = current_database() AND pid <> pg_backend_pid()
ORDER  BY xact_start NULLS LAST;

-- Idle in transaction for more than a minute: this is the usual culprit
SELECT count(*)
FROM   pg_stat_activity
WHERE  datname = current_database()
  AND  state = 'idle in transaction'
  AND  now() - state_change > interval '1 minute';
```

**Why it matters.** Nothing works. Every reservation, payment and tip goes
through Postgres, and §12.2's degraded mode is the dashboard rendering a cached
grid with every write button disabled — the spa can still see tonight's bookings
but cannot take a dirham through the system.

**When it fires.**

1. `curl -s -o /dev/null -w '%{http_code}\n' https://api.berelax.ae/health/ready` — confirm it is real.
2. Supabase dashboard: is the project up, paused, or out of disk? Out of disk is the one that looks like a network fault and is not.
3. If Supabase is healthy, it is the pool. Run the `pg_stat_activity` queries; terminate a stuck backend with `SELECT pg_terminate_backend(:pid)` only after reading its query — terminating a payment write mid-transaction is safe (it rolls back, audit row and all, §9.6) but terminating a migration is not.
4. Restart the API. With `connection_limit=1` a restart clears a leaked connection reliably.
5. Tell the manager on duty to go to paper.

**Can it wait?** No.

---

## 3 — Any `AUTH_REFRESH_REUSE_DETECTED`

**Condition.** A single occurrence. Not a rate — **one**.

**Detect it.** It is an audited action (§9.6), so the audit log is the source of truth:

```sql
SELECT a.created_at,
       a.actor_user_id,
       a.actor_role,
       a.ip_address,
       a.user_agent,
       a.request_id,
       u.email
FROM   financial_audit_log a
LEFT   JOIN users u ON u.id = a.actor_user_id
WHERE  a.action = 'AUTH_REFRESH_REUSE_DETECTED'
  AND  a.created_at > now() - interval '15 minutes'
ORDER  BY a.created_at DESC;
```

Poll that every five minutes and alert on any row. The `request_id` ties it to
the log line for the same request.

**Why it matters.** §6.3: refresh tokens rotate, and a rotated token is used
exactly once. A second use of an already-rotated token means two parties hold
the same token — which happens when one of them stole it. The detection exists
because the theft is otherwise invisible; the whole family is revoked on
detection, so by the time the alert reaches the phone, **the legitimate user has
also been logged out**, and a confused receptionist ringing to say she has been
signed out is corroboration, not a separate problem.

**When it fires.**

1. Identify the user from the query above.
2. **Ring that person.** Ask whether they were signed out just now and where they are. If they are a manager on the floor and their phone is in their hand, it was probably a genuine race (a retried request on flaky Wi-Fi) — note it and move on.
3. If they cannot account for it, treat it as a credential compromise:
   ```sql
   -- Kill every session for that user
   UPDATE refresh_tokens SET revoked_at = now()
   WHERE  user_id = :user_id AND revoked_at IS NULL;
   ```
   then reset their password and have them log in on a device you can see.
4. Read what that session did before it was caught:
   ```sql
   SELECT created_at, action, entity_type, entity_id, amount_fils, ip_address
   FROM   financial_audit_log
   WHERE  actor_user_id = :user_id
     AND  created_at > now() - interval '24 hours'
   ORDER  BY created_at;
   ```
5. **If anything there was not done by the legitimate user, this is a personal data breach.** Stop and go to [`../compliance/runbooks/data-breach.md`](../compliance/runbooks/data-breach.md) — PDPL Art. 9 starts a clock (§11.8).
6. Two or more of these in a night, for different users, is a pattern. Rotate `JWT_SECRET` and revoke everything.

**Can it wait?** No. Step 2 is a phone call and takes two minutes.

---

## 4 — Exclusion-constraint violations above 5 per hour

**Condition.** More than five slot conflicts rejected by the database in a rolling hour.

**Detect it.** `PrismaErrorFilter` logs one line per rejection (`src/common/prisma-error.filter.ts`):

```
level:warn AND msg:"slot conflict rejected by the database"
| stats count() by constraint
```

| `constraint` | What collided |
|---|---|
| `reservations_no_therapist_overlap` | two bookings for one therapist |
| `reservations_no_room_overlap` | two bookings in one room |
| `reservations_no_guest_overlap` | one guest booked twice at once |
| `null` | an exclusion violation with no name matched — read the raw line |

The same thing after the fact, from what actually landed:

```sql
-- Conflicts are REJECTED, so they leave no reservation row. What they leave is
-- the near-miss: bookings created within a minute of each other for the same
-- therapist on the same night. A cluster here is the same story.
SELECT r.business_day,
       r.employee_id,
       count(*)                         AS bookings,
       min(r.created_at)                AS first_created,
       max(r.created_at)                AS last_created
FROM   reservations r
WHERE  r.created_at > now() - interval '1 hour'
GROUP  BY r.business_day, r.employee_id
HAVING count(*) > 1
ORDER  BY last_created DESC;
```

**Why it matters.** §5.2 puts the exclusion constraints in the database because
they are the only place a double-booking can be prevented under concurrency.
They are the *last* line, not the first: the availability grid is supposed to
have stopped the receptionist before she got there. Five an hour means the grid
is handing out slots that are already taken — she picks a time, presses save,
gets a red box, picks again. §12.3 calls this "the availability UI is showing
stale slots", and the guest standing at the desk is watching it happen.

**When it fires.**

1. Group by `constraint`. All one therapist, or spread?
2. Is the dashboard serving a stale grid? §12.2 has it fall back to the last cached response with a stale banner when the API is unreachable — check **alert 2** first, because a flapping API produces exactly this.
3. Check the grid's refresh: a receptionist who left the booking page open since 18:00 is looking at 18:00's availability. If that is it, tell her to reload, then fix the polling.
4. Verify the constraints are actually installed — a migration that did not land makes conflicts *stop* being rejected, which is far worse and looks like silence:
   ```bash
   psql "$DIRECT_URL" -f docs/sql/verify-core-constraints.sql
   ```
5. If the rate is high and the grid is fine, look for a retry loop: one client resubmitting the same booking. The `requestId` on each line is distinct per attempt; the `userId` will not be.

**Can it wait?** Until the end of the night, unless a receptionist is actively stuck. Nothing is being lost — every one of these is the database refusing a double-booking correctly.

---

## 5 — A failed nightly backup

**Condition.** No successful Supabase daily backup in the last 26 hours. (26, not 24: the window drifts.)

**Detect it.** Backups are platform-side, so the check is against Supabase, not
against this database — configure the alert on the project's backup status in
the Supabase dashboard, or poll the Management API for the project's latest
backup timestamp. **`[TO BE COMPLETED: the exact alert, once the project exists]`**

A backup that "succeeded" while the database stopped taking writes is the same
outage wearing a different hat, so pair it with a freshness canary — a database
that has taken no writes all night is either closed or broken:

```sql
-- Expect rows every trading night. Zero for a night the spa was open is wrong.
SELECT max(created_at)                       AS last_write,
       now() - max(created_at)               AS since_last_write,
       count(*) FILTER (WHERE created_at > now() - interval '24 hours') AS writes_today
FROM   financial_audit_log;
```

**Why it matters.** §11.9 commits to daily backups plus PITR retained 30 days,
and the data processing register repeats that commitment to a regulator. More
plainly: the `financial_audit_log` is retained seven years, is append-only and
cannot be reconstructed from anything else (§5.4). If it is gone, every dispute
after that point is your word against the guest's (§9.7).

**When it fires.**

1. Supabase dashboard → Database → Backups. Read the actual failure.
2. Out of disk is the usual cause, and it fails writes before it fails backups — check **alert 2**.
3. Take a manual backup immediately: `pg_dump "$DIRECT_URL" -Fc -f berelax-$(date -u +%Y%m%dT%H%M%SZ).dump`, and put it somewhere that is not the same account.
4. Two consecutive nights failed is an escalation to Supabase support and a note to the owner: §11.9's promise is not being kept, and the quarterly restore rehearsal (also §11.9) is now overdue regardless of the calendar.

**Can it wait?** Until morning, *if* step 3 has been done. The manual dump is not optional.

---

## 6 — A reservation still `IN_PROGRESS` more than 4 hours past `blocked_until`

**Condition.** Any row.

**Detect it.**

```sql
SELECT r.id,
       r.ref,
       r.business_day,
       r.starts_at,
       r.blocked_until,
       now() - r.blocked_until           AS overdue_by,
       r.employee_id,
       e.display_name                    AS therapist,
       r.base_cost_fils
FROM   reservations r
JOIN   employees e ON e.id = r.employee_id
WHERE  r.status = 'IN_PROGRESS'
  AND  r.blocked_until < now() - interval '4 hours'
ORDER  BY r.blocked_until;
```

Run it hourly. Alert on any row. A treatment is 30–90 minutes and
`blocked_until` already includes the branch turnaround (§4.1), so four hours past
it is not a long massage.

**Why it matters.** §8 makes check-in and checkout two separate steps for a
reason: check-in holds the slot, **checkout is where the money is recorded** —
the payment rows, the tip, the therapist's ledger entry (§9.1). A reservation
stuck in `IN_PROGRESS` is a treatment that was given and never paid for *in the
system*. The therapist is not accruing their commission, the till will not
reconcile, and by the time anyone notices the guest has gone home. It also keeps
the therapist and the room blocked, so the grid shows them busy when they are
free.

**When it fires.**

1. Ring the manager on duty and read them the `ref` — the human-readable one, `BR-2026-0417`, which is why it exists (§4.1).
2. Ask: did the guest pay? The paper slip or the card terminal is the answer, not the system.
3. **Paid** → complete the checkout in the dashboard with the real amounts. It is late, and it records correctly; that is the point of the two-step workflow.
4. **Not paid** (walked out, comped, cancelled mid-treatment) → the manager cancels it with a reason. Do not leave it `IN_PROGRESS`.
5. **Nobody remembers** → it goes into that night's `nightly_reconciliations` as a variance with a note. Never guess an amount into the money tables: §9.4 makes corrections reversals rather than edits, so a wrong figure entered now needs a reversal later and lives in the audit log forever.
6. More than one or two a week is a workflow problem, not an incident — reception is not pressing checkout. That conversation belongs with the manager, not in this runbook.

**Can it wait?** Until the next morning. Nothing is lost by waiting; something is lost by guessing at 02:00.

---

## What is deliberately not alerted on

| Not alerted | Why |
|---|---|
| 4xx rate | Guests and receptionists make mistakes. A validation error is the system working. |
| Rate limiting (429) | §12.4's limits are doing their job. Alert on this and the login brute-force protection becomes the thing that wakes you. |
| Slot conflicts **under** 5/hour | A busy Friday produces a few. The database refused them; that is the design (§5.2). |
| Retention job output | It runs nightly on `pg_cron` (§5.6) and its results belong in a weekly read, not a 03:00 notification. |
| Failed logins | Until there is a pattern worth naming, this is a receptionist with caps lock on. Revisit once there is real traffic. |

---

## Review

| Date | By | Change |
|---|---|---|
| 17 Sep 2026 | `[TO BE COMPLETED]` | First version, from spec §12.3 |

Review this after any incident, and whenever a new alert is proposed — against
the six-alert budget at the top, not in addition to it.

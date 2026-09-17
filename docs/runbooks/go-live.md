# Runbook — Go-live

**Deploy window: 03:00–09:00 Dubai. Never during trading.**
The spa runs 11:00–02:00 (spec §12.2). 03:00 is after the last guest has left
and the till has been closed; 09:00 is before the morning shift arrives. A
deploy at 20:00 on a Thursday is not a deploy, it is an incident with a
changelog.

This is the ordered checklist for the day and the weeks before it. Steps marked
**[BLOCKED]** cannot be finished by engineering — they need the owner, counsel,
an account holder or a registrar. Every one of them takes days of someone
else's calendar, so they are listed first.

---

## 0. Blocked on somebody else — start these weeks early

None of these is code. All of them stop go-live.

| # | Step | Blocked on | Why it blocks |
|---|---|---|---|
| 0.1 | **`berelax.ae` registered and under our control** | The business / registrar | `api.berelax.ae` must be a *subdomain of the public site*. §10.5: the attribution cookie mirror is a first-party cookie; on any other domain Safari blocks it outright and most iOS attribution disappears silently. Nothing about this is fixable in code later. |
| 0.2 | **Counsel review of `docs/compliance/`** | Legal counsel | Ten open questions, led by the status of the PDPL Executive Regulations, the cross-border safeguard, and whether Federal Law 2/2019 reaches a non-clinical spa. None is answered in the documents because none should be guessed. |
| 0.3 | **Data Processing Addenda signed** — Supabase, Vercel, Railway, Netlify, Cloudflare | The business | §11.7(2). Countersigned copies into the business records. Guest data is leaving the UAE the moment the first booking is taken. |
| 0.4 | **The 63 `[TO BE COMPLETED]` blanks filled** in the privacy notice and the processing register | The business + counsel | DPO, breach contact, hosting regions, DPA statuses. |
| 0.5 | **A named breach contact — a person with a mobile, not a shared inbox** | The business | §11.8. `docs/compliance/runbooks/data-breach.md` needs the name before launch. |
| 0.6 | **`privacy.html` published on the public site** | The business (content) + counsel | The consent banner links to it. A consent gate pointing at a 404 is not consent. |
| 0.7 | **One privacy-notice version string agreed**, used in three places | The business | The notice, `BERELAX_PRIVACY_VERSION` in the page, and the `policyVersion` reception records. A consent filed against a version naming no document proves nothing. |
| 0.8 | **Supabase / Railway / Vercel / Sentry / Cloudflare accounts on paid plans**, owned by the business | The business | PITR is a paid add-on (§11.9 commits to 30 days' retention). Railway pre-deploy commands and Render pre-deploy both need a paid instance. An account in an engineer's personal name is a single point of failure with a leaving date. |
| 0.9 | **Region chosen and the reasoning written down** | Engineering decides, the business signs it off | §11.7(1). There is no UAE Supabase region; Frankfurt (`eu-central-1`) has the stronger "adequate protection" argument. **Record the choice and why in `docs/compliance/data-processing-register.md`** — that record is the first thing anyone will ask for. Put the API in the same jurisdiction, so the privacy notice names one country and not two. |
| 0.10 | **The owner's phone number for alerts** | The business | §12.3 alerts go to a person, at night. |
| 0.11 | **Reception trained, and the two-week parallel run scheduled** | The business | Spec Phase 7, and `docs/runbooks/parallel-pilot.md`. Switch over only when the paper and the system agree for five consecutive nights. Do not skip this. |

---

## 1. T-1 week — provision

- [ ] **1.1 Supabase project** created in the region from 0.9. PostgreSQL 15+.
- [ ] **1.2 Extensions available**: `btree_gist`, `pgcrypto`. Without `btree_gist`
      the exclusion constraints do not build, and without them the system does
      not do the one thing it exists to do.
- [ ] **1.3 PITR enabled**, retention confirmed as 30 days (§11.9). Write down
      what the dashboard actually says in `docs/runbooks/backup-restore.md` §3.1.
- [ ] **1.4 Both connection strings captured** (§2.4):
      - `DATABASE_URL` — transaction pooler, port **6543**, `?pgbouncer=true&connection_limit=1`
      - `DIRECT_URL` — session connection, port **5432**
      Using the wrong one costs an afternoon. Using the pooler for migrations
      fails outright: PgBouncer in transaction mode has no session advisory locks.
- [ ] **1.5 Railway project and service** created.
      - Root Directory: `platform`
      - Config-as-code path: `apps/api/railway.json`
      - Region: the same jurisdiction as 0.9
      - **GitHub auto-deploy OFF.** Two deploy paths means a push can release
        code before the database has been migrated, which is the one ordering
        that actually breaks things.
- [ ] **1.6 Vercel project** created for the dashboard.
      - Root Directory: `platform/apps/dashboard`
      - "Include files outside the root directory": **ON** (the build reaches up
        the workspace to build `@berelax/contracts` first)
      - `vercel.json` in that directory carries the rest.
- [ ] **1.7 Sentry projects** for the API and the dashboard.
- [ ] **1.8 Redis** provisioned for the rate limiter (`REDIS_URL`, §12.4).
- [ ] **1.9 Cloudflare Turnstile** site created (`TURNSTILE_SECRET`).

## 2. T-1 week — secrets

Generated on the day, stored in the platform secret manager, never in a file,
never in a commit, never in a chat message. `apps/api/.env.example` carries
names and no values, and it stays that way.

- [ ] **2.1 `JWT_SECRET`** — `openssl rand -base64 32`
- [ ] **2.2 `ERASURE_SALT`** — `openssl rand -base64 32`.
      **Write down, in the secret manager entry itself, that this is never
      rotated.** Rotating it orphans every already-erased guest record, because
      the phone hash stops matching. It survives every incident, including a
      full credential rotation after a breach.
- [ ] **2.3 Leave `JWT_SECRET_PREVIOUS` unset.** It exists only for the 24 hours
      of a rotation window.
- [ ] **2.4 Stored in all the places they are needed**, and nowhere else:

| Secret | Railway (API) | GitHub env `production` | Vercel |
|---|---|---|---|
| `DATABASE_URL` | yes | `PRODUCTION_DATABASE_URL` | no |
| `DIRECT_URL` | yes | `PRODUCTION_DIRECT_URL` | no |
| `JWT_SECRET` | yes | no | no |
| `ERASURE_SALT` | yes | no | no |
| `SENTRY_DSN` | yes | no | no |
| `REDIS_URL` | yes | no | no |
| `TURNSTILE_SECRET` | yes | no | no |
| `RAILWAY_TOKEN` | — | yes | no |
| `VERCEL_TOKEN` / `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` | no | yes | — |

The API's own secrets do **not** belong in GitHub. CI never needs to mint a
token or hash a password; it needs to run one migration.

- [ ] **2.5 Non-secret variables** set in Railway (§12.5):
      `NODE_ENV=production`, `PORT=3000`, `TZ=UTC`,
      `API_BASE_URL=https://api.berelax.ae`,
      `DASHBOARD_ORIGIN=https://crm.berelax.ae`,
      `PUBLIC_SITE_ORIGIN=https://berelax.ae`,
      `COOKIE_DOMAIN=.berelax.ae`,
      `WHATSAPP_NUMBER=971525108633`,
      `ATTRIBUTION_RETENTION_DAYS=90`, `GUEST_RETENTION_YEARS=3`,
      `FINANCIAL_RETENTION_YEARS=5`, `BCRYPT_COST=12`, `LOG_LEVEL=info`.
      `DEFAULT_BRANCH_ID` is filled in at step 5.3, once the branch row exists.
      **`TZ` stays `UTC`.** The database stores UTC and `business_day()` does the
      Dubai conversion; a container-level `Asia/Dubai` makes every log line
      disagree with every `timestamptz` (§3.2).
- [ ] **2.6 GitHub environment variables**: `RAILWAY_SERVICE`,
      `RAILWAY_ENVIRONMENT`, `API_BASE_URL`.
- [ ] **2.7 GitHub environment protection rule**: `production` requires a
      **reviewer**. GitHub cannot express "only 03:00–09:00 Dubai", and a
      cron-gated `if:` would only refuse a deploy someone had already decided to
      make. A human approver is the window. Name at least two, so one can be
      asleep.

## 3. T-1 week — the rehearsed restore

- [ ] **3.1 Run `scripts/backup-verify.sh` against the production database**
      (empty or seeded with pilot data — either is fine, the structural and
      probe assertions are the point at this stage).
- [ ] **3.2 Record the result** in `docs/runbooks/backup-restore.md` §5 and commit.
- [ ] **3.3 Also rehearse a Supabase dashboard restore-to-a-new-project once**,
      and confirm the connection-string rotation list in that runbook §3.3 is
      complete and correct for this project.

**This is a gate, not a nicety.** §11.9 and the README both say so: an untested
backup is a hope. Go-live does not proceed without a row in that log.

## 4. T-1 day — DNS

DNS propagates on its own schedule, so it goes in the day before, not on the
morning.

- [ ] **4.1 `berelax.ae`** (apex) — unchanged, Netlify, the existing public site.
- [ ] **4.2 `api.berelax.ae`** — CNAME to the Railway-provided host. Add the
      custom domain in Railway first so the certificate is issued.

      > **It must be `api.berelax.ae`.** Not `berelax-api.up.railway.app`, not
      > `api.berelax.io`, not an apex somewhere else. The attribution cookie
      > mirror (§10.5) writes a first-party cookie on `.berelax.ae`; from any
      > other registrable domain it is third-party and Safari drops it without
      > a word. Nothing errors, nothing logs, and the iOS half of the channel
      > ROI report is quietly wrong forever.

- [ ] **4.3 `crm.berelax.ae`** — CNAME to Vercel. Add the custom domain in
      Vercel first.
- [ ] **4.4 TLS live on all three**, TLS 1.2+, HSTS
      `max-age=31536000; includeSubDomains; preload` (§11.9). `includeSubDomains`
      on the apex covers `api.` and `crm.` — check the public site is ready for
      that before you set `preload`, because preload is hard to undo.
- [ ] **4.5 CORS matches reality**: the API allows exactly
      `https://berelax.ae`, `https://www.berelax.ae`, `https://crm.berelax.ae`
      (§12.4), which is what `DASHBOARD_ORIGIN` and `PUBLIC_SITE_ORIGIN` set.

---

## 5. The day — 03:00 Dubai

### 5.1 Deploy the API

- [ ] Confirm **Platform CI is green on the commit you are about to deploy**.
      The deploy workflow refuses otherwise, and that refusal is not a bug.
- [ ] Run the **Platform Deploy** workflow: Actions -> Platform Deploy -> Run
      workflow. Give it the tag or SHA, and tick the clock box.
- [ ] Approve the `production` environment when GitHub asks. You are the deploy
      window.
- [ ] The workflow, in order: gate on CI -> `prisma migrate deploy` ->
      assert the three exclusion constraints and five append-only triggers
      survived -> release the image -> poll `/health/ready` -> release the
      dashboard.

      **Migrations are a release step and run exactly once.** They do not run on
      container boot. `apps/api/railway.json` sets `deploy.preDeployCommand`, and
      Railway runs a pre-deploy command once per deployment regardless of how
      many replicas start; the workflow runs the same migration itself before
      the image is released, for deploys that go through CI. What the start
      command does is start the server. If migrations ran on boot, two replicas
      — three during a rollback — would race `migrate deploy` against one
      database; the advisory lock makes the losers wait rather than corrupt,
      until one times out mid-migration and leaves `_prisma_migrations` with a
      `finished_at` of NULL. Every subsequent deploy then refuses until a human
      resolves it by hand. At 03:20. Seven hours before opening.

- [ ] Confirm by hand:
      ```bash
      curl -s https://api.berelax.ae/health        # {"status":"ok",...}
      curl -s https://api.berelax.ae/health/ready  # {"status":"ok","database":"up"}
      ```

### 5.2 Prove the database guarantees, on production

- [ ] ```bash
      psql "$DIRECT_URL" -tAc "
        SELECT conname FROM pg_constraint
         WHERE contype = 'x' AND conrelid = 'public.reservations'::regclass
         ORDER BY conname;"
      ```
      Three rows: `reservations_no_guest_overlap`, `reservations_no_room_overlap`,
      `reservations_no_therapist_overlap`. Anything else, stop.
- [ ] `pnpm --filter api exec prisma migrate status` — no pending migrations.
- [ ] **The seed is not run.** `prisma db seed`, `migrate dev`, `migrate reset`
      and `db push` have no legitimate use here. The seed writes fake guests,
      fake takings and three accounts with printed passwords.

### 5.3 The branch row and the first OWNER

There is no bootstrap command, and there should not be one: an unauthenticated
"create the first owner" endpoint is a permanent hole kept open for one minute
of convenience. `POST /v1/users` requires an OWNER, so the first OWNER is made
by hand, once, and then never again.

- [ ] **Create the branch.** Real values — this row is what the public site's
      menu endpoint and every report hang off.
      ```sql
      INSERT INTO branches (name, address_line, city, phone_primary, whatsapp_number)
      VALUES ('BE RELAX', '250 Al Meena St, Al Zahiyah', 'Abu Dhabi',
              '+971525108633', '971525108633')
      RETURNING id;
      ```
- [ ] **Put that id in `DEFAULT_BRANCH_ID`** in Railway. Restart the service.
- [ ] **Generate a temporary password and its bcrypt hash off-machine**, at the
      cost the API uses (`BCRYPT_COST=12`):
      ```bash
      # On a trusted machine. The password goes to the owner over a channel the
      # owner already trusts, and nowhere else. Not into the ticket. Not here.
      node -e "const b=require('bcrypt');const p=require('crypto').randomBytes(12).toString('base64url');console.log(p);console.log(b.hashSync(p,12))"
      ```
- [ ] **Insert the user**, with `must_change_password` true:
      ```sql
      INSERT INTO users (branch_id, email, password_hash, full_name, role,
                         is_active, must_change_password, updated_at)
      VALUES ('<branch id>', lower('<owner email>'), '<bcrypt hash>',
              '<owner full name>', 'OWNER', true, true, now());
      ```
- [ ] **The owner logs in and changes the password immediately**, on the day,
      before anyone leaves the room:
      ```
      POST /v1/auth/login            -> mustChangePassword: true
      POST /v1/auth/change-password
      ```
      A temporary password gets exactly one use. Confirm afterwards:
      ```sql
      SELECT email, must_change_password, password_changed_at FROM users;
      ```
      `must_change_password` must be `false` and `password_changed_at` must be
      today. If it is still true when you leave, you have shipped a known
      credential.
- [ ] **Then create the rest of the accounts through the API** —
      `POST /v1/users` as the OWNER — never by SQL. That path hashes, audits and
      issues a one-use temporary password on its own.

### 5.4 The retention job

- [ ] **Attribution pruning**, on `pg_cron`. 03:30 UTC is 07:30 Dubai: after
      close, before the morning shift.
      ```sql
      SELECT cron.schedule('prune-attribution', '30 3 * * *',
                           $$SELECT prune_attribution(90)$$);
      SELECT jobname, schedule, command FROM cron.job;
      ```
      The `20260917090000_retention_schedule` migration does this itself when
      `pg_cron` is installed and the role may schedule; it raises a NOTICE and
      carries on when it cannot. **Check `cron.job` by hand rather than trusting
      the migration output** — on some managed platforms only the project owner
      may schedule.
- [ ] **Guest anonymisation** — the three-year half of §11.6 — is deliberately
      *not* a `pg_cron` job. Anonymising a guest writes an audit row with an
      actor, severs the attribution snapshots and rewrites the enquiry inbox,
      which is the same work the erasure endpoint does; a second SQL
      implementation would be the one that drifts. Point a scheduler at the
      endpoint nightly with an OWNER token:
      ```
      POST /v1/compliance/retention/run   { "dryRun": true }   # look first
      POST /v1/compliance/retention/run   { }                  # then do it
      ```
      **Run it with `dryRun` first against real data.** The first pass over a
      guest book that has never been pruned is the one where a mistake
      anonymises three years of guests at once, and it cannot be undone —
      `ERASURE_SALT` is one-way by design.
- [ ] Confirm `GET /v1/compliance/processing-register` reports
      `retentionJob.scheduled` as true.

### 5.5 Alerts

Each of these should page the owner's phone (§12.3). Test at least the first
one by triggering it deliberately, before you trust any of them. What to DO
when one fires is `docs/runbooks/alerts.md`; this list is only that each one
exists and reaches a human.

- [ ] API 5xx rate > 1% over 5 minutes
- [ ] Database connection failures
- [ ] Any `AUTH_REFRESH_REUSE_DETECTED` — a stolen refresh token, and the single
      most urgent signal the system produces
- [ ] Exclusion-constraint violations above 5/hour — that means the availability
      grid is showing slots that are already gone, and reception is arguing with
      the system in front of guests
- [ ] A failed nightly backup
- [ ] Any reservation still `IN_PROGRESS` more than 4 hours after `blocked_until`
      — someone forgot to check a guest out, and the money is not recorded
- [ ] **[BLOCKED]** the destination phone number (0.10)

### 5.6 The dashboard

- [ ] `https://crm.berelax.ae` loads, and login works end to end.
- [ ] The refresh cookie survives a reload — if `COOKIE_DOMAIN` or
      `DASHBOARD_ORIGIN` is wrong the `SameSite=Strict` cookie never arrives and
      every session dies after fifteen minutes.
- [ ] Book, check in and check out one real reservation, then reverse it.
      Then confirm it in the database, not in the UI.

### 5.7 Attribution — last, and only when the domain is real

- [ ] `api.berelax.ae` resolves, has a certificate, and answers `/health`.
- [ ] `privacy.html` is live **(0.6)** and the version string matches in all
      three places **(0.7)**.
- [ ] Only then uncomment, in the public site:
      ```js
      window.BERELAX_ATTRIBUTION_API = "https://api.berelax.ae/v1";
      ```
      Before that, the client is shipped dormant on purpose: it would beacon
      into nothing, and turning it on from the wrong domain loses the iOS
      attribution silently rather than loudly.
- [ ] Check a touch actually lands: one visit with `?utm_source=test`, then
      look for the snapshot row.

---

## 6. Before real guest data — the gate

Everything in §0 is closed, and:

- [ ] A **rehearsed restore** is in the log (§3).
- [ ] Counsel has signed off (0.2).
- [ ] Every `[TO BE COMPLETED]` is completed (0.4).
- [ ] The **two-week parallel run** (0.11, `docs/runbooks/parallel-pilot.md`) has
      been reconciled nightly and the numbers have matched for five consecutive
      nights.

Only then does paper stop.

---

## 7. When a deploy goes wrong

**The migration has already been applied by the time the image is released.**
That ordering is deliberate — it is the only one that works when a replica can
start at any moment — and it means the two halves roll back differently.

| Symptom | Do | Do not |
|---|---|---|
| `/health/ready` never goes green | Roll the **image** back in Railway to the previous deployment. The database stays where it is; these migrations are additive. | Roll the migration back. There is no `migrate down`, and hand-written DDL to undo a migration at 04:00 is how a schema becomes unrecoverable. |
| Migration failed half way | Read `_prisma_migrations`. A row with `finished_at` NULL and `logs` set is a partially-applied migration and needs a human decision, recorded. | `prisma migrate resolve --applied` to make the error go away. That marks it done when it is not. |
| Database unreachable, API otherwise healthy | Check the Supabase status page and the connection strings. `DATABASE_URL` on 6543, `DIRECT_URL` on 5432. | Point `DATABASE_URL` at 5432 "just to get it up". You will exhaust the direct connection limit and take the database down properly. |
| Data is wrong, not missing | `docs/runbooks/backup-restore.md` §4. | Fix it with `UPDATE`. `payments`, `tips` and the ledger refuse it, and that refusal is the feature. |
| It is now 09:30 and reception is arriving | Stop. Roll back to the last known-good image. Finish tonight. | Push one more fix. |

If personal data may have been exposed rather than merely unavailable, this is
also a §11.8 breach: `docs/compliance/runbooks/data-breach.md`, and the UAE Data
Office clock has already started.

---

## 8. Related

- `.github/workflows/platform-deploy.yml` — the deploy, and the secret list
- `platform/apps/api/railway.json` — start command, health check, release step
- `platform/apps/api/Dockerfile` — the image
- `platform/apps/dashboard/vercel.json` — the dashboard build
- `docs/runbooks/backup-restore.md` — the rehearsal and the real thing
- `docs/runbooks/alerts.md` — what to do when one of §5.5 fires
- `docs/runbooks/parallel-pilot.md` — the two weeks beside the paper
- `docs/compliance/runbooks/data-breach.md` — when it is a disclosure
- Spec §12.2 (window), §12.4 (hardening), §12.5 (variables), §11.7 (region),
  §11.9 (controls)

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
| 0.3 | **Data Processing Addenda signed** — **Supabase, Vercel**, and **Cloudflare if it is wired up** | The business | §11.7(2). Countersigned copies into the business records. Guest data is leaving the UAE the moment the first booking is taken. **This list is two shorter than it was.** The API moved off Railway and the public site is moving off Netlify, so both drop off — **two fewer DPAs to chase and two fewer cross-border transfer records to write and defend** (§11.7, and the register's §3 and §4). Vercel now hosts all three projects under one DPA. The Netlify DPA stays needed only until the cutover in [`netlify-to-vercel.md`](./netlify-to-vercel.md) §8.4 closes it out. |
| 0.4 | **The 63 `[TO BE COMPLETED]` blanks filled** in the privacy notice and the processing register | The business + counsel | DPO, breach contact, hosting regions, DPA statuses. |
| 0.5 | **A named breach contact — a person with a mobile, not a shared inbox** | The business | §11.8. `docs/compliance/runbooks/data-breach.md` needs the name before launch. |
| 0.6 | **`privacy.html` published on the public site** | The business (content) + counsel | The consent banner links to it. A consent gate pointing at a 404 is not consent. |
| 0.7 | **One privacy-notice version string agreed**, used in three places | The business | The notice, `BERELAX_PRIVACY_VERSION` in the page, and the `policyVersion` reception records. A consent filed against a version naming no document proves nothing. |
| 0.8 | **Supabase / Vercel / Sentry / Cloudflare accounts on paid plans**, owned by the business | The business | PITR is a paid add-on (§11.9 commits to 30 days' retention). Vercel's free tier is for personal, non-commercial use, and the things this deployment depends on — function duration, Fluid Compute, how long runtime logs are kept — are plan-dependent. `[TO BE COMPLETED: the Vercel plan, confirmed against its current terms and its function and log-retention limits]`. An account in an engineer's personal name is a single point of failure with a leaving date. |
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

**Three Vercel projects, one account.** The API, the dashboard and the public
site are separate projects with separate root directories and separate domains.
1.5 and 1.6 are two of them; the public site is [`netlify-to-vercel.md`](./netlify-to-vercel.md)
§1 and is not part of this checklist.

- [ ] **1.5 Vercel project for the API** created.
      - Root Directory: **`platform/apps/api`** — where `apps/api/vercel.json`
        lives. Not `platform`.
      - **"Include files outside the root directory": ON.** The build reaches up
        the workspace to build `@berelax/contracts` first. Without this the
        build fails, and it fails at the install step where it is not obvious
        why.
      - **Framework Preset: `Other` / none.** `vercel.json` sets
        `"framework": null`.
      - **Build and Output settings: leave every field empty.** `vercel.json`
        already carries `buildCommand`, `installCommand` and `outputDirectory`,
        and **a value typed into the dashboard overrides the file** — which is
        how the two drift apart and how the next person reads `vercel.json`,
        believes it, and is wrong.
      - **Fluid Compute: ON.** Of everything on this page it is the single
        setting that most affects cold starts: one instance serves several
        invocations at once instead of one apiece, so far fewer requests have to
        wait while Nest builds its module graph and Prisma loads its query
        engine. That wait is a receptionist watching a spinner with a guest in
        front of her (§12.1), and `memory: 1024` in `vercel.json` was already
        bought for the same reason.
        It is a project-level setting — look for it in the project's **Settings**
        under the functions/compute section, and confirm the exact location on
        the screen rather than from this line.
      - **Region: the same jurisdiction as 0.9**, and the same region as the
        Supabase project. `vercel.json` pins `regions: ["fra1"]`
        (`eu-central-1`); a function in one continent and a database in another
        pays every round trip twice, and a booking is several of them.
      - **No Git auto-deploy.** `apps/api/vercel.json` already sets
        `git.deploymentEnabled: false`, and that is what stops a push releasing
        code ahead of the migration — the one ordering that actually breaks
        things. The project does not need a Git connection at all for the
        deploy path in `.github/workflows/platform-deploy.yml`, which builds on
        the runner and uploads with `vercel deploy --prebuilt`. **If a
        deployment ever appears that the workflow did not create, that setting
        has been overridden in the project — fix it before deploying again.**
- [ ] **1.6 Vercel project** created for the dashboard.
      - Root Directory: `platform/apps/dashboard`
      - "Include files outside the root directory": **ON** (the build reaches up
        the workspace to build `@berelax/contracts` first)
      - `vercel.json` in that directory carries the rest.
- [ ] **1.7 Sentry projects** for the API and the dashboard.
- [ ] **1.8 No Redis, and nothing to provision for the rate limiter.** §12.4's
      limits are counted in **PostgreSQL**, in `rate_limit_counters`, shared by
      every function instance (`apps/api/src/common/pg-throttler.storage.ts`).
      There is no `REDIS_URL`. Do not add one: a second data store is a second
      processor, a second DPA and another row in the register, for a spa doing
      tens of bookings a night.
- [ ] **1.9 Cloudflare Turnstile** site created (`TURNSTILE_SECRET`).
- [ ] **1.10 Run `vercel build` locally, once, before the first real deploy.**
      Three things about `apps/api/vercel.json` could not be checked without a
      Vercel account, and this is the cheapest way to settle all three before
      03:00 rather than during it:

      1. that the monorepo install and build actually run from
         `platform/apps/api` with "Include files outside the root directory" on
         (1.5),
      2. that `functions["api/index.ts"].runtime: "nodejs22.x"` is accepted as
         written,
      3. that `includeFiles: "dist/**"` really ships `dist/` inside the
         function — `api/index.ts` does `require('../dist/serverless.js')`, and
         if that file is not in the bundle the deploy goes green and the first
         request fails.

      ```bash
      cd platform/apps/api
      vercel link                                  # pick the API project from 1.5
      vercel pull --yes --environment=production
      vercel build --prod                          # builds here; deploys nothing
      ```

      Then look at what it produced:

      ```bash
      find .vercel/output -type d -name '*.func'   # the function that would deploy
      find .vercel/output -name 'serverless.js'    # dist/ must be inside it
      ```

      The second command returning nothing is failure 3 above, found for free.

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

| Secret | Vercel — **API** project | GitHub env `production` | Vercel — **dashboard** project |
|---|---|---|---|
| `DATABASE_URL` | yes | `PRODUCTION_DATABASE_URL` | no |
| `DIRECT_URL` | yes | `PRODUCTION_DIRECT_URL` | no |
| `JWT_SECRET` | yes | no | no |
| `ERASURE_SALT` | yes | no | no |
| `SENTRY_DSN` | yes | no | no |
| `TURNSTILE_SECRET` | yes | no | no |
| `VERCEL_TOKEN` / `VERCEL_ORG_ID` | no | yes | no |
| `VERCEL_PROJECT_ID_API` | no | yes | no |
| `VERCEL_PROJECT_ID` | no | yes | no |

The API's own secrets do **not** belong in GitHub. CI never needs to mint a
token or hash a password; it needs to run one migration.

Everything in the API column goes in at **Vercel → the API project → Settings →
Environment Variables**, **Production** scope.

> **Two project ids, and do not rename the old one.**
> `VERCEL_PROJECT_ID_API` is the **API** project. `VERCEL_PROJECT_ID` — the
> unqualified name — is still the **dashboard's**, as it was before the API
> moved, and `.github/workflows/platform-deploy.yml` reads it that way. Renaming
> it for tidiness breaks the dashboard release the first time the workflow runs,
> at 03:00. If it is ever renamed, rename it in both places in one commit.

> **A saved variable is not a live variable.** On Vercel an environment variable
> belongs to a deployment: changing one does nothing to the deployment currently
> serving traffic until a **new production deployment** replaces it. This is
> true at go-live, it is true at 5.3 below, and it is the step people miss
> during a breach — see `docs/compliance/runbooks/data-breach.md` 1.2.

- [ ] **2.5 Non-secret variables** set on the **Vercel API project**, Production
      scope (§12.5):
      `NODE_ENV=production`, `TZ=UTC`,
      `API_BASE_URL=https://api.berelax.ae`,
      `DASHBOARD_ORIGIN=https://crm.berelax.ae`,
      `PUBLIC_SITE_ORIGIN=https://berelax.ae`,
      `COOKIE_DOMAIN=.berelax.ae`,
      `WHATSAPP_NUMBER=971525108633`,
      `ATTRIBUTION_RETENTION_DAYS=90`, `GUEST_RETENTION_YEARS=3`,
      `FINANCIAL_RETENTION_YEARS=5`, `BCRYPT_COST=12`, `LOG_LEVEL=info`.
      `DEFAULT_BRANCH_ID` is filled in at step 5.3, once the branch row exists.
      **`TZ` stays `UTC`.** The database stores UTC and `business_day()` does the
      Dubai conversion; a runtime set to `Asia/Dubai` makes every log line
      disagree with every `timestamptz` (§3.2).
      **`PORT` is gone from this list.** There is no port to bind: `serverless.ts`
      calls `app.init()` and the platform hands the request to Express directly.
      It still defaults to 3000 for `main.ts`, which is the local process.
- [ ] **2.6 GitHub environment variables**: `API_BASE_URL`. That is the whole
      list — it is what the deploy workflow polls `/health/ready` on.
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

- [ ] **4.1 `berelax.ae`** (apex) — the public site. It is moving from Netlify to
      Vercel under its own ordered runbook, [`netlify-to-vercel.md`](./netlify-to-vercel.md),
      which owns the TTL, the cutover and the rollback. **Do not touch the apex
      from here.** Whether it is on Netlify or on Vercel on the night, nothing in
      this section changes: `api.` and `crm.` are separate records.
- [ ] **4.2 `api.berelax.ae`** — add the custom domain on the **Vercel API
      project** first (**Settings → Domains**), so the certificate is issued,
      then create the DNS record **exactly as that screen tells you to**.
      Copy it from the screen, not from this runbook, not from a blog post and
      not from memory: the record type and value are Vercel's to specify and
      they change. `[TO BE COMPLETED: the record Vercel shows — type, name, value]`

      > **It must be `api.berelax.ae`.** Not the project's `*.vercel.app` URL,
      > not `api.berelax.io`, not an apex somewhere else. The attribution cookie
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
      survived -> build and release the API -> poll `/health/ready` -> release
      the dashboard.

      **Migrations are a release step and run exactly once, and this workflow is
      now the only place they run.** They do not run on a function's cold start.
      There used to be a second guard — `deploy.preDeployCommand` in
      `apps/api/railway.json`, which ran once per deployment whatever the replica
      count. **Vercel has no equivalent: there is no release phase and no
      pre-deploy hook, only a cold start.** So the belt is gone and this workflow
      is the braces.

      Two things keep it the only path, and both must stay true:
      `git.deploymentEnabled: false` in `apps/api/vercel.json`, and nothing in
      the API running a migration at runtime.

      If migrations ran on boot it would now be worse than it was. On a container
      it was two replicas — three during a rollback — racing `migrate deploy`
      against one database. Here it is an **unbounded** number of function
      instances doing it under a 30-second function timeout. Prisma takes a
      Postgres advisory lock, so the losers block rather than corrupt — until one
      is killed by the timeout mid-migration and leaves `_prisma_migrations` with
      a `finished_at` of NULL and `logs` set. Every subsequent deploy then refuses
      until a human resolves it by hand. At 03:20. Seven hours before opening.

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
- [ ] **Put that id in `DEFAULT_BRANCH_ID`** — Vercel → the API project →
      **Settings → Environment Variables**, Production scope — **and then
      redeploy.** There is no service to restart: the deployment already running
      keeps the old (empty) value until a new deployment replaces it. See the
      note under 2.4.
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

**The migration has already been applied by the time the new code is released.**
That ordering is deliberate — it is the only one that works when a new function
instance can cold-start at any moment — and it means the two halves roll back
differently.

| Symptom | Do | Do not |
|---|---|---|
| `/health/ready` never goes green | **Promote the previous deployment**: Vercel → the API project → **Deployments** → the last known-good one → **⋯ → Promote to Production**. The database stays where it is; these migrations are additive. | Roll the migration back. There is no `migrate down`, and hand-written DDL to undo a migration at 04:00 is how a schema becomes unrecoverable. |
| Migration failed half way | Read `_prisma_migrations`. A row with `finished_at` NULL and `logs` set is a partially-applied migration and needs a human decision, recorded. | `prisma migrate resolve --applied` to make the error go away. That marks it done when it is not. |
| Database unreachable, API otherwise healthy | Check the Supabase status page and the connection strings. `DATABASE_URL` on 6543, `DIRECT_URL` on 5432. | Point `DATABASE_URL` at 5432 "just to get it up". You will exhaust the direct connection limit and take the database down properly. |
| Data is wrong, not missing | `docs/runbooks/backup-restore.md` §4. | Fix it with `UPDATE`. `payments`, `tips` and the ledger refuse it, and that refusal is the feature. |
| It is now 09:30 and reception is arriving | Stop. Promote the last known-good deployment. Finish tonight. | Push one more fix. |

If personal data may have been exposed rather than merely unavailable, this is
also a §11.8 breach: `docs/compliance/runbooks/data-breach.md`, and the UAE Data
Office clock has already started.

---

## 8. Related

- `.github/workflows/platform-deploy.yml` — the deploy, and the secret list
- `platform/apps/api/vercel.json` — the API's build, region, function limits and
  `git.deploymentEnabled: false`. It is strict JSON and cannot hold comments, so
  its reasoning lives in the file below.
- `platform/apps/api/api/index.ts` — the file Vercel invokes, and the page of
  reasoning behind `vercel.json` and the compiled-output shim
- `platform/apps/api/src/serverless.ts` — one Nest application per instance, and
  why the cached promise is the whole trick
- `platform/apps/dashboard/vercel.json` — the dashboard build
- `docs/runbooks/netlify-to-vercel.md` — the public site's move, which owns the
  apex and `netlify.toml`
- `docs/runbooks/backup-restore.md` — the rehearsal and the real thing
- `docs/runbooks/alerts.md` — what to do when one of §5.5 fires
- `docs/runbooks/parallel-pilot.md` — the two weeks beside the paper
- `docs/compliance/runbooks/data-breach.md` — when it is a disclosure
- Spec §12.2 (window), §12.4 (hardening), §12.5 (variables), §11.7 (region),
  §11.9 (controls)

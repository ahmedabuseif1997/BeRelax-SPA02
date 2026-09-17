# BE RELAX — CRM & Booking Platform

Backend API and CRM for BE RELAX, 250 Al Meena St, Al Zahiyah, Abu Dhabi.

Built to [`docs/spa-crm-architecture-spec.md`](../docs/spa-crm-architecture-spec.md). Where this README and the specification disagree, the specification wins — and the disagreement is a bug.

**Stack:** NestJS 10 · Prisma 5 · PostgreSQL 16 · TypeScript end to end.

---

## Quickstart

```bash
# From platform/
corepack enable                     # pnpm 10 comes with Node 20+
pnpm install

docker compose up -d postgres postgres-test

cp apps/api/.env.example apps/api/.env
# Fill in JWT_SECRET at minimum:
#   openssl rand -base64 32

pnpm --filter api prisma:generate
pnpm --filter api prisma:migrate     # applies all six migrations
pnpm --filter api prisma:seed        # real menu, 8 therapists, 60 days of history

pnpm dev                             # API on http://localhost:3000
curl localhost:3000/health
```

The seed prints its login credentials at the end. They are development-only and every one of them is worthless in production, where `prisma:seed` is not run.

---

## Prerequisites

| | Version | Why |
|---|---|---|
| Node | ≥ 20.11 | Prisma 5 and NestJS 10 |
| pnpm | 10.x | Workspace protocol — `corepack enable` installs it |
| Docker | any recent | Local Postgres; or point at your own PG 15+ |
| PostgreSQL | **15+** with `btree_gist` | The exclusion constraints will not build without it |

`btree_gist` and `pgcrypto` ship with the official `postgres:16-alpine` image and are available on Supabase. Nothing else is required — notably **not** the `pg_uuidv7` extension, because `uuid_generate_v7()` is implemented in plain SQL in the first migration and runs anywhere.

---

## Layout

```
platform/
├── apps/
│   ├── api/                      NestJS backend — 79 routes
│   │   ├── prisma/
│   │   │   ├── schema.prisma     20 models, 11 enums
│   │   │   ├── migrations/       8 — 1 generated, 7 hand-written
│   │   │   └── seed.ts
│   │   └── src/
│   │       ├── auth/             JWT, bcrypt, refresh rotation, RBAC
│   │       ├── reservations/     booking + the two-step money workflow
│   │       ├── payments/         refunds, tip reversals, payouts, the ledger
│   │       ├── availability/     free windows — a hint, never a reservation
│   │       ├── booking-requests/ the unconfirmed-enquiry inbox
│   │       ├── public/           website menu, form intake, /r redirects
│   │       ├── guests/           guests and consents
│   │       ├── employees/        staff, commission, restricted legal names
│   │       ├── catalogue/        services, categories, rooms
│   │       ├── shifts/           roster, clock in and out
│   │       ├── reports/          close-out, revenue, utilisation, tips, channels
│   │       ├── compliance/       export, erasure, retention, the Art. 7 register
│   │       ├── prisma/           the client
│   │       ├── common/           audit, idempotency, error filters, context
│   │       ├── config/           env validation — the process refuses a bad one
│   │       └── health/
│   └── dashboard/                Next.js 14 CRM — the screen reception lives in
└── packages/
    └── contracts/                zod schemas, money and time helpers,
                                  shared by the API and the dashboard

assets/js/                        the public site's attribution + consent gate,
                                  shipped DORMANT — see assets/js/README.md
docs/compliance/                  privacy notice (EN + AR), processing register,
                                  breach runbook
```

### The dashboard

`pnpm --filter dashboard dev` serves it on :3001. It needs `NEXT_PUBLIC_API_URL=http://localhost:3000/v1`, and the API needs `DASHBOARD_ORIGIN=http://localhost:3001` and `COOKIE_DOMAIN=localhost` — without those the `SameSite=Strict` refresh cookie never arrives and every session dies after fifteen minutes.

Three things about it are deliberate and worth not undoing:

- **The access token lives in memory only.** Never `localStorage`. Neither does the cached grid, which is guest names and phone numbers on a shared iPad.
- **It degrades rather than lies.** If the API is unreachable it keeps showing the last grid behind a banner saying how old it is, and disables every write button. A receptionist must never believe they took a payment that was not recorded. There is no offline write queue, on purpose: a payment that *might* land later is worse than one that plainly failed.
- **The amount pad builds an integer.** There is no `parseFloat` between the keypad and the API. Check-in shows a live remainder and Confirm stays dead until it reads exactly zero.

---

## The database is the source of truth

This is the part to understand before changing anything.

**Double-booking is prevented by PostgreSQL, not by application code.** Three `btree_gist` exclusion constraints stop a therapist, a room or a guest being booked into overlapping windows. The service layer does **not** query for conflicts before inserting — that pattern has a race window and will double-book on a busy Friday when two receptionists tap *Confirm* at the same moment. It inserts, and maps SQLSTATE `23P01` to a `409`.

The availability grid in the UI is a **hint**. The constraint is the **truth**.

**`endsAt`, `blockedUntil` and `businessDay` are maintained by a trigger.** Never write them from application code; anything you send is overwritten. They cannot be computed inside the constraint, and they cannot be `GENERATED ALWAYS` columns, because `timestamptz + interval` is *stable*, not *immutable* — PostgreSQL rejects both outright. The reasoning is in [spec §4.1](../docs/spa-crm-architecture-spec.md#41-why-endsat-and-blockeduntil-are-stored-columns), and the two failure modes are verified in the script below.

**`payments`, `tips` and `therapist_payout_ledger` are append-only, enforced by triggers.** Prisma's `update` and `delete` on those models throw, on purpose. A mistake is corrected by inserting a reversing row, never by editing history. The one permitted mutation is stamping `payout_batch_id` onto an unbatched ledger entry.

**Balances are never stored.** A therapist's balance is always `SUM(amount_fils)` over the ledger. A denormalised balance drifts, and the drift is discovered during a dispute.

### Verify all of it

```bash
psql "$DIRECT_URL" -f ../docs/sql/verify-core-constraints.sql
```

Every line of output must start with `ok`. Run it after any migration that touches `reservations`, `payments` or the ledger. It also proves the two "obvious" alternatives to stored columns really are rejected, so nobody re-litigates that decision in six months.

---

## Migrations

> **`prisma db push` is banned on this project.** It does not understand the exclusion constraints, triggers, partial indexes or append-only rules, and it will silently drop them. There is no situation in which it is the right command here.

Changing the schema:

```bash
# 1. Edit prisma/schema.prisma
# 2. Generate the SQL WITHOUT applying it
pnpm --filter api exec prisma migrate dev --create-only --name add_something

# 3. Open the generated migration.sql and add any hand-written DDL
# 4. Apply
pnpm --filter api prisma:migrate

# 5. Prove the guarantees survived
psql "$DIRECT_URL" -f ../docs/sql/verify-core-constraints.sql
```

The six migrations, in order:

| Migration | Contents |
|---|---|
| `00000000000000_init_extensions` | `btree_gist`, `pgcrypto`, `uuid_generate_v7()`, `business_day()`, the reference sequence |
| `…_init_schema` | 20 tables — Prisma-generated |
| `…_reservation_exclusion` | The three exclusion constraints, check constraints, the partial unique email index |
| `…_reservation_triggers` | Derived columns, the status state machine |
| `…_append_only` | Immutability guards on payments, tips, ledger and audit log |
| `…_retention` | `prune_attribution()` — 90-day attribution retention |
| `…_payment_created_at` | Splits the business timestamp from the system one |

The last one is worth reading before you write another migration. `payments.collected_at` is when money changed hands — reception supplies it, and a check-in may legitimately back-date it. `created_at` is when the row was written. Auditing against the first made every back-dated check-in look unaudited.

Back-filling that column also ran straight into the append-only trigger, which refused it. That is the guard working: adding a column is DDL and passes, but filling it is an `UPDATE`. The migration suspends the trigger for exactly one statement and restores it. Wanting to suspend it for more than back-filling a new column is the signal to stop and write a reversing entry instead.

The first must sort before the schema migration, because the schema's `uuid_generate_v7()` defaults depend on it. That is why its prefix is all zeroes.

---

## Conventions that are not negotiable

**Money is an integer number of fils.** 1 AED = 100 fils; `250.00 AED` is `25000`. Every column carries an `_fils` suffix so a mistake is visible in review. There are no floats and no `Decimal` round-trips. Formatting happens once, at the edge, via `formatAed()`.

**Time is UTC in the database, Dubai in the interface.** Every timestamp is `timestamptz`.

**The business day is not the calendar day.** The spa opens 11:00 and closes 02:00 *the next morning*, so a booking at 01:30 on Tuesday belongs to **Monday's** trading day, revenue and shift. Group reports by `business_day(...)`, never by `date_trunc('day', ...)`. The TypeScript `businessDay()` in `@berelax/contracts` mirrors the SQL function exactly, and a test asserts they agree.

**`branchId` comes from the access token, never from a request body.** With one branch this is invisible; the day a second branch opens it is the difference between a config change and a security incident. A Prisma client extension enforces it as a safety net, but service methods still pass it explicitly.

**Money endpoints require an `Idempotency-Key` header.** Reception works on an iPad over patchy Wi-Fi at 01:00; a timeout plus a second tap must not charge the guest twice.

---

## The two-step financial workflow

Base payment is taken **before** the treatment. The tip is decided **after**. Those two events are separated by 60–90 minutes and often by a shift change at reception, so they are two endpoints and two transactions — not one "settle the bill" screen.

```
POST /v1/reservations/:id/check-in     SCHEDULED   -> IN_PROGRESS
  arrival time + base payment (split across cash/card is supported;
  the sum must reconcile exactly to baseCostFils)

POST /v1/reservations/:id/checkout     IN_PROGRESS -> COMPLETED
  completion time + optional tip
```

A tip is two different things wearing the same word:

| | `DIRECT_CASH` | `COLLECTED_BY_BUSINESS` |
|---|---|---|
| Who holds the money afterwards | the therapist | the business |
| `payments` row | ✗ | ✓ |
| `tips` row | ✓ | ✓ |
| Ledger liability | **✗** | ✓ |
| Counts toward "earned" | ✓ | ✓ |
| Counts toward "we owe them" | ✗ | ✓ |

`DIRECT_CASH` deliberately creates **no ledger entry**: the business never held that money, so it owes nothing. Writing a matching accrual and settlement to "keep it symmetrical" would be an accounting fiction, and it makes the ledger a number you interpret rather than trust. Conflating the two modes is how spas pay a tip twice — once in cash on the night, once again in the monthly payout.

A database check constraint enforces the distinction, so a bug in the checkout handler cannot corrupt what the ledger means.

---

## Testing

```bash
pnpm test                # unit
pnpm test:e2e            # needs the test database on :5433
pnpm verify              # lint + typecheck + build + unit + e2e — what CI runs
```

The suite that matters is `test/booking-concurrency.e2e-spec.ts`. It fires 25 simultaneous bookings at one therapist and one slot and asserts **exactly one** succeeds. It must run against a real PostgreSQL — a mocked database has no exclusion constraints and would pass while proving nothing.

`test/financial-invariants.e2e-spec.ts` asserts the seven invariants from spec §13.3. Invariant 6 checks for overlapping bookings with an independent query rather than trusting the constraint, so a migration that accidentally drops one fails CI loudly instead of quietly.

Coverage expectations: **100% of branches** in the money and auth paths, 80% elsewhere.

---

## Deployment

| Component | Host | Notes |
|---|---|---|
| API | Railway or Render | A long-lived process. Serverless fights connection pooling and gives request-scoped interceptors nowhere to live. |
| Database | Supabase | Pick the region deliberately and write down why — see spec §11.7. |
| Dashboard | Vercel | Phase 2. |
| Public site | Netlify | Already live, unchanged by any of this. |

Production checklist:

```bash
pnpm --filter api prisma:deploy     # migrate deploy — never `migrate dev`
```

- `JWT_SECRET` and `ERASURE_SALT` from the platform secret manager, never a file.
- **`ERASURE_SALT` is never rotated.** Rotating it orphans every already-erased guest record.
- Schedule the retention job: `SELECT cron.schedule('prune-attribution', '30 3 * * *', $$SELECT prune_attribution(90)$$);` — 03:30 UTC is 07:30 Dubai, after close and before the morning shift.
- Deploy between 03:00 and 09:00 Dubai. Never during trading.
- Rehearse a backup restore before go-live, and quarterly after. An untested backup is a hope.

The API must be reachable at **`api.berelax.ae`** — a subdomain of the public site. The attribution cookie mirror is a first-party cookie, and on any other domain Safari blocks it outright, which silently costs you most of your iOS attribution.

---

## Status against the delivery plan

| Phase | State |
|---|---|
| **0 — Foundations** | Done. Schema, eight migrations, seed, contracts package, concurrency suite. |
| **1 — Auth** | Done. Login, refresh rotation with reuse detection, lockout, guards, RBAC, user management. |
| **2 — Booking core** | Done. Reservations (including reschedule), availability, the enquiry inbox and conversion, guests, employees, catalogue, shifts, and the dashboard. |
| **3 — The money** | Done. Both tip modes, refunds, adjustments, tip reversals, payout batches, the ledger, the earnings split, the audit query. |
| **4 — Attribution** | Server done. Client written and **shipped dormant** — one line turns it on, and it needs the `.ae` domain first. See below. |
| **5 — Reporting** | Done. Daily close-out, revenue, therapist utilisation, tips, channel ROI — and the dashboard pages for all five. |
| **6 — Compliance** | Code done: export, erasure, consent withdrawal, retention, the derived Art. 7 register. Documents drafted. **Not signed off** — see below. |
| **7 — Pilot** | Not started. Two weeks in parallel with paper, reconciled nightly. |

### Before real guest data goes anywhere near this

The code is ready; the business is not, and these are not engineering tasks:

1. **Counsel review.** `docs/compliance/` carries ten open questions, led by the status of the PDPL's Executive Regulations, the cross-border transfer safeguard, and whether Federal Law 2/2019 reaches a non-clinical spa. None is answered in the documents, because none should be guessed.
2. **63 blanks.** The privacy notice and register are full of `[TO BE COMPLETED]` — DPO, breach contact, hosting regions, DPA statuses. The breach runbook needs a named person with a mobile, not a shared inbox.
3. **One privacy-notice version string** in three places: the notice, `BERELAX_PRIVACY_VERSION` in the page, and the `policyVersion` reception records. A consent filed against a version naming no document proves nothing.
4. **`privacy.html` does not exist.** The consent banner links to it.
5. **A rehearsed backup restore.** An untested backup is a hope.

### The attribution client is deliberately switched off

`assets/js/attribution.js` and `assets/js/consent.js` are written, tested and committed — and `index.html` does not reference them. Nothing renders, nothing is stored and nothing is sent until:

```js
window.BERELAX_ATTRIBUTION_API = "https://api.berelax.ae/v1";
```

is uncommented in the snippet in `assets/js/README.md`. That subdomain does not exist yet, and the cookie mirror only works from a subdomain of the site's own domain (§10.5), so enabling it earlier would beacon into nothing and quietly lose iOS attribution anyway.



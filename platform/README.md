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
│   └── api/                      NestJS backend
│       ├── prisma/
│       │   ├── schema.prisma     20 models, 11 enums
│       │   ├── migrations/       6 migrations — 1 generated, 5 hand-written
│       │   └── seed.ts
│       └── src/
│           ├── auth/             JWT, bcrypt, refresh rotation, RBAC
│           ├── reservations/     booking + the two-step money workflow
│           ├── prisma/           client, branch-scope extension
│           ├── common/           audit, idempotency, error filters, context
│           ├── config/           env validation — the process refuses a bad one
│           └── health/
└── packages/
    └── contracts/                zod schemas, money and time helpers,
                                  shared by the API and (later) the dashboard
```

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
| **0 — Foundations** | Schema, all six migrations, seed, contracts package, concurrency suite |
| **1 — Auth** | Login, refresh rotation with reuse detection, lockout, guards, RBAC, user management |
| **2 — Booking core** | Reservations, check-in, checkout, cancel, no-show. Guests, employees, services, rooms, shifts and the dashboard are next. |
| **3 — The money** | Payments, both tip modes, ledger accrual. Reversals, payout batches and the invariant suite are next. |
| **4–7** | Attribution, reporting, compliance endpoints, pilot — not started |

Nothing here has touched real guest data, and nothing should until Phase 6 (compliance endpoints, retention jobs, privacy notice, rehearsed restore) is complete.

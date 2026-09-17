# Record of Processing Activities

**BE RELAX Massage Center and Spa — CRM & Booking Platform**

| | |
|---|---|
| **Version** | `1.0-draft` |
| **Date** | 17 September 2026 |
| **Maintained under** | UAE Federal Decree-Law No. 45 of 2021 (PDPL), Art. 7; architecture spec [§11.7 item 4](../spa-crm-architecture-spec.md) |
| **Owner** | `[TO BE COMPLETED: name of the person accountable for this register]` |
| **Review cadence** | Quarterly, and on any schema migration that adds or removes a column holding personal data |
| **Next review due** | `[TO BE COMPLETED: date]` |

> **This document is not legal advice.** It is an engineering record of what the
> system actually does, derived from `platform/apps/api/prisma/schema.prisma` and
> the service code under `platform/apps/api/src/`. It must be reviewed by UAE
> counsel before launch — see [Open questions for counsel](#open-questions-for-counsel).

---

## 1. Controller

| | |
|---|---|
| **Controller** | BE RELAX Massage Center and Spa |
| **Address** | 250 Al Meena Street, Tower Block A/B, M-Floor, Al Zahiyah (Al Mina), E14, Abu Dhabi, UAE |
| **Contact** | 052 510 8633 (mobile / WhatsApp) · 056 342 9399 (mobile) · 02 557 6533 (landline) |
| **Hours** | Daily 11:00–02:00 (`Asia/Dubai`) |
| **Trade licence** | `[TO BE COMPLETED]` |
| **Regulator** | UAE Data Office (federal). The spa is onshore in Abu Dhabi, not in a financial free zone, so the DIFC and ADGM regimes do not apply. |
| **DPO appointed?** | `[TO BE COMPLETED: no DPO currently appointed. Counsel must confirm whether one is required for this processing profile.]` |
| **Establishment** | Single branch. The data model carries `branch_id` on every table and every query is branch-scoped, but there is one branch in practice. |

---

## 2. Processing activities

Each activity below maps to real tables. Column names are given as they exist in
the database so an auditor can verify the claim rather than take it on trust.

---

### A1 — Website enquiry handling

| | |
|---|---|
| **Purpose** | Receive an enquiry from berelax.ae and call the person back to turn it into a booking |
| **Data subjects** | Prospective guests |
| **Tables** | `booking_requests` |
| **Data** | `guest_name`, `guest_phone` (E.164), `guest_email` (optional), `requested_service_id`, `requested_at`, `message` (free text, ≤1000 chars), `status`, `source_channel`, `attribution_id`, `handled_by_user_id`, `handled_at`, `created_at` |
| **Lawful basis** | Steps taken at the data subject's request prior to entering a contract |
| **Collected from** | The data subject, directly, via `POST /v1/public/booking-requests` |
| **Recipients** | Reception, managers and the owner (`RECEPTIONIST+`). Not therapists. |
| **Processors** | Supabase (storage), Vercel (API compute), Netlify (serves the form) |
| **Storage** | Supabase PostgreSQL, `[TO BE COMPLETED: region]` |
| **Transfer safeguard** | See [§4 Cross-border transfer](#4-cross-border-transfer) |
| **Retention** | No **time-based** retention rule exists for `booking_requests`. **This is a gap** — see [G4](#5-known-gaps-between-the-specification-and-the-code). Converted enquiries inherit the reservation's 5-year life; declined and spam enquiries are currently kept indefinitely. |
| **On erasure** | Enquiries are matched on `guest_id` **or** on a bare `guest_phone` (so an enquiry that was never converted is still caught) and rewritten: `guest_name` → `Erased guest`, `guest_phone` → the salted token, `guest_email` → `NULL`, `message` → `NULL`. The free text goes with the person. |
| **Security** | Rate limited 10/min and 60/hour per IP; 128 KB body cap; the response is a bare reference with no database ID and no "welcome back" (the endpoint is deliberately not a phone-number oracle); no guest record is created, so a spam run cannot populate `guests` |
| **⚠ Risk** | `message` is **not screened for medical content**, and the live site's placeholder text reads *"Injuries, pressure preference, preferred therapist…"* — it actively solicits health data. See [G1](#5-known-gaps-between-the-specification-and-the-code). |

---

### A2 — Guest records and booking management

| | |
|---|---|
| **Purpose** | Hold a booking, run the appointment, recognise a returning guest, honour preferences |
| **Data subjects** | Guests |
| **Tables** | `guests`, `reservations` |
| **Data — `guests`** | `full_name`, `phone` (E.164, unique per branch), `email` (nullable), `notes` (preferences only, ≤500 chars by CHECK constraint), `is_blocked`, `anonymised_at`, `created_at`, `updated_at`, `deleted_at` |
| **Data — `reservations`** | `ref` (`BR-2026-0417`), `guest_id`, `employee_id`, `room_id`, `service_id`, `starts_at`, `duration_minutes`, `ends_at`, `blocked_until`, `business_day`, `status`, `base_cost_fils`, `source_channel`, `attribution_id`, `actual_arrival_at`, `completed_at`, `cancelled_at`, `cancellation_reason`, `notes`, `created_by_user_id` |
| **Lawful basis** | Performance of a contract |
| **Collected from** | The data subject, directly (at the desk, by phone, by WhatsApp, or converted from A1) |
| **Recipients** | `RECEPTIONIST+` for the guest book. Therapists see **their own** bookings only, and cannot read the guest list. |
| **Processors** | Supabase, Vercel (API compute, and the manager dashboard renders this data in the browser) |
| **Storage** | Supabase PostgreSQL, `[TO BE COMPLETED: region]` |
| **Retention** | Guest identity: **3 years** after last visit, then anonymised by `RetentionService` (`GUEST_RETENTION_YEARS`, read from configuration and never from a request body — "an endpoint that lets a caller shorten them is an endpoint that makes the register a lie"). Reservations: **5 years**, with the guest fields already severed. Triggered by `POST /v1/compliance/retention/run` (`OWNER`), which supports `dryRun` and a `limit`, and reports candidates, anonymised, remaining and failures. |
| **Erasure** | Anonymisation, not deletion: `full_name` → `Erased guest`, `email` → `NULL`, `notes` → `NULL`, `phone` → a salted SHA-256 token (uniqueness-checked against the branch, so the `(branch_id, phone)` index cannot collide), plus `anonymised_at` and `deleted_at` stamped so the shell leaves reception's guest book entirely. `reservations.notes` is cleared as well — free text is neither an amount nor a date, so the five-year obligation does not reach it, and free text is exactly where a person hides. `ERASURE_SALT` must never be rotated — rotation orphans every already-erased record. |
| **One code path** | The retention job does **not** write its own anonymisation. It calls the same `GuestErasureService.erase()` the rights endpoint calls, so §11.4 and §11.6 cannot drift into two different definitions of "erased". |
| **Security** | Soft delete only (`deleted_at`); branch scoping is in the `WHERE` clause, not a check afterwards, so a guest from another branch is indistinguishable from one that never existed; `notes` rejected at the API if it matches any of nine medical patterns (`pregnan`, `diabet`, `hypertens`, `blood pressure`, `medication`, `surger`, `epilep`, `asthma`, `heart condition`) |
| **⚠ Note** | `reservations.notes` is **not** screened for medical content, only `guests.notes` is. |

---

### A3 — Payments, tips and the therapist payout ledger

| | |
|---|---|
| **Purpose** | Record money taken, money owed to therapists, and the trail behind both; meet tax and accounting record-keeping obligations |
| **Data subjects** | Guests (as payers), therapists (as payees), staff (as actors) |
| **Tables** | `payments`, `tips`, `therapist_payout_ledger`, `payout_batches` |
| **Data — `payments`** | `kind` (BASE/TIP/REFUND/ADJUSTMENT), `method` (CASH/CARD/BANK_TRANSFER/VOUCHER/COMPLIMENTARY), `amount_fils` (signed integer), `business_day`, `collected_by_user_id`, `collected_at` (supplied by reception, may be back-dated), `created_at` (system time, never back-dated), `external_ref` (card terminal slip number), `reverses_payment_id`, `note`, `idempotency_key` |
| **Data — `tips`** | `type` (DIRECT_CASH / COLLECTED_BY_BUSINESS), `amount_fils`, `method`, `payment_id`, `employee_id`, `business_day`, `recorded_by_user_id`, `recorded_at`, `reversed_by_tip_id`, `note` |
| **Data — ledger / batches** | `entry_type`, `amount_fils`, `business_day`, `created_by_user_id`; batches add `period_start`/`period_end`, `total_fils`, `method`, `paid_at`, `approved_by_user_id`, `acknowledged_at` |
| **Lawful basis** | Legal obligation (tax and accounting) **and** performance of a contract. For therapist payouts: employment contract and legal obligation. |
| **Recipients** | `MANAGER+` for any total. **Reception can take money all evening and never see a total** — that separation is deliberate. Therapists see their own earnings only. |
| **Processors** | Supabase, Vercel (API and dashboard) |
| **Retention** | **5 years minimum.** Never deleted while a dispute is open. |
| **Survives erasure?** | **Yes.** This is the one place where a guest's erasure request does not remove the record. The transaction is retained; the person is severed from it. The privacy notice states this in plain words rather than citing a statute. |
| **Security** | All three tables are **append-only, enforced by database triggers** (`forbid_mutation()`, `ledger_guard()`) — `UPDATE` and `DELETE` raise `insufficient_privilege`. The single permitted mutation is attaching a `payout_batch_id` to a ledger row that had none, with every other column provably unchanged in the same statement. Corrections are reversing rows, never edits. Balances are never stored — always `SUM(amount_fils)`. |
| **No card data** | The system records that a card payment happened and the slip number. It never sees a PAN, and there is no payment gateway integration. PCI-DSS scope is deliberately avoided. |

---

### A4 — Consent records

| | |
|---|---|
| **Purpose** | Prove that a guest consented, to what, when, against which version of the privacy notice, and when they withdrew |
| **Data subjects** | Guests |
| **Tables** | `guest_consents` |
| **Data** | `guest_id`, `type` (`DATA_PROCESSING`, `MARKETING`, **`PHOTO`**), `granted`, `granted_at`, `withdrawn_at`, `source` (free text, e.g. "front desk"), `policy_version`, `ip_address` |
| **Lawful basis** | Legal obligation — the ability to demonstrate consent is itself required. The record therefore survives the withdrawal of the consent it records. |
| **Recipients** | `RECEPTIONIST+` (reception captures consent at the desk) |
| **Endpoints** | `POST /v1/guests/:id/consents` (record) · `GET /v1/guests/:id/consents` (the ledger: what stands today plus the full history) · `POST /v1/guests/:id/consents/:type/withdraw` (withdraw) — **all three at `RECEPTIONIST+`** |
| **Withdrawal** | PDPL Art. 6: as easy to withdraw as to give. Granting is one authenticated POST, so withdrawal is one authenticated POST at the same role — no manager escalation, no form, no reason field. `updateMany` stamps `withdrawn_at` on **every** standing grant of that type, because a guest can hold two (one taken at the desk, one from the website) and withdrawing only one is how someone who asked to be left alone keeps receiving messages. |
| **Processors** | Supabase, Vercel (API and dashboard) |
| **Retention** | Until withdrawal + **3 years**, **except on erasure** — see below |
| **Security** | `ip_address` is taken from the request context, **never from the request body** — an address the caller nominates is not evidence of anything. A refusal and a withdrawal are the same row shape with `granted = false` and `withdrawn_at` stamped. Current state is **derived on every read**, never cached on `guests`: a cached consent flag is a second source of truth, and the copy that drifts is the one that messages somebody who said no. |
| **⚠ Deliberate divergence** | An **erasure request deletes the consent rows outright**, rather than keeping them for three years. The reasoning in the code: the three-year rule exists so the business can defend a marketing complaint, but an erasure request is the guest asking for the relationship itself to end — and a consent row holds their IP address. This is a considered trade-off between two PDPL obligations, not an oversight. **Counsel should confirm it.** |
| **⚠ Note** | `PHOTO` consent exists in the enum and the API but is **not mentioned in spec §11.2's lawful-basis table**. It is covered in the privacy notice on a consent basis. See [G2](#5-known-gaps-between-the-specification-and-the-code). |

---

### A5 — Marketing to guests

| | |
|---|---|
| **Status** | **Not operating.** There is no marketing system, no campaign sender and no integration. The `MARKETING` consent type exists so that consent can be captured lawfully before any such system is built. |
| **Purpose** (when built) | Send offers and reminders to guests who opted in |
| **Lawful basis** | **Consent** — separate, opt-in, withdrawable. Never bundled into the booking form's submit action. |
| **Data** | Would draw on `guests.phone` / `guests.email` |
| **The gate a sender must read** | `GET /v1/guests/:id/consents` → `current.MARKETING.granted`. That single boolean is derived from the latest `MARKETING` row and is false unless a grant stands unwithdrawn. Never-asked and refused both read false — which is correct, because they have the same effect. **No sender may query `guests` directly.** |
| **Before this activity starts** | This register must be updated, the processor list extended with whatever sender is chosen, and the privacy notice re-versioned. |

---

### A6 — Website attribution and analytics

| | |
|---|---|
| **Purpose** | Understand which channels and campaigns bring guests to the spa, and what they are worth |
| **Data subjects** | Website visitors |
| **Tables** | `attribution_snapshots` |
| **Data** | `visitor_id` (UUID v4, generated client-side), `first_touch` / `last_touch` / `touches` (JSON: `source`, `medium`, `campaign`, `term`, `content`, `gclid`, `fbclid`, `referrer`, `landing`), `touch_count`, `first_seen_at`, `last_seen_at`, `landing_path`, `captured_at`, `pruned_at` |
| **Lawful basis** | **Consent.** A `visitor_id` is a unique identifier tied to behaviour and is personal data even with no name attached. |
| **Consent mechanism** | A banner on berelax.ae. `attribution.js` must not load before consent is granted. Accept and Decline are equally prominent; declining is one click; the choice is re-openable from a persistent footer link; the site works fully when consent is declined. The booking form and WhatsApp buttons are never gated. |
| **Collected from** | The data subject's browser, via `POST /v1/public/attribution/touch` (`navigator.sendBeacon`) |
| **Recipients** | `MANAGER+` only (channel ROI reports) |
| **Processors** | Supabase, Vercel (API), Netlify |
| **Retention** | **90 days**, then `prune_attribution()` overwrites `visitor_id` with the nil UUID, empties `touches`, reduces `first_touch`/`last_touch` to `{source, medium, campaign}` and nulls `landing_path`. Channel aggregates survive; the person does not. |
| **Severed on erasure** | Yes — immediately, even inside the 90 days |
| **Data minimisation in force** | `landing_path` stores the **path only**, never the full URL with its query string, because a query string is where somebody's email address ends up. The `brx_vid` cookie is `httpOnly`, `secure`, `sameSite=lax`, 90-day `maxAge` — the script cannot read it back. |
| **Third-party analytics** | **None.** No Google Analytics, no Meta pixel, no third-party tags. Verified: `index.html` contains no `gtag`, `fbq`, `googletagmanager` or equivalent. The only measurement is first-party. |
| **⚠ Status** | The consent banner is **not yet on the live site**. Currently no attribution script runs at all, so nothing is collected — but the banner must ship before the CRM goes live. See [G5](#5-known-gaps-between-the-specification-and-the-code). |

---

### A7 — Outbound click logging (WhatsApp and call buttons)

| | |
|---|---|
| **Purpose** | Count how many people leave the site for WhatsApp or a phone call, from which page and which campaign |
| **Data subjects** | Website visitors |
| **Tables** | `outbound_clicks` |
| **Data** | `visitor_id` (nullable; only if the `brx_vid` cookie is present and is a valid UUID), `target` (`whatsapp`/`call`), `context`, `landing_path`, `utm_source`, `utm_medium`, `utm_campaign`, `gclid`, `fbclid`, `referrer`, `user_agent` (truncated to 300 chars), `created_at` |
| **No IP address** | There is **no `ip_address` column** on this table and none is written. Verified against the schema and `outbound-clicks.service.ts`. |
| **Lawful basis** | **Consent** where a `visitor_id` is present. Where the visitor declined and no cookie exists, the row carries no identifier. |
| **Recipients** | `MANAGER+` |
| **Processors** | Supabase, Vercel (API) |
| **Retention** | **90 days**, then deleted outright by `prune_attribution()` |
| **Limit, stated honestly** | This logs the click, not the conversation. Nothing that happens inside WhatsApp is visible to this system and it never will be. |

---

### A8 — Staff accounts and authentication

| | |
|---|---|
| **Purpose** | Let staff sign in; attribute every money action to a named person; revoke a session when a phone is lost |
| **Data subjects** | Employees with a login (owner, managers, reception, therapists) |
| **Tables** | `users`, `refresh_tokens` |
| **Data — `users`** | `email` (lowercase, unique among live users), `password_hash` (bcrypt, cost 12), `full_name`, `role`, `is_active`, `must_change_password`, `last_login_at`, `failed_login_count`, `locked_until`, `password_changed_at`, `employee_id` |
| **Data — `refresh_tokens`** | `user_id`, `family_id`, `token_hash` (SHA-256 — the token itself is never stored), `expires_at`, `revoked_at`, `replaced_by_id`, **`user_agent`**, **`ip_address`**, `created_at` |
| **Lawful basis** | Employment contract; legitimate operation and security of the business |
| **Recipients** | `OWNER` creates, disables and resets. `MANAGER` may revoke sessions but not create accounts. |
| **Processors** | Supabase, Vercel (API and dashboard) |
| **Retention** | Revoked and expired refresh tokens deleted **30 days** after expiry by `prune_attribution()`. User rows are soft-deleted (`deleted_at`), which frees the email address for reuse. |
| **Security** | bcrypt cost 12 with re-hash on login if the stored cost has drifted; login throttled 5 per 15 min per IP **and** per email; account lockout via `failed_login_count` / `locked_until`; refresh-token rotation with **reuse detection** — presenting a spent token revokes the entire token family and writes `AUTH_REFRESH_REUSE_DETECTED` to the audit log |

---

### A9 — Employee records and shift management

| | |
|---|---|
| **Purpose** | Roster therapists, clock them in and out, calculate commission and payouts |
| **Data subjects** | Employees |
| **Tables** | `employees`, `shifts` |
| **Data — `employees`** | `display_name` (shown to guests), `legal_name` (HR only, restricted), `phone`, `status`, `commission_bps`, `hired_on`, `photo_url`, `deleted_at` |
| **Data — `shifts`** | `business_day`, `planned_start`, `planned_end`, `clock_in_at`, `clock_out_at`, `status`, `note` |
| **Lawful basis** | Employment contract and legal obligation |
| **Recipients** | `legal_name` is readable by `OWNER`, `MANAGER`, or the therapist themselves — **not** by reception. Reception can read the shift roster (it carries no money and is needed to clock people in) but not earnings. |
| **Processors** | Supabase, Vercel (API and dashboard) |
| **Retention** | `[TO BE COMPLETED: UAE labour law record-keeping period for employee records — counsel to confirm. No retention rule for employee data exists in code.]` |
| **⚠ Note** | `photo_url` holds a staff photograph. Where that image is hosted is not determined by the schema and must be recorded here once chosen: `[TO BE COMPLETED: image hosting location]` |

---

### A10 — Financial audit log

| | |
|---|---|
| **Purpose** | Answer "who did this, when, from where" for every action that touches money; provide a trustworthy record during a breach investigation |
| **Data subjects** | Staff (as actors). Guests appear only as opaque entity IDs. |
| **Tables** | `financial_audit_log` |
| **Data** | `actor_user_id`, `actor_role`, `action`, `entity_type`, `entity_id`, `before_state` / `after_state` (JSON), `amount_fils`, **`ip_address`**, **`user_agent`**, `request_id`, `created_at` |
| **Actions recorded** | Reservation create/reschedule/check-in/checkout/cancel/no-show; payment refund and adjustment; tip reversal; payout created and acknowledged; service price change; employee commission change; user created/role changed/disabled; sessions revoked; password reset; login succeeded/failed; refresh reuse detected; guest data exported; guest erased |
| **Lawful basis** | Legal obligation and legitimate interest in the integrity of financial records |
| **Recipients** | `MANAGER+` only |
| **Processors** | Supabase, Vercel (API) |
| **Retention** | **7 years**, then cold storage. No deletion rule exists in code — appropriate, since the table is immutable. |
| **Security** | **Append-only, database-enforced.** `UPDATE` and `DELETE` triggers raise `insufficient_privilege`. Audit rows are written inside the same transaction as the business write they record, so a rolled-back transaction takes its audit row with it. |
| **PII minimisation** | `pickAuditFields()` strips `fullName`, `guestName`, `phone`, `guestPhone`, `email`, `guestEmail`, `legalName`, `notes`, `passwordHash` and `tokenHash` before a row is written. The audit log holds IDs, amounts, statuses and timestamps — **not a second copy of the guest database.** |

---

### A11 — Idempotency records (operational resilience)

| | |
|---|---|
| **Purpose** | Stop a receptionist on patchy Wi-Fi at 01:00 charging a guest twice when a request times out and they tap Confirm again |
| **Data subjects** | Guests (indirectly), staff |
| **Tables** | `idempotency_records` |
| **Data** | `key`, `user_id`, `endpoint`, `request_hash`, `status_code`, **`response_body` (JSON)**, `created_at`, `expires_at` |
| **⚠ Why this is in the register** | `response_body` is a **verbatim copy of an API response**. For a money endpoint that response can contain guest-identifying fields. This table is therefore a short-lived secondary store of personal data, and it is **not listed in spec §11.6's retention table**. See [G6](#5-known-gaps-between-the-specification-and-the-code). |
| **Lawful basis** | Performance of a contract (correct billing) |
| **Recipients** | None — the table is internal and has no read endpoint |
| **Processors** | Supabase, Vercel (API) |
| **Retention** | `IDEMPOTENCY_TTL_HOURS` (default **24 hours**), then deleted by `prune_attribution()` |

---

### A12 — Application logs and error reporting

| | |
|---|---|
| **Purpose** | Diagnose faults |
| **Data subjects** | Website visitors, guests, staff |
| **Data** | Request logs including `request_id`, route, and — behind the proxy — the client IP taken from `x-forwarded-for` |
| **Lawful basis** | Legitimate interest in operating and securing the service |
| **Processors** | Vercel (API and dashboard logs), Netlify (static site access logs), Cloudflare (if placed in front — see [§3](#3-processors)) |
| **Retention** | **90 days** per the specification. In practice retention is whatever each platform's log retention setting is: `[TO BE COMPLETED: confirm and configure the log retention window on Vercel and Netlify]` |
| **Status** | §12.3 calls for **pino** structured logs with a PII-redacting serialiser and **Sentry** with a PII-stripping `beforeSend`. **Pino is implemented** (`src/common/logger.ts`, wired through `nestjs-pino`), redacting the same field list the audit log uses (`src/common/pii.ts`) — verified by grepping 272 emitted lines for guest names, phone numbers, emails, tokens, cookies and hashes, none of which appear. **Sentry is not**: `src/common/sentry.ts` is an adapter carrying the real `beforeSend`, but `@sentry/node` is not installed, so no error reaches Sentry and `initSentry` warns at boot when `SENTRY_DSN` is set. See [G7](#5-known-gaps-between-the-specification-and-the-code). |

---

### A13 — Data subject rights administration

| | |
|---|---|
| **Purpose** | Answer access, portability and erasure requests; run the retention schedule; produce the machine-readable record of processing |
| **Data subjects** | Guests (as requesters), staff (as actors) |
| **Endpoints** | `GET /v1/guests/:id/export` (`MANAGER+`) · `POST /v1/guests/:id/erase` (`MANAGER+`) · `POST /v1/compliance/retention/run` (`OWNER`) · `GET /v1/compliance/processing-register` (`OWNER`) |
| **Lawful basis** | Legal obligation — these exist because the PDPL requires them |
| **Why `MANAGER+` and `OWNER`, not reception** | Reception takes bookings; a manager answers a legal request. Retention anonymises guests in bulk and the register is the document handed to a regulator — neither is a shift decision. |
| **The export bundle** | One JSON document covering the guest record, consents, reservations, payments, tips, booking requests and attribution snapshots, with per-category counts, read inside a **single transaction** so a booking taken mid-export cannot land in `reservations` and miss `payments`. Amounts are the stored integer fils and timestamps are ISO-8601 with offsets — nothing is summarised. A partial export is treated as a failed request. |
| **What the export says it omits** | The bundle carries an explicit `notIncluded` list rather than silently dropping things: health or medical information (none exists), the financial audit log (it records money changes and carries no guest identity), and staff rosters, therapist earnings and payout batches (employee data, not guest data). |
| **The erasure receipt** | `POST /erase` returns **200 with an itemised account**, not a bare 204: which identity fields were cleared, the phone token, how many consents were deleted, attribution snapshots severed, outbound clicks deleted, booking requests anonymised, reservation notes cleared, and **how many financial records were deliberately retained**. The manager answering the guest can show them what went and what stayed. |
| **Audit** | Both write to `financial_audit_log` — `GUEST_DATA_EXPORTED` and `GUEST_ERASED` — with the actor, role, IP, user agent and request ID. The erasure audit row records *that* the guest had an email and notes, never their values: the audit log is not the place to keep a copy of the thing we were asked to destroy. |
| **Retention of these records** | The audit rows live 7 years with the rest of the audit log |

---

### A14 — Rate limiting and brute-force protection

| | |
|---|---|
| **Purpose** | Refuse a caller who is working through passwords, or flooding the public enquiry form, before they get anywhere |
| **Data subjects** | Website visitors, prospective guests, staff |
| **Tables** | `rate_limit_counters` |
| **Data** | `key`, `throttler`, `hits`, `window_ends_at`, `blocked_until` — a count and two timestamps, and nothing else |
| **⚠ Why this is in the register** | `key` is a SHA-256 of the route and the caller: `user:<uuid>` when signed in, `ip:<address>` otherwise. It is declared as personal data rather than waved through as "just a hash" — an unsalted SHA-256 of an IPv4 address is reversed by enumerating four billion inputs, which is minutes of work. Pseudonymised, not anonymous. No name, phone number, request body or plaintext route is stored. |
| **Lawful basis** | Legitimate interest in operating and securing the service |
| **Recipients** | None — internal, no read endpoint |
| **Processors** | Supabase, Vercel (API) |
| **Retention** | The rate-limit window itself — a minute, an hour, fifteen minutes — plus up to an hour of grace before a bounded sweep deletes the row. Nothing here survives the night. |
| **Why a table and not Redis** | The counter has to be shared across API instances or it is not a limit at all (see [G11](#5-known-gaps-between-the-specification-and-the-code)). Adding Redis would have meant another processor, another DPA and another row in [§3](#3-processors). This system has exactly one data store and that is worth keeping. |

---

## 3. Processors

| Processor | Role | What it can see | Location | DPA |
|---|---|---|---|---|
| **Supabase** | Managed PostgreSQL — the primary data store | **Everything.** Every table in this register. Supabase staff have the access their platform terms describe. | AWS, `[TO BE COMPLETED: region — Frankfurt `eu-central-1` intended]` | `[TO BE COMPLETED: signed DPA on file — date and countersignature]` |
| **Vercel** | Hosts **both** the NestJS API (`apps/api`, serverless functions — moved here from Railway) and the manager dashboard (`apps/dashboard`, Next.js). Two projects, one processor and one DPA. | All data in transit through the API, plus environment secrets (`JWT_SECRET`, `ERASURE_SALT`, database credentials) and application logs containing IP addresses; and whatever a signed-in staff member's browser requests — guest records, bookings, payments, reports | Both projects pin `regions: ["fra1"]` in `vercel.json` and must match the Supabase region. `[TO BE COMPLETED: confirm the deployed region of each project]` | `[TO BE COMPLETED]` |
| **Netlify** | Hosts the public static site (`index.html` and assets) — configured in `netlify.toml` | **No guest database access.** The site is static; the publish directory is assembled to exclude `platform/` and `docs/`. Netlify sees visitor request logs (IP, user agent, referrer) for the public site. | `[TO BE COMPLETED: Netlify edge — global]` | `[TO BE COMPLETED]` |
| **Cloudflare** | Intended for Turnstile (bot protection on the public booking form) and/or CDN/DNS | Would see the visitor's IP and the Turnstile challenge on form submission | Global edge | `[TO BE COMPLETED]` |
| **⚠ Cloudflare status** | **Not currently integrated.** `publicBookingRequestSchema` accepts a `turnstileToken` field, but nothing in the API verifies it — the value is accepted and discarded. Cloudflare is therefore **not yet a processor in fact.** Either wire it up or remove the field and the claim. | | | |

> **Every processor listed here must have a signed Data Processing Addendum on
> file before real guest data enters the system,** with countersigned copies kept
> in the business records. None of the blanks above may be left unfilled at
> launch.

---

## 4. Cross-border transfer

**Guest data is processed outside the UAE.** There is no Supabase region in the
United Arab Emirates.

| | |
|---|---|
| **Destination** | `[TO BE COMPLETED: country and region actually provisioned]` |
| **Intended choice** | Frankfurt (`eu-central-1`), on the reasoning that the surrounding GDPR regime gives the strongest available argument on adequacy |
| **Safeguard relied on** | `[TO BE COMPLETED BY COUNSEL]` — one of: an adequacy determination recognised by the UAE Data Office (PDPL Art. 22), an appropriate contractual undertaking (Art. 23), or the data subject's express consent |
| **Decision recorded by** | `[TO BE COMPLETED: name and date of the person who provisioned the region]` |

**Stated honestly:** whether any particular destination carries a published UAE
adequacy determination is a question about the current state of UAE regulatory
practice and about the PDPL's **Executive Regulations**, which set the procedural
detail and whose status must be verified at the time of launch. This register
does not assert an answer. It records the question, names who must answer it, and
leaves the field blank until they do.

**Portability as a hedge.** The schema is stock PostgreSQL 15+ with `btree_gist`
and `pgcrypto`, both in contrib. Nothing is Supabase-specific. If counsel or a
future regulation requires localisation, the database moves to any UAE-hosted
Postgres (AWS `me-central-1`, G42, Etisalat, Khazna) with a `pg_dump` and a
connection-string change. That portability is deliberate.

---

## 5. Known gaps between the specification and the code

Recorded here rather than omitted. Each is a genuine divergence found by reading
the schema and the service code against spec §11.

| # | Gap | Impact | Status |
|---|---|---|---|
| **G1** | `booking_requests.message` is **not screened for medical terms**. `assertNotMedical()` is applied only to `guests.notes` on create and update — not to booking-request messages, and not to `reservations.notes`. The live site's form placeholder reads *"Injuries, pressure preference, preferred therapist…"*, which actively solicits health data. | **High.** §11.5 is a hard stop on health data and this is the widest path around it. | **Must fix before launch:** change the placeholder, and apply the screen to `message` and `reservations.notes`. |
| **G2** | `ConsentType.PHOTO` exists in the enum, the contract and the API, but §11.2's lawful-basis table does not mention photography at all. | Medium. A consent type with no documented basis. | Covered in this register and in the privacy notice on a consent basis. §11.2 should be updated to match. |
| **G3** | ~~Nothing anonymises a guest at 3 years.~~ | — | ✅ **Resolved.** `RetentionService` implements the guest half via `POST /v1/compliance/retention/run`, reading `GUEST_RETENTION_YEARS` from configuration and calling the same `GuestErasureService.erase()` path as the rights endpoint. **Remaining:** `FINANCIAL_RETENTION_YEARS` is still read by nothing — no job archives or reviews financial records at 5 years. That is arguably correct (deletion of accounting records should be a decision, not a cron job), but it must be a **documented manual annual review** with an owner: `[TO BE COMPLETED]`. |
| **G4** | No retention rule of any kind for `booking_requests`. Declined and spam enquiries — which hold a name, a phone number and free text — are kept indefinitely. | Medium-high. Undeclared indefinite retention of prospect data. | **Must fix before launch.** Propose: delete `DECLINED` and `SPAM` after 12 months; `NEW`/`CONTACTED` after 24 months. Counsel to confirm. |
| **G5** | The consent gate and attribution script now exist as `assets/js/consent.js` and `assets/js/attribution.js`, but **`index.html` does not reference either** — and both are deliberately dormant until `window.BERELAX_ATTRIBUTION_API` is set, which needs the `api.berelax.ae` subdomain to exist. So no analytics of any kind run today and nothing is collected. | High at launch, zero today. | **Must be wired into `index.html` and verified before the CRM goes live.** Until then the privacy notice's analytics section describes something the site does not yet do. |
| **G13** | **Version-string mismatch.** `consent.js` falls back to `"2026-01"` when `window.BERELAX_PRIVACY_VERSION` is unset, while the privacy notice is `1.0-draft`. A consent recorded against a version string that names no real document proves nothing. | **High once consent is live.** | **Must fix when the gate is wired up:** set `window.BERELAX_PRIVACY_VERSION` in `index.html` to the notice's exact version, and make sure the desk sends the same string in `policyVersion`. |
| **G6** | `idempotency_records.response_body` holds a verbatim copy of API responses, which for money endpoints can include guest-identifying fields. §11.6's retention table does not list this table. | Low — 24-hour TTL, deleted by the retention function, no read endpoint. | Documented here as [A11](#a11--idempotency-records-operational-resilience). §11.6 should list it. |
| **G7** | §12.3 specifies pino structured logging with a PII-redacting serialiser, and Sentry with a PII-stripping `beforeSend`. **Pino is now implemented and its redaction is verified; Sentry is not.** The adapter exists and carries the real `beforeSend`, but the SDK is not installed, so nothing is reported. | Low, and narrowed. The PII-in-logs half — the part that mattered for this register — is closed. What remains is that an unhandled error is visible only in the platform's own log stream, with nobody alerted. The 90-day retention claim is still a platform setting nobody has confirmed. | **Reduced.** Sentry is an operational choice, not a launch blocker. The log-retention window still needs confirming: `[TO BE COMPLETED: confirm the runtime log retention window on Vercel]` |
| **G8** | ~~The `pg_cron` schedule for `prune_attribution()` is commented out.~~ | — | ✅ **Resolved** by `migrations/20260917090000_retention_schedule`, which schedules the job idempotently when `pg_cron` is present and raises a clear notice (rather than failing) when it is not — as on local Postgres and in CI. **Verify on the production database after the first deploy** that the job exists and has run: `SELECT jobname, schedule, active FROM cron.job;` |
| **G9** | ~~`/guests/:id/export` and `/guests/:id/erase` do not exist.~~ | — | ✅ **Resolved.** Both are implemented in `src/compliance/`, gated at `MANAGER+` on their own controller with no widening exception, and both write to the audit log. See [A13](#a13--data-subject-rights-administration). |
| **G10** | §11.9 claims `REVOKE DELETE` on `financial_audit_log`, `payments` and `therapist_payout_ledger` as a least-privilege control. No `GRANT`/`REVOKE` statements exist in any migration. | Low. The **effect** is achieved by the append-only triggers, which are stronger (they bind every role, including the table owner). | Either add the grants or amend §11.9 to describe the triggers as the control. |
| **G11** | ~~§12.4 describes Redis-backed rate limiting; the throttler uses in-memory storage, which does not hold across more than one API instance.~~ | — | ✅ **Resolved**, and it had to be: the API now runs as serverless functions, where "more than one instance" is the normal case and not an edge one. `PgThrottlerStorage` (`apps/api/src/common/pg-throttler.storage.ts`) keeps the counters in PostgreSQL — **not** Redis, deliberately: a second data store would be a second processor, a second DPA and a new row in [§3](#3-processors) for a spa doing tens of bookings a night. The counter is a single atomic `INSERT … ON CONFLICT DO UPDATE`, proven under concurrency by `test/rate-limit-storage.e2e-spec.ts`. The table is declared at [A14](#a14--rate-limiting-and-brute-force-protection). **Still open:** `TURNSTILE_SECRET` is unimplemented — `publicBookingRequestSchema` accepts `turnstileToken` and discards it. See the Cloudflare status note in [§3](#3-processors). |
| **G12** | §11.9 claims HSTS `max-age=31536000; includeSubDomains; preload`. `helmet()` sets a default HSTS header, but `preload` is not configured and `netlify.toml` sets no HSTS header for the public site. | Low. | Verify and configure explicitly. |

---

## 6. Security measures

| Control | What is actually in place |
|---|---|
| **Transport encryption** | TLS on all hosted platforms. HSTS via `helmet()` defaults on the API — **the `preload` directive claimed in §11.9 is not configured**, and `netlify.toml` sets no HSTS header. See [G12](#5-known-gaps-between-the-specification-and-the-code). |
| **Encryption at rest** | Supabase AES-256 on volumes and backups (platform-provided) |
| **Password storage** | bcrypt, cost 12, with automatic re-hash on login if the stored cost has drifted below the configured one. A constant-time dummy comparison runs for unknown emails so login timing does not reveal whether an account exists. |
| **Session security** | Opaque 256-bit refresh tokens; only their SHA-256 is stored. Rotation with reuse detection: presenting a spent token revokes the whole family and writes an audit row. |
| **Access control** | Four roles (`OWNER`, `MANAGER`, `RECEPTIONIST`, `THERAPIST`). The load-bearing boundary is reception vs manager: **reception takes money all evening and never sees a total.** Therapists see only their own shifts, bookings and earnings. |
| **Branch scoping** | `branch_id` comes from the JWT, never from a request body, and is in the `WHERE` clause of every query rather than checked afterwards |
| **Append-only financial data** | Database triggers on `financial_audit_log`, `payments` and `therapist_payout_ledger`. Prisma `update`/`delete` on these tables throws. Corrections are reversing rows. |
| **Accountability** | Every money action carries an actor ID, role, IP, user agent and request ID, written in the same transaction as the change |
| **PII redaction in the audit log** | `pickAuditFields()` drops name, phone, email, notes, legal name, password hash and token hash before writing |
| **Input validation** | Zod schemas shared between the API and the dashboard via `@berelax/contracts`; 128 KB request body cap; CORS restricted to the dashboard and public site origins |
| **Rate limiting** | 300/min per authenticated user; 10/min and 60/hour per IP on `/public/*`; 60/min on `/r/*`; 5 per 15 min per IP on login, on top of the five-failure account lockout. Counters are held in **PostgreSQL and shared by every instance** (`PgThrottlerStorage`), not in each process — see [A14](#a14--rate-limiting-and-brute-force-protection) and [G11](#5-known-gaps-between-the-specification-and-the-code). One caveat, stated rather than buried: it is a fixed window, so a caller can land up to 2 × the limit across a window boundary. The sustained rate is unchanged. |
| **Enumeration resistance** | The public booking endpoint returns a bare reference — no database ID, no guest lookup result, no "welcome back". A form that answers differently for a known number is a phone-number oracle. Unknown or foreign-branch service IDs are silently dropped rather than refused, so the catalogue cannot be enumerated. |
| **WhatsApp redirect hardening** | `/r/wa?text=` is a first-party URL that gets pasted into adverts, so the text is stripped of control and bidi characters, rejected outright if it looks like a link, filtered to letters/digits/ordinary punctuation, and capped at 300 characters |
| **Secrets** | Platform secret managers only. `.env` is never committed; `.env.example` holds names and no values. The API refuses to boot in production if `ERASURE_SALT` still holds its development default or `COOKIE_DOMAIN` is `localhost`. |
| **Backups** | Supabase daily backups + PITR, retained 30 days. **A restore must be rehearsed quarterly** — record each rehearsal in [§8](#8-review-log). |
| **Data minimisation** | No date of birth, no Emirates ID or passport number, no nationality, no gender, no home address, no card numbers, no location. The system asks for a name, a phone number and an optional email, because that is what a booking needs. |

---

## 7. Open questions for counsel

1. **The status of the PDPL's Executive Regulations**, and what they require
   procedurally for cross-border transfer, breach notification and data subject
   requests. Several claims in this register and in the privacy notice depend on
   them.
2. **The cross-border transfer basis** — adequacy, contractual undertaking, or
   express consent — for the region actually provisioned.
3. **Whether Federal Law No. 2 of 2019 on ICT in health fields applies** to a
   non-clinical wellness spa. We assume it might and store no health data at all.
   This is a design decision taken to avoid the question, not an assertion that
   the law applies. Counsel should say whether the caution is required or merely
   prudent — and, separately, whether the paper-in-a-locked-cabinet fallback is
   itself compliant.
4. **Whether a DPO must be appointed** for this processing profile.
5. **The retention periods**: whether five years is correct for financial records
   under the applicable UAE tax and commercial record-keeping rules, whether seven
   years is right for the audit log, and what period applies to employee records
   under UAE labour law.
6. **The proposed retention rule for `booking_requests`** ([G4](#5-known-gaps-between-the-specification-and-the-code)).
7. **Whether anonymisation-in-place satisfies the right to erasure** under PDPL
   Art. 15 in the form implemented here — a salted one-way hash of the phone
   number retained so that a blocked guest stays blocked. This is a considered
   trade-off, not an obvious one.
8. **Whether deleting consent records on erasure is right.** The retention rule
   says consent records are kept three years past withdrawal, as proof that
   consent existed; the erasure path deletes them outright, because a consent row
   holds the guest's IP address and an erasure request is the guest asking for the
   relationship to end. Two PDPL obligations pull in opposite directions here and
   the code has picked one. Counsel should confirm the choice, or tell us to
   reverse it.
9. **The consent wording** for analytics, marketing and photography.
10. **Whether the spa's employment and payout records** create any additional
   registration or record-keeping obligation beyond the PDPL.

---

## 8. Review log

| Date | Reviewer | Scope | Outcome |
|---|---|---|---|
| 2026-09-17 | Engineering | First compilation from schema and service code | Draft. 12 divergences recorded in [§5](#5-known-gaps-between-the-specification-and-the-code). |
| 2026-09-17 | Engineering | Re-check after the `src/compliance/` module and `assets/js/` landed | G3, G8 and G9 resolved; G5 narrowed; G13 added. **10 open**, of which 5 are launch blockers: G1, G4, G5, G13, and naming an owner for the manual financial review under G3. |
| `[TO BE COMPLETED]` | `[TO BE COMPLETED: UAE counsel]` | Legal review before launch | `[pending]` |
| `[TO BE COMPLETED]` | `[TO BE COMPLETED]` | Quarterly review | `[pending]` |
| `[TO BE COMPLETED]` | `[TO BE COMPLETED]` | Backup restore rehearsal | `[pending]` |

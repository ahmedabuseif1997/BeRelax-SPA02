# BE RELAX — CRM & Booking Platform
## Production Architecture Specification

**Version:** 1.0
**Status:** Approved for build
**Location scope:** Single branch — 250 Al Meena St, Al Zahiyah, E14, Abu Dhabi
**Operating hours:** 11:00 → 02:00 (next day), every day
**Currency:** AED
**Operating timezone:** `Asia/Dubai` (UTC+04:00, no daylight saving)

---

## Table of Contents

1. [Scope and Non-Goals](#1-scope-and-non-goals)
2. [System Architecture](#2-system-architecture)
3. [Global Conventions](#3-global-conventions)
4. [Data Model — Prisma Schema](#4-data-model--prisma-schema)
5. [SQL Migrations — What Prisma Cannot Express](#5-sql-migrations--what-prisma-cannot-express)
6. [Authentication, Sessions and RBAC](#6-authentication-sessions-and-rbac)
7. [API Surface](#7-api-surface)
8. [The Two-Step Financial Workflow](#8-the-two-step-financial-workflow)
9. [Tips, the Payout Ledger and the Audit Trail](#9-tips-the-payout-ledger-and-the-audit-trail)
10. [Multi-Touch Attribution](#10-multi-touch-attribution)
11. [UAE PDPL and Data Compliance](#11-uae-pdpl-and-data-compliance)
12. [Non-Functional Requirements](#12-non-functional-requirements)
13. [Testing Strategy](#13-testing-strategy)
14. [Delivery Plan](#14-delivery-plan)
15. [Known Limitations — Read This Before You Promise Anything](#15-known-limitations--read-this-before-you-promise-anything)

---

## 1. Scope and Non-Goals

### 1.1 What this system does

| Capability | Description |
|---|---|
| **Reservations** | Create, reschedule, cancel and complete bookings against a therapist, a room and a time window. Double-booking is prevented **by the database**, not by application code. |
| **Dual intake pipeline** | Web/WhatsApp requests land as `booking_requests` (unconfirmed, no resource held). Reception converts them into `reservations` (confirmed, resource held). Walk-ins and phone calls create a `reservation` directly. |
| **Two-step money flow** | Base service cost is collected **up front at check-in**. Tips are collected **after the service at checkout**. These are separate transactions with separate audit entries. |
| **Tip architecture** | Two tip modes — `DIRECT_CASH` (guest hands the therapist cash; the business never touches it) and `COLLECTED_BY_BUSINESS` (added to the card/cash settlement; the business now owes the therapist). Only the second creates a liability. |
| **Therapist payout ledger** | Append-only, signed-amount ledger of what the business owes each therapist. A balance is a `SUM()`, never a stored mutable number. |
| **Financial audit log** | Append-only record of every money-affecting action with actor, before/after state, IP and request ID. This is the artefact you produce when a therapist disputes a payout. |
| **Attendance** | Therapist shifts, clock-in/clock-out, and availability that feeds the booking grid. |
| **Attribution** | 90-day multi-touch attribution from the public site through to a completed, paid reservation — SEO, Google Ads, Meta Ads, WhatsApp, phone and walk-in. |
| **Reporting** | Revenue, occupancy, therapist utilisation, tip totals by mode, and channel-level ROI. |

### 1.2 Non-goals for v1

- **No online card payment.** Payment is recorded, not processed. Adding a UAE PSP (Telr, Network International, Stripe UAE) is a later phase with its own PCI scope.
- **No guest-facing login.** Guests interact through the public site and WhatsApp only.
- **No inventory/retail POS.**
- **No SMS/email campaign engine.** Consent flags are captured so one can be bolted on later.
- **No multi-branch UI.** But `branch_id` is on every table from day one, so a second branch is a data change, not a rewrite.
- **No clinical/medical records.** See [§11.5](#115-health-data-is-a-hard-stop) — this is a deliberate compliance decision, not an oversight.

---

## 2. System Architecture

### 2.1 Stack

```
┌──────────────────────────────┐   ┌──────────────────────────────┐
│  Public site (existing)      │   │  CRM Dashboard               │
│  index.html on Netlify       │   │  Next.js 14 App Router       │
│  + attribution.js            │   │  TypeScript, Tailwind        │
│  + /r/wa redirect            │   │  Vercel                      │
└───────────────┬──────────────┘   └───────────────┬──────────────┘
                │  POST /public/*                  │  Bearer JWT
                └────────────────┬─────────────────┘
                                 ▼
                 ┌───────────────────────────────┐
                 │  API — NestJS 10              │
                 │  TypeScript, Prisma 5         │
                 │  Railway or Render (always-on)│
                 └───────────────┬───────────────┘
                                 │  Prisma (pooled)
                                 ▼
                 ┌───────────────────────────────┐
                 │  PostgreSQL 15 — Supabase     │
                 │  + btree_gist                 │
                 │  + pgcrypto                   │
                 │  Daily PITR backups           │
                 └───────────────────────────────┘
```

**One language end to end.** TypeScript in the API, the dashboard and the shared DTO package. Prisma generates the types once and both sides import them.

### 2.2 Repository layout — monorepo

```
berelax-platform/
├── apps/
│   ├── api/                      # NestJS
│   │   ├── prisma/
│   │   │   ├── schema.prisma
│   │   │   ├── migrations/       # includes hand-written SQL
│   │   │   └── seed.ts
│   │   └── src/
│   │       ├── auth/             # JWT, guards, RBAC
│   │       ├── reservations/     # booking + the two-step workflow
│   │       ├── payments/         # base payments, tips, ledger
│   │       ├── employees/        # staff, shifts, attendance
│   │       ├── guests/           # guest records, DSR endpoints
│   │       ├── attribution/      # touch ingest + reporting
│   │       ├── reports/
│   │       ├── public/           # unauthenticated intake endpoints
│   │       └── common/           # audit interceptor, idempotency, errors
│   └── dashboard/                # Next.js CRM
├── packages/
│   ├── contracts/                # zod schemas + shared DTO types
│   └── config/                   # eslint, tsconfig, prettier
└── turbo.json
```

### 2.3 Why NestJS and not "just Next.js API routes"

The money endpoints need database transactions that span several writes, a request-scoped audit context, and idempotency. Serverless function handlers make all three awkward — cold starts fight connection pooling, and there is no natural place to hang a request-scoped interceptor. A long-lived Nest process gives you a real DI container, a global `AuditInterceptor`, and one Prisma client with a stable pool.

The dashboard stays on Next.js because it is a UI, and it benefits from RSC and Vercel's edge network.

### 2.4 Connection pooling — get this right on day one

Supabase gives you two connection strings. Using the wrong one costs you an afternoon.

```bash
# Runtime: transaction-mode pooler (PgBouncer), port 6543.
DATABASE_URL="postgresql://postgres.PROJECT:PW@aws-0-REGION.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1"

# Migrations and introspection: direct connection, port 5432.
DIRECT_URL="postgresql://postgres.PROJECT:PW@aws-0-REGION.pooler.supabase.com:5432/postgres"
```

```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}
```

PgBouncer in transaction mode does not support prepared statements or session-level advisory locks. `prisma migrate` needs a session connection, hence `directUrl`.

> **Rule:** `prisma db push` is **banned** on this project. It does not understand the hand-written exclusion constraints, triggers and rules in [§5](#5-sql-migrations--what-prisma-cannot-express) and will silently drop them. Every schema change goes through `prisma migrate dev` and is reviewed as SQL.

---

## 3. Global Conventions

### 3.1 Money is an integer

All monetary amounts are **integer fils**. 1 AED = 100 fils. `250.00 AED` is `25000`.

There are no floats and no `Decimal` round-trips anywhere in this system. Every column is named with an `_fils` suffix so a mistake is visible in code review. Formatting to `AED 250.00` happens once, in the presentation layer.

```ts
// packages/contracts/src/money.ts
export type Fils = number & { readonly __brand: 'Fils' };
export const toFils = (aed: number): Fils => Math.round(aed * 100) as Fils;
export const formatAed = (f: Fils) =>
  new Intl.NumberFormat('en-AE', { style: 'currency', currency: 'AED' }).format(f / 100);
```

### 3.2 Time is UTC in the database, Dubai in the interface

Every timestamp column is `timestamptz` and stores UTC. The API accepts and returns ISO-8601 with an explicit offset. The dashboard renders in `Asia/Dubai`.

Dubai has no daylight saving, which removes the usual class of bug — but it does not remove the next one.

### 3.3 The business day is not the calendar day

The spa opens at 11:00 and closes at 02:00 **the following morning**. A reservation at 01:30 on Tuesday belongs to Monday's trading day, Monday's revenue report and Monday's therapist shift.

Every report and every shift grouping uses the **business day**, defined as the calendar date in `Asia/Dubai` after subtracting 6 hours:

```sql
CREATE OR REPLACE FUNCTION business_day(ts timestamptz)
RETURNS date
LANGUAGE sql IMMUTABLE AS $$
  SELECT ((ts AT TIME ZONE 'Asia/Dubai') - interval '6 hours')::date;
$$;
```

A 6-hour cutover sits inside the 02:00–11:00 closed window, so it can never split a live session. Grouping a revenue report by `date_trunc('day', ...)` instead of `business_day(...)` is a reporting bug, and it will be the one that makes a manager distrust the whole system.

### 3.4 Identifiers

Primary keys are UUID v7. v7 is time-ordered, so it indexes like a sequence without leaking a row count the way `bigserial` does.

`uuid_generate_v7()` is implemented in **plain plpgsql** in the first migration, not via the `pg_uuidv7` extension — that extension is not available on managed Postgres, Supabase included, and depending on it would tie the schema to a self-hosted server. The function takes a v4 UUID (which already carries the right variant bits), overlays the first 48 bits with a millisecond timestamp, and flips the version nibble.

Verified on PostgreSQL 16: correct version and variant bits across 2,000 values, 20,000 distinct with no collision, and **strictly ordered across milliseconds**. Within a single millisecond the tail is random, which RFC 9562 permits — index locality comes from the 48-bit time prefix, not from total order.

Human-facing references are separate and short: `reservation.ref` is `BR-2026-0001`, generated from a per-year sequence. Reception reads this over the phone; nobody reads a UUID over the phone.

### 3.5 Soft deletes

Guest and employee records are never hard-deleted — `deleted_at timestamptz`. Financial rows are **never** deleted or updated at all; they are reversed by a new row. See [§9.4](#94-corrections-are-reversals-never-edits).

### 3.6 Errors

Every error response is the same shape:

```json
{
  "error": {
    "code": "RESERVATION_SLOT_CONFLICT",
    "message": "Layla is already booked from 14:00 to 15:00.",
    "details": { "conflictingReservationId": "0192f...", "employeeId": "0192a..." },
    "requestId": "req_01JBQ7X8..."
  }
}
```

`code` is a stable machine-readable enum. `message` is safe to show a receptionist. `requestId` appears in every log line for that request and in the audit log.

---

## 4. Data Model — Prisma Schema

`apps/api/prisma/schema.prisma`

```prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["postgresqlExtensions"]
}

datasource db {
  provider   = "postgresql"
  url        = env("DATABASE_URL")
  directUrl  = env("DIRECT_URL")
  extensions = [btree_gist, pgcrypto]
}

// ─────────────────────────────────────────────────────────────
// ENUMS
// ─────────────────────────────────────────────────────────────

enum UserRole {
  OWNER          // everything, including payouts and user management
  MANAGER        // everything operational + financial reports, no user management
  RECEPTIONIST   // bookings, check-in, checkout, no financial reports
  THERAPIST      // read-only: own schedule and own earnings
}

enum EmployeeStatus { ACTIVE ON_LEAVE INACTIVE }

enum ReservationStatus {
  SCHEDULED
  IN_PROGRESS
  COMPLETED
  CANCELLED
  NO_SHOW
}

enum BookingRequestStatus {
  NEW
  CONTACTED
  CONVERTED
  DECLINED
  SPAM
}

enum SourceChannel {
  WEBSITE_FORM
  WHATSAPP
  PHONE
  WALK_IN
  INSTAGRAM
  GOOGLE_MAPS
  REFERRAL
  OTHER
}

enum PaymentKind {
  BASE           // the service cost, collected at check-in
  TIP            // only when tip_type = COLLECTED_BY_BUSINESS
  REFUND         // negative amount
  ADJUSTMENT     // manager correction, negative or positive
}

enum PaymentMethod {
  CASH
  CARD
  BANK_TRANSFER
  VOUCHER
  COMPLIMENTARY
}

enum TipType {
  DIRECT_CASH            // guest → therapist, business never holds it
  COLLECTED_BY_BUSINESS  // business holds it, owes the therapist
}

enum LedgerEntryType {
  TIP_ACCRUAL          // + business owes therapist
  COMMISSION_ACCRUAL   // + business owes therapist
  PAYOUT               // - paid out
  ADJUSTMENT           // ± manual correction
  REVERSAL             // ± undo of a specific prior entry
}

enum ShiftStatus { PLANNED ACTIVE ENDED ABSENT }

enum ConsentType {
  DATA_PROCESSING   // PDPL lawful-basis record
  MARKETING         // promotional messages
  PHOTO             // use of images
}

// ─────────────────────────────────────────────────────────────
// TENANCY
// ─────────────────────────────────────────────────────────────

model Branch {
  id               String   @id @default(dbgenerated("uuid_generate_v7()")) @db.Uuid
  name             String
  addressLine      String   @map("address_line")
  city             String   @default("Abu Dhabi")
  phonePrimary     String   @map("phone_primary")
  phoneSecondary   String?  @map("phone_secondary")
  whatsappNumber   String   @map("whatsapp_number")
  googleMapsUrl    String?  @map("google_maps_url")
  timezone         String   @default("Asia/Dubai")
  opensAt          String   @default("11:00") @map("opens_at")   // local wall-clock
  closesAt         String   @default("02:00") @map("closes_at")  // next day
  turnaroundMins   Int      @default(15) @map("turnaround_mins") // room reset between guests
  createdAt        DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt        DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)

  users            User[]
  employees        Employee[]
  rooms            Room[]
  services         Service[]
  guests           Guest[]
  reservations     Reservation[]
  bookingRequests  BookingRequest[]
  payments         Payment[]
  tips             Tip[]
  ledgerEntries    TherapistPayoutLedger[]
  shifts           Shift[]
  auditEntries     FinancialAuditLog[]

  @@map("branches")
}

// ─────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────

model User {
  id                 String    @id @default(dbgenerated("uuid_generate_v7()")) @db.Uuid
  branchId           String    @map("branch_id") @db.Uuid
  email              String                                    // stored lowercase; unique index on lower(email)
  passwordHash       String    @map("password_hash")           // bcrypt, cost 12
  fullName           String    @map("full_name")
  role               UserRole
  isActive           Boolean   @default(true) @map("is_active")
  mustChangePassword Boolean   @default(true) @map("must_change_password")
  lastLoginAt        DateTime? @map("last_login_at") @db.Timestamptz(6)
  failedLoginCount   Int       @default(0) @map("failed_login_count")
  lockedUntil        DateTime? @map("locked_until") @db.Timestamptz(6)
  passwordChangedAt  DateTime  @default(now()) @map("password_changed_at") @db.Timestamptz(6)
  employeeId         String?   @unique @map("employee_id") @db.Uuid  // set for THERAPIST logins
  createdAt          DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt          DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)
  deletedAt          DateTime? @map("deleted_at") @db.Timestamptz(6)

  branch             Branch    @relation(fields: [branchId], references: [id])
  employee           Employee? @relation(fields: [employeeId], references: [id])
  refreshTokens      RefreshToken[]

  @@index([branchId, role])
  @@map("users")
}

model RefreshToken {
  id           String    @id @default(dbgenerated("uuid_generate_v7()")) @db.Uuid
  userId       String    @map("user_id") @db.Uuid
  familyId     String    @map("family_id") @db.Uuid   // rotation lineage; reuse revokes the family
  tokenHash    String    @unique @map("token_hash")   // SHA-256 of the opaque token
  expiresAt    DateTime  @map("expires_at") @db.Timestamptz(6)
  revokedAt    DateTime? @map("revoked_at") @db.Timestamptz(6)
  replacedById String?   @map("replaced_by_id") @db.Uuid
  userAgent    String?   @map("user_agent")
  ipAddress    String?   @map("ip_address")
  createdAt    DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)

  user         User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, revokedAt])
  @@index([familyId])
  @@map("refresh_tokens")
}

// ─────────────────────────────────────────────────────────────
// CATALOGUE AND RESOURCES
// ─────────────────────────────────────────────────────────────

model ServiceCategory {
  id        String    @id @default(dbgenerated("uuid_generate_v7()")) @db.Uuid
  name      String                                   // "Asian", "Arabic", "Moroccan Bath"
  sortOrder Int       @default(0) @map("sort_order")
  isActive  Boolean   @default(true) @map("is_active")
  services  Service[]

  @@map("service_categories")
}

model Service {
  id              String  @id @default(dbgenerated("uuid_generate_v7()")) @db.Uuid
  branchId        String  @map("branch_id") @db.Uuid
  categoryId      String  @map("category_id") @db.Uuid
  name            String
  durationMinutes Int     @map("duration_minutes")
  priceFils       Int     @map("price_fils")
  description     String?
  requiresRoom    Boolean @default(true) @map("requires_room")
  isActive        Boolean @default(true) @map("is_active")
  sortOrder       Int     @default(0) @map("sort_order")

  branch          Branch          @relation(fields: [branchId], references: [id])
  category        ServiceCategory @relation(fields: [categoryId], references: [id])
  reservations    Reservation[]

  @@index([branchId, isActive])
  @@map("services")
}

model Room {
  id       String  @id @default(dbgenerated("uuid_generate_v7()")) @db.Uuid
  branchId String  @map("branch_id") @db.Uuid
  name     String                                     // "Room 1", "Moroccan Bath"
  capacity Int     @default(1)
  isActive Boolean @default(true) @map("is_active")

  branch       Branch        @relation(fields: [branchId], references: [id])
  reservations Reservation[]

  @@unique([branchId, name])
  @@map("rooms")
}

model Employee {
  id                 String         @id @default(dbgenerated("uuid_generate_v7()")) @db.Uuid
  branchId           String         @map("branch_id") @db.Uuid
  displayName        String         @map("display_name")     // the name shown to guests
  legalName          String?        @map("legal_name")       // HR only — restricted field
  phone              String?
  status             EmployeeStatus @default(ACTIVE)
  commissionBps      Int            @default(0) @map("commission_bps")  // basis points of base service
  hiredOn            DateTime?      @map("hired_on") @db.Date
  photoUrl           String?        @map("photo_url")
  createdAt          DateTime       @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt          DateTime       @updatedAt @map("updated_at") @db.Timestamptz(6)
  deletedAt          DateTime?      @map("deleted_at") @db.Timestamptz(6)

  branch             Branch         @relation(fields: [branchId], references: [id])
  user               User?
  reservations       Reservation[]
  shifts             Shift[]
  tips               Tip[]
  ledgerEntries      TherapistPayoutLedger[]

  @@index([branchId, status])
  @@map("employees")
}

model Shift {
  id            String      @id @default(dbgenerated("uuid_generate_v7()")) @db.Uuid
  branchId      String      @map("branch_id") @db.Uuid
  employeeId    String      @map("employee_id") @db.Uuid
  businessDay   DateTime    @map("business_day") @db.Date
  plannedStart  DateTime    @map("planned_start") @db.Timestamptz(6)
  plannedEnd    DateTime    @map("planned_end") @db.Timestamptz(6)
  clockInAt     DateTime?   @map("clock_in_at") @db.Timestamptz(6)
  clockOutAt    DateTime?   @map("clock_out_at") @db.Timestamptz(6)
  status        ShiftStatus @default(PLANNED)
  note          String?

  branch        Branch      @relation(fields: [branchId], references: [id])
  employee      Employee    @relation(fields: [employeeId], references: [id])

  @@unique([employeeId, businessDay])
  @@index([branchId, businessDay])
  @@map("shifts")
}

// ─────────────────────────────────────────────────────────────
// GUESTS
// ─────────────────────────────────────────────────────────────

model Guest {
  id            String    @id @default(dbgenerated("uuid_generate_v7()")) @db.Uuid
  branchId      String    @map("branch_id") @db.Uuid
  fullName      String    @map("full_name")
  phone         String                                   // E.164, e.g. +971501234567
  email         String?
  notes         String?                                  // preferences only — see §11.5
  isBlocked     Boolean   @default(false) @map("is_blocked")
  anonymisedAt  DateTime? @map("anonymised_at") @db.Timestamptz(6)  // PDPL erasure
  createdAt     DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt     DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)
  deletedAt     DateTime? @map("deleted_at") @db.Timestamptz(6)

  branch        Branch    @relation(fields: [branchId], references: [id])
  reservations  Reservation[]
  requests      BookingRequest[]
  consents      GuestConsent[]

  @@unique([branchId, phone])
  @@index([branchId, fullName])
  @@map("guests")
}

model GuestConsent {
  id          String      @id @default(dbgenerated("uuid_generate_v7()")) @db.Uuid
  guestId     String      @map("guest_id") @db.Uuid
  type        ConsentType
  granted     Boolean
  grantedAt   DateTime    @default(now()) @map("granted_at") @db.Timestamptz(6)
  withdrawnAt DateTime?   @map("withdrawn_at") @db.Timestamptz(6)
  source      String                                      // "web_form", "reception_ipad", "whatsapp"
  policyVersion String    @map("policy_version")          // which privacy notice they saw
  ipAddress   String?     @map("ip_address")

  guest       Guest       @relation(fields: [guestId], references: [id], onDelete: Cascade)

  @@index([guestId, type])
  @@map("guest_consents")
}

// ─────────────────────────────────────────────────────────────
// BOOKING PIPELINE
// ─────────────────────────────────────────────────────────────

/// An unconfirmed enquiry. Holds NO resource and cannot conflict with anything.
model BookingRequest {
  id              String               @id @default(dbgenerated("uuid_generate_v7()")) @db.Uuid
  branchId        String               @map("branch_id") @db.Uuid
  guestId         String?              @map("guest_id") @db.Uuid
  guestName       String               @map("guest_name")
  guestPhone      String               @map("guest_phone")
  guestEmail      String?              @map("guest_email")
  requestedServiceId String?           @map("requested_service_id") @db.Uuid
  requestedAt     DateTime?            @map("requested_at") @db.Timestamptz(6)
  message         String?
  status          BookingRequestStatus @default(NEW)
  sourceChannel   SourceChannel        @map("source_channel")
  attributionId   String?              @unique @map("attribution_id") @db.Uuid
  convertedReservationId String?       @unique @map("converted_reservation_id") @db.Uuid
  handledByUserId String?              @map("handled_by_user_id") @db.Uuid
  handledAt       DateTime?            @map("handled_at") @db.Timestamptz(6)
  createdAt       DateTime             @default(now()) @map("created_at") @db.Timestamptz(6)

  branch          Branch               @relation(fields: [branchId], references: [id])
  guest           Guest?               @relation(fields: [guestId], references: [id])
  attribution     AttributionSnapshot? @relation(fields: [attributionId], references: [id])
  reservation     Reservation?         @relation(fields: [convertedReservationId], references: [id])

  @@index([branchId, status, createdAt])
  @@map("booking_requests")
}

/// A confirmed booking. Holds a therapist, optionally a room, for a time window.
model Reservation {
  id               String            @id @default(dbgenerated("uuid_generate_v7()")) @db.Uuid
  ref              String            @unique                 // "BR-2026-0001"
  branchId         String            @map("branch_id") @db.Uuid
  guestId          String?           @map("guest_id") @db.Uuid   // null for anonymous walk-in
  employeeId       String            @map("employee_id") @db.Uuid
  roomId           String?           @map("room_id") @db.Uuid
  serviceId        String            @map("service_id") @db.Uuid

  startsAt         DateTime          @map("starts_at") @db.Timestamptz(6)
  durationMinutes  Int               @map("duration_minutes")
  /// MAINTAINED BY TRIGGER — do not set from the application.
  endsAt           DateTime          @map("ends_at") @db.Timestamptz(6)
  /// endsAt + branch turnaround. The exclusion constraint uses THIS column.
  blockedUntil     DateTime          @map("blocked_until") @db.Timestamptz(6)
  businessDay      DateTime          @map("business_day") @db.Date

  status           ReservationStatus @default(SCHEDULED)
  baseCostFils     Int               @map("base_cost_fils")   // snapshot of the price at booking time
  sourceChannel    SourceChannel     @map("source_channel")
  attributionId    String?           @map("attribution_id") @db.Uuid

  actualArrivalAt  DateTime?         @map("actual_arrival_at") @db.Timestamptz(6)
  completedAt      DateTime?         @map("completed_at") @db.Timestamptz(6)
  cancelledAt      DateTime?         @map("cancelled_at") @db.Timestamptz(6)
  cancellationReason String?         @map("cancellation_reason")

  notes            String?
  createdByUserId  String?           @map("created_by_user_id") @db.Uuid
  createdAt        DateTime          @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt        DateTime          @updatedAt @map("updated_at") @db.Timestamptz(6)

  branch           Branch               @relation(fields: [branchId], references: [id])
  guest            Guest?               @relation(fields: [guestId], references: [id])
  employee         Employee             @relation(fields: [employeeId], references: [id])
  room             Room?                @relation(fields: [roomId], references: [id])
  service          Service              @relation(fields: [serviceId], references: [id])
  attribution      AttributionSnapshot? @relation(fields: [attributionId], references: [id])
  payments         Payment[]
  tips             Tip[]
  ledgerEntries    TherapistPayoutLedger[]
  originRequest    BookingRequest?

  @@index([branchId, businessDay, status])
  @@index([employeeId, startsAt])
  @@index([guestId, startsAt])
  @@map("reservations")
}

// ─────────────────────────────────────────────────────────────
// MONEY
// ─────────────────────────────────────────────────────────────

/// Money that moved through the business till. Append-only (see §9.4).
model Payment {
  id               String        @id @default(dbgenerated("uuid_generate_v7()")) @db.Uuid
  branchId         String        @map("branch_id") @db.Uuid
  reservationId    String        @map("reservation_id") @db.Uuid
  kind             PaymentKind
  method           PaymentMethod
  amountFils       Int           @map("amount_fils")        // negative for REFUND
  businessDay      DateTime      @map("business_day") @db.Date
  collectedByUserId String       @map("collected_by_user_id") @db.Uuid
  // When the money changed hands. Reception supplies it, so a check-in can
  // legitimately back-date it to when the guest actually walked in.
  collectedAt      DateTime      @default(now()) @map("collected_at") @db.Timestamptz(6)
  // When the row was written. System time, never back-dated — this is the one
  // the audit trail is checked against (§13.3 invariant 7).
  createdAt        DateTime      @default(now()) @map("created_at") @db.Timestamptz(6)
  externalRef      String?       @map("external_ref")       // card terminal slip number
  reversesPaymentId String?      @map("reverses_payment_id") @db.Uuid
  note             String?
  idempotencyKey   String?       @unique @map("idempotency_key")

  branch           Branch        @relation(fields: [branchId], references: [id])
  reservation      Reservation   @relation(fields: [reservationId], references: [id])
  tip              Tip?

  @@index([branchId, businessDay, kind])
  @@index([reservationId])
  @@map("payments")
}

/// Every tip, both modes. paymentId is set ONLY for COLLECTED_BY_BUSINESS.
model Tip {
  id             String      @id @default(dbgenerated("uuid_generate_v7()")) @db.Uuid
  branchId       String      @map("branch_id") @db.Uuid
  reservationId  String      @map("reservation_id") @db.Uuid
  employeeId     String      @map("employee_id") @db.Uuid
  type           TipType
  amountFils     Int         @map("amount_fils")
  method         PaymentMethod?                        // how the business received it, if it did
  paymentId      String?     @unique @map("payment_id") @db.Uuid
  businessDay    DateTime    @map("business_day") @db.Date
  recordedByUserId String    @map("recorded_by_user_id") @db.Uuid
  recordedAt     DateTime    @default(now()) @map("recorded_at") @db.Timestamptz(6)
  reversedByTipId String?    @unique @map("reversed_by_tip_id") @db.Uuid
  note           String?

  branch         Branch      @relation(fields: [branchId], references: [id])
  reservation    Reservation @relation(fields: [reservationId], references: [id])
  employee       Employee    @relation(fields: [employeeId], references: [id])
  payment        Payment?    @relation(fields: [paymentId], references: [id])

  @@index([employeeId, businessDay])
  @@index([branchId, businessDay, type])
  @@map("tips")
}

/// Append-only. What the business OWES a therapist. Balance = SUM(amount_fils).
/// A DIRECT_CASH tip creates NO row here — the business never held that money.
model TherapistPayoutLedger {
  id               String          @id @default(dbgenerated("uuid_generate_v7()")) @db.Uuid
  branchId         String          @map("branch_id") @db.Uuid
  employeeId       String          @map("employee_id") @db.Uuid
  entryType        LedgerEntryType @map("entry_type")
  amountFils       Int             @map("amount_fils")   // signed: + accrues, - pays out
  businessDay      DateTime        @map("business_day") @db.Date
  reservationId    String?         @map("reservation_id") @db.Uuid
  tipId            String?         @map("tip_id") @db.Uuid
  payoutBatchId    String?         @map("payout_batch_id") @db.Uuid
  reversesEntryId  String?         @unique @map("reverses_entry_id") @db.Uuid
  createdByUserId  String          @map("created_by_user_id") @db.Uuid
  createdAt        DateTime        @default(now()) @map("created_at") @db.Timestamptz(6)
  note             String?

  branch           Branch          @relation(fields: [branchId], references: [id])
  employee         Employee        @relation(fields: [employeeId], references: [id])
  reservation      Reservation?    @relation(fields: [reservationId], references: [id])
  payoutBatch      PayoutBatch?    @relation(fields: [payoutBatchId], references: [id])

  @@index([employeeId, createdAt])
  @@index([branchId, businessDay])
  @@map("therapist_payout_ledger")
}

model PayoutBatch {
  id              String    @id @default(dbgenerated("uuid_generate_v7()")) @db.Uuid
  branchId        String    @map("branch_id") @db.Uuid
  employeeId      String    @map("employee_id") @db.Uuid
  periodStart     DateTime  @map("period_start") @db.Date
  periodEnd       DateTime  @map("period_end") @db.Date
  totalFils       Int       @map("total_fils")
  method          PaymentMethod
  paidAt          DateTime  @map("paid_at") @db.Timestamptz(6)
  approvedByUserId String   @map("approved_by_user_id") @db.Uuid
  acknowledgedAt  DateTime? @map("acknowledged_at") @db.Timestamptz(6)  // therapist signed off
  note            String?

  entries         TherapistPayoutLedger[]

  @@index([employeeId, periodEnd])
  @@map("payout_batches")
}

/// Append-only. Every money-affecting action, forever.
model FinancialAuditLog {
  id            String   @id @default(dbgenerated("uuid_generate_v7()")) @db.Uuid
  branchId      String   @map("branch_id") @db.Uuid
  actorUserId   String?  @map("actor_user_id") @db.Uuid
  actorRole     UserRole? @map("actor_role")
  action        String                                   // "RESERVATION_CHECK_IN", "TIP_RECORDED", ...
  entityType    String   @map("entity_type")
  entityId      String   @map("entity_id") @db.Uuid
  beforeState   Json?    @map("before_state")
  afterState    Json?    @map("after_state")
  amountFils    Int?     @map("amount_fils")             // denormalised for fast money queries
  ipAddress     String?  @map("ip_address")
  userAgent     String?  @map("user_agent")
  requestId     String   @map("request_id")
  createdAt     DateTime @default(now()) @map("created_at") @db.Timestamptz(6)

  branch        Branch   @relation(fields: [branchId], references: [id])

  @@index([entityType, entityId, createdAt])
  @@index([actorUserId, createdAt])
  @@index([branchId, createdAt])
  @@map("financial_audit_log")
}

// ─────────────────────────────────────────────────────────────
// ATTRIBUTION
// ─────────────────────────────────────────────────────────────

model AttributionSnapshot {
  id             String   @id @default(dbgenerated("uuid_generate_v7()")) @db.Uuid
  visitorId      String   @map("visitor_id") @db.Uuid     // first-party, generated client-side
  firstTouch     Json     @map("first_touch")             // Touch
  lastTouch      Json     @map("last_touch")              // Touch
  touches        Json                                     // Touch[] — capped at 10
  touchCount     Int      @map("touch_count")
  firstSeenAt    DateTime @map("first_seen_at") @db.Timestamptz(6)
  lastSeenAt     DateTime @map("last_seen_at") @db.Timestamptz(6)
  landingPath    String?  @map("landing_path")
  capturedAt     DateTime @default(now()) @map("captured_at") @db.Timestamptz(6)
  /// Set at the 90-day mark by the retention job; PII-bearing fields are cleared.
  prunedAt       DateTime? @map("pruned_at") @db.Timestamptz(6)

  reservations   Reservation[]
  bookingRequest BookingRequest?

  @@index([visitorId])
  @@index([capturedAt])
  @@map("attribution_snapshots")
}

/// Raw click-out log for WhatsApp / call buttons, written by the /r redirect endpoint.
model OutboundClick {
  id          String   @id @default(dbgenerated("uuid_generate_v7()")) @db.Uuid
  visitorId   String?  @map("visitor_id") @db.Uuid
  target      String                                     // "whatsapp" | "phone" | "maps"
  context     String?                                    // e.g. the service row that was clicked
  landingPath String?  @map("landing_path")
  utmSource   String?  @map("utm_source")
  utmMedium   String?  @map("utm_medium")
  utmCampaign String?  @map("utm_campaign")
  gclid       String?
  fbclid      String?
  referrer    String?
  userAgent   String?  @map("user_agent")
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz(6)

  @@index([target, createdAt])
  @@index([visitorId])
  @@map("outbound_clicks")
}

model IdempotencyRecord {
  key         String   @id
  userId      String   @map("user_id") @db.Uuid
  endpoint    String
  requestHash String   @map("request_hash")               // SHA-256 of the body
  statusCode  Int      @map("status_code")
  responseBody Json    @map("response_body")
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  expiresAt   DateTime @map("expires_at") @db.Timestamptz(6)

  @@index([expiresAt])
  @@map("idempotency_records")
}
```

### 4.1 Why `endsAt` and `blockedUntil` are stored columns

This is the single most important implementation detail in the schema, and the reason deserves stating plainly.

The obvious design is to compute the reservation's end from `starts_at + duration_minutes` inside the exclusion constraint:

```sql
-- THIS DOES NOT WORK. Do not try it.
EXCLUDE USING gist (
  employee_id WITH =,
  tstzrange(starts_at, starts_at + (duration_minutes || ' minutes')::interval) WITH &&
)
```

PostgreSQL rejects it: `functions in index expression must be marked IMMUTABLE`. Adding an `interval` to a `timestamptz` is **stable, not immutable**, because month and day components depend on the session `TimeZone` setting. A `GENERATED ALWAYS AS (...) STORED` column fails for exactly the same reason.

You will find suggestions to wrap the arithmetic in a hand-written `IMMUTABLE` SQL function. Do not. Lying to the planner about volatility produces an index that silently disagrees with the data, and the failure mode is a corrupt constraint that lets a double-booking through months later.

The correct answer is a plain `timestamptz` column maintained by a `BEFORE INSERT OR UPDATE` trigger, which is free to use stable functions. The trigger is in [§5.3](#53-derived-columns-and-the-state-machine) and the application never writes these two columns.

---

## 5. SQL Migrations — What Prisma Cannot Express

Prisma's schema language has no vocabulary for exclusion constraints, partial indexes, triggers, rules, functions or column-level grants. All of it lives in hand-written migration SQL that Prisma tracks but does not generate.

> **This SQL is verified, not illustrative.** Every statement in this section has been executed against PostgreSQL 16 together with assertions proving each guarantee it claims — including that the two "obvious" alternatives in [§4.1](#41-why-endsat-and-blockeduntil-are-stored-columns) really are rejected as non-`IMMUTABLE`. The runnable script is [`docs/sql/verify-core-constraints.sql`](./sql/verify-core-constraints.sql); 33/33 assertions pass on a fresh database, and the 25-way concurrency race in [§13.1](#131-the-test-that-matters-most) admits exactly one booking. Re-run it after any migration that touches `reservations`, `payments` or the ledger.

Workflow for a schema change:

```bash
# 1. Edit schema.prisma
# 2. Generate the migration WITHOUT applying it
npx prisma migrate dev --create-only --name add_something
# 3. Open the generated SQL, add the hand-written DDL below it
# 4. Apply
npx prisma migrate dev
```

### 5.1 Extensions and helpers

`prisma/migrations/0001_init_extensions/migration.sql`

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- required: lets GiST index scalar = alongside range &&
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Time-ordered primary keys without the pg_uuidv7 extension, which managed
-- Postgres does not offer. Takes a v4 UUID (already the right variant), overlays
-- a millisecond timestamp over the first 48 bits, flips the version nibble to 7.
CREATE OR REPLACE FUNCTION uuid_generate_v7()
RETURNS uuid
LANGUAGE plpgsql VOLATILE PARALLEL SAFE AS $$
BEGIN
  RETURN encode(
    set_bit(
      set_bit(
        overlay(
          uuid_send(gen_random_uuid())
          PLACING substring(
            int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3
          )
          FROM 1 FOR 6
        ),
        52, 1
      ),
      53, 1
    ),
    'hex'
  )::uuid;
END;
$$;

-- The business day: calendar date in Dubai, shifted back 6 hours so a 01:30
-- session belongs to the previous trading day. Marked IMMUTABLE and it genuinely
-- is: the timezone name is a literal, not a session setting.
CREATE OR REPLACE FUNCTION business_day(ts timestamptz)
RETURNS date
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT ((ts AT TIME ZONE 'Asia/Dubai') - interval '6 hours')::date;
$$;

-- Case-insensitive unique email for live users only.
CREATE UNIQUE INDEX users_email_unique_active
  ON users (lower(email))
  WHERE deleted_at IS NULL;
```

### 5.2 The double-booking constraint

This is the heart of the system. Three separate exclusion constraints, all on the same GiST index machinery.

`prisma/migrations/0002_reservation_exclusion/migration.sql`

```sql
-- 1. A therapist cannot be in two places at once.
ALTER TABLE reservations
  ADD CONSTRAINT reservations_no_therapist_overlap
  EXCLUDE USING gist (
    branch_id   WITH =,
    employee_id WITH =,
    tstzrange(starts_at, blocked_until, '[)') WITH &&
  )
  WHERE (status IN ('SCHEDULED', 'IN_PROGRESS'));

-- 2. A room cannot hold two guests at once.
--    room_id IS NULL rows are skipped automatically: NULL = NULL is never true,
--    so services that need no room never conflict.
ALTER TABLE reservations
  ADD CONSTRAINT reservations_no_room_overlap
  EXCLUDE USING gist (
    branch_id WITH =,
    room_id   WITH =,
    tstzrange(starts_at, blocked_until, '[)') WITH &&
  )
  WHERE (status IN ('SCHEDULED', 'IN_PROGRESS') AND room_id IS NOT NULL);

-- 3. A guest cannot be booked into two overlapping treatments.
--    Catches the classic reception double-entry.
ALTER TABLE reservations
  ADD CONSTRAINT reservations_no_guest_overlap
  EXCLUDE USING gist (
    branch_id WITH =,
    guest_id  WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  )
  WHERE (status IN ('SCHEDULED', 'IN_PROGRESS') AND guest_id IS NOT NULL);

ALTER TABLE reservations
  ADD CONSTRAINT reservations_positive_duration CHECK (duration_minutes > 0),
  ADD CONSTRAINT reservations_ends_after_starts  CHECK (ends_at > starts_at),
  ADD CONSTRAINT reservations_blocked_after_ends CHECK (blocked_until >= ends_at),
  ADD CONSTRAINT reservations_nonneg_base        CHECK (base_cost_fils >= 0);
```

Notes on the details, because each one is load-bearing:

- **`'[)'` — half-open range.** A 13:00–14:00 booking and a 14:00–15:00 booking do not overlap. With the default `'[]'` they would, and reception would be unable to book back-to-back sessions.
- **`blocked_until`, not `ends_at`, for therapist and room.** Turnaround time is real. The room needs cleaning; the therapist needs five minutes. Guests are excluded on `ends_at` because the guest is free the moment their treatment ends.
- **`WHERE status IN (...)`** — a cancelled or no-show booking releases its slot immediately. Without this partial predicate, a cancellation would keep blocking the calendar forever.
- **`branch_id WITH =`** — inert today with one branch, correct on the day there are two.

### 5.3 Derived columns and the state machine

`prisma/migrations/0003_reservation_triggers/migration.sql`

```sql
-- ── Derived columns ────────────────────────────────────────────────
-- ends_at, blocked_until and business_day are ALWAYS computed here.
-- Anything the application sends for these three columns is overwritten.
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

-- ── Status state machine ───────────────────────────────────────────
-- Defence in depth. The service layer enforces this too, but a bad
-- migration script or a console session should not be able to move a
-- COMPLETED reservation back to SCHEDULED.
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
```

State machine, for reference:

```
                  ┌──────────────┐
                  │  SCHEDULED   │
                  └──┬────┬────┬─┘
        check-in     │    │    │  no-show
          ┌──────────┘    │    └──────────┐
          ▼               ▼ cancel        ▼
   ┌─────────────┐  ┌───────────┐  ┌───────────┐
   │ IN_PROGRESS │  │ CANCELLED │  │  NO_SHOW  │
   └──┬───────┬──┘  └───────────┘  └───────────┘
      │       └──────────┐ cancel (MANAGER+, triggers refund path)
      ▼ checkout         ▼
 ┌───────────┐     ┌───────────┐
 │ COMPLETED │     │ CANCELLED │
 └───────────┘     └───────────┘
```

`COMPLETED`, `CANCELLED` and `NO_SHOW` are terminal.

### 5.4 Append-only enforcement

An audit log that can be edited is not an audit log. Three tables are locked down at the database level so that even a compromised API key or a careless console session cannot rewrite history.

`prisma/migrations/0004_append_only/migration.sql`

```sql
CREATE OR REPLACE FUNCTION forbid_mutation()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    '% is append-only; correct by inserting a reversing row, never by % ',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- financial_audit_log: absolutely immutable.
CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON financial_audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON financial_audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- therapist_payout_ledger: immutable except for attaching a payout batch,
-- which is how a pending accrual becomes a paid one.
CREATE OR REPLACE FUNCTION ledger_guard()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'therapist_payout_ledger rows are never deleted; insert a REVERSAL'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
    IF NEW.payout_batch_id IS DISTINCT FROM OLD.payout_batch_id
       AND OLD.payout_batch_id IS NULL
       AND ROW(NEW.branch_id, NEW.employee_id, NEW.entry_type, NEW.amount_fils,
               NEW.business_day, NEW.reservation_id, NEW.tip_id, NEW.created_by_user_id,
               NEW.created_at)
         IS NOT DISTINCT FROM
           ROW(OLD.branch_id, OLD.employee_id, OLD.entry_type, OLD.amount_fils,
               OLD.business_day, OLD.reservation_id, OLD.tip_id, OLD.created_by_user_id,
               OLD.created_at)
    THEN
      RETURN NEW;  -- only payout_batch_id changed, from NULL. Allowed.
    END IF;

    RAISE EXCEPTION 'therapist_payout_ledger amounts are immutable; insert a REVERSAL'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_ledger_guard BEFORE UPDATE OR DELETE ON therapist_payout_ledger
  FOR EACH ROW EXECUTE FUNCTION ledger_guard();

-- payments: never edited, never deleted. A mistake is corrected by a REFUND
-- or ADJUSTMENT row pointing back via reverses_payment_id.
CREATE TRIGGER trg_payments_no_update BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER trg_payments_no_delete BEFORE DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
```

> Because `payments` is `BEFORE UPDATE`-blocked, Prisma's `update` and `upsert` on that model will throw. This is intentional. The repository layer exposes `create` only, and the service layer has no code path that tries to update a payment.
>
> The guard is strong enough that a **migration** trips over it too. Adding a column is DDL and passes freely, but back-filling that column is an ordinary `UPDATE` and is refused. A migration that needs to back-fill must suspend the trigger for that one statement, inside its own transaction, and restore it immediately — as `20260916210000_payment_created_at` does, with the reasoning written at the call site. Wanting to suspend it for anything larger than back-filling a newly added column is the signal to stop and write a reversing entry instead.

### 5.5 Handling the constraint violation in application code

The database rejects the conflict. The API's job is to turn `23P01` into something a receptionist understands.

```ts
// apps/api/src/common/prisma-error.filter.ts
import { Catch, ExceptionFilter, ArgumentsHost, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

const PG_EXCLUSION_VIOLATION = '23P01';

const CONSTRAINT_MESSAGES: Record<string, { code: string; message: string }> = {
  reservations_no_therapist_overlap: {
    code: 'THERAPIST_ALREADY_BOOKED',
    message: 'That therapist already has a booking overlapping this time.',
  },
  reservations_no_room_overlap: {
    code: 'ROOM_ALREADY_BOOKED',
    message: 'That room is already in use during this time.',
  },
  reservations_no_guest_overlap: {
    code: 'GUEST_ALREADY_BOOKED',
    message: 'This guest already has a treatment booked at this time.',
  },
};

@Catch(Prisma.PrismaClientKnownRequestError, Prisma.PrismaClientUnknownRequestError)
export class PrismaErrorFilter implements ExceptionFilter {
  catch(err: any, host: ArgumentsHost) {
    // Prisma surfaces exclusion violations as P2010 (raw) or as an unknown
    // request error; the driver error code is in err.meta?.code or the message.
    const raw = `${err.meta?.code ?? ''} ${err.message ?? ''}`;

    if (raw.includes(PG_EXCLUSION_VIOLATION)) {
      const hit = Object.keys(CONSTRAINT_MESSAGES).find((name) => raw.includes(name));
      const mapped = hit
        ? CONSTRAINT_MESSAGES[hit]
        : { code: 'SLOT_CONFLICT', message: 'That slot is no longer available.' };
      throw new ConflictException({ error: { ...mapped } });
    }

    throw err;
  }
}
```

**There is no "check then insert".** The service layer does not query for conflicts before writing — that pattern has a race window and will double-book on a busy Friday when two receptionists tap Confirm at the same moment. It inserts, and lets the constraint arbitrate. The availability grid in the UI is a *hint*; the constraint is the *truth*.

### 5.6 Retention job

`prisma/migrations/0005_retention/migration.sql`

```sql
-- Strips identifying fields from attribution snapshots past the 90-day window
-- while keeping the aggregate channel data that reporting needs. Run daily.
CREATE OR REPLACE FUNCTION prune_attribution(retention_days int DEFAULT 90)
RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  n int;
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
           landing_path = NULL,
           pruned_at   = now()
     WHERE pruned_at IS NULL
       AND captured_at < now() - make_interval(days => retention_days)
    RETURNING 1
  )
  SELECT count(*) INTO n FROM pruned;

  DELETE FROM outbound_clicks
   WHERE created_at < now() - make_interval(days => retention_days);

  DELETE FROM idempotency_records WHERE expires_at < now();

  RETURN n;
END;
$$;
```

Scheduled with `pg_cron` on Supabase:

```sql
SELECT cron.schedule('prune-attribution', '30 3 * * *', $$SELECT prune_attribution(90)$$);
```

03:30 UTC is 07:30 Dubai — after the spa closes, before the morning shift.

---

## 6. Authentication, Sessions and RBAC

### 6.1 Password storage

**bcrypt, cost factor 12.** At cost 12 a hash takes roughly 250 ms on a modern server — slow enough to make offline cracking expensive, fast enough that a receptionist logging in at the start of a shift does not notice.

```ts
// apps/api/src/auth/password.service.ts
import * as bcrypt from 'bcrypt';

const COST = 12;

export class PasswordService {
  hash(plain: string) {
    return bcrypt.hash(plain, COST);
  }

  compare(plain: string, hash: string) {
    return bcrypt.compare(plain, hash);
  }

  /** Re-hash on successful login if the stored cost has drifted below COST. */
  needsRehash(hash: string) {
    const cost = Number(hash.split('$')[2]);
    return Number.isFinite(cost) && cost < COST;
  }
}
```

Policy, enforced by a zod schema in `packages/contracts`:

- Minimum 12 characters. No composition rules (no "must contain a symbol") — length beats character-class theatre.
- Checked against a bundled list of the 10,000 most common passwords.
- New accounts are created with `mustChangePassword = true`; the API returns `403 PASSWORD_CHANGE_REQUIRED` for every endpoint except `POST /auth/change-password` until it is cleared.
- Five failed attempts sets `lockedUntil = now() + 15 minutes`. The counter resets on success.

> **Note on bcrypt's 72-byte limit.** bcrypt silently truncates input past 72 bytes. With a 12-character minimum this is not reachable in practice for Latin passwords, but the zod schema caps length at 64 characters so it can never surprise anyone. Argon2id is the better primitive and is the recommended migration for v2 — `needsRehash` above is the hook that makes a transparent migration possible without forcing a password reset.

### 6.2 Tokens

Two tokens, different jobs.

| | Access token | Refresh token |
|---|---|---|
| Format | JWT, HS256 | Opaque 256-bit random, base64url |
| Lifetime | 15 minutes | 7 days |
| Storage (dashboard) | In memory only — never `localStorage` | `HttpOnly; Secure; SameSite=Strict` cookie |
| Stored server-side? | No | Yes — SHA-256 hash in `refresh_tokens` |
| Revocable? | No (short life is the mitigation) | Yes, immediately |

Access token payload:

```json
{
  "sub":   "0192f8a1-...",
  "role":  "RECEPTIONIST",
  "bid":   "0192aaaa-...",
  "eid":   "0192bbbb-...",
  "jti":   "0192cccc-...",
  "iat":   1789000000,
  "exp":   1789000900
}
```

`bid` is the branch. Every query in the service layer filters on it, taken from the token and never from the request body — a receptionist cannot read another branch's data by editing a payload.

`eid` is the linked employee, present only for `THERAPIST` logins; it scopes the self-service endpoints.

`JWT_SECRET` is a 32-byte random value from the secret manager, rotated annually. Rotation is supported by accepting two secrets during a 24-hour overlap window.

### 6.3 Refresh rotation with reuse detection

Every refresh consumes the old token and issues a new one in the same *family*. If a token that has already been used is presented again, the whole family is revoked — the user is logged out everywhere and the event is written to the audit log. That is the signature of a stolen token.

```ts
// apps/api/src/auth/auth.service.ts (core of the rotation)
async refresh(rawToken: string, ctx: RequestContext) {
  const tokenHash = sha256(rawToken);

  return this.prisma.$transaction(async (tx) => {
    const existing = await tx.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!existing) throw new UnauthorizedException({ error: { code: 'INVALID_REFRESH_TOKEN' } });

    // Reuse detection: this token was already rotated away or explicitly revoked.
    if (existing.revokedAt) {
      await tx.refreshToken.updateMany({
        where: { familyId: existing.familyId, revokedAt: null },
        data:  { revokedAt: new Date() },
      });
      await this.audit.write(tx, {
        action: 'AUTH_REFRESH_REUSE_DETECTED',
        entityType: 'User',
        entityId: existing.userId,
        afterState: { familyId: existing.familyId },
        ...ctx,
      });
      throw new UnauthorizedException({ error: { code: 'REFRESH_TOKEN_REUSED' } });
    }

    if (existing.expiresAt < new Date()) {
      throw new UnauthorizedException({ error: { code: 'REFRESH_TOKEN_EXPIRED' } });
    }
    if (!existing.user.isActive || existing.user.deletedAt) {
      throw new UnauthorizedException({ error: { code: 'ACCOUNT_DISABLED' } });
    }

    const next = await tx.refreshToken.create({
      data: {
        userId:    existing.userId,
        familyId:  existing.familyId,          // same lineage
        tokenHash: sha256(rawNext),
        expiresAt: addDays(new Date(), 7),
        userAgent: ctx.userAgent,
        ipAddress: ctx.ipAddress,
      },
    });

    await tx.refreshToken.update({
      where: { id: existing.id },
      data:  { revokedAt: new Date(), replacedById: next.id },
    });

    return { accessToken: this.signAccess(existing.user), refreshToken: rawNext };
  });
}
```

`POST /auth/logout` revokes the presented token's entire family. A `MANAGER` or `OWNER` can revoke every session for any user via `POST /users/:id/revoke-sessions` — this is what you press when a therapist's phone is lost.

### 6.4 The role matrix

Four roles. The interesting boundary is **RECEPTIONIST vs MANAGER**: reception must be able to take money all evening without ever seeing the totals, because the person handling cash should not also be the person auditing it.

| Capability | OWNER | MANAGER | RECEPTIONIST | THERAPIST |
|---|:--:|:--:|:--:|:--:|
| View today's booking grid | ✅ | ✅ | ✅ | own only |
| View the service menu, prices and rooms | ✅ | ✅ | ✅ | ✅ |
| View the shift roster | ✅ | ✅ | ✅ | own only |
| Create / reschedule / cancel a reservation | ✅ | ✅ | ✅ | ❌ |
| Check in (take base payment) | ✅ | ✅ | ✅ | ❌ |
| Check out (record tip) | ✅ | ✅ | ✅ | ❌ |
| Mark no-show | ✅ | ✅ | ✅ | ❌ |
| Cancel an `IN_PROGRESS` reservation | ✅ | ✅ | ❌ | ❌ |
| Issue a refund or adjustment | ✅ | ✅ | ❌ | ❌ |
| Void / reverse a tip | ✅ | ✅ | ❌ | ❌ |
| See **own** shift + earnings | ✅ | ✅ | ❌ | ✅ |
| See **any** therapist's earnings | ✅ | ✅ | ❌ | ❌ |
| Daily / monthly revenue reports | ✅ | ✅ | ❌ | ❌ |
| Attribution & channel ROI reports | ✅ | ✅ | ❌ | ❌ |
| Approve and record a payout batch | ✅ | ✅ | ❌ | ❌ |
| Read the financial audit log | ✅ | ✅ | ❌ | ❌ |
| Edit the service catalogue and prices | ✅ | ✅ | ❌ | ❌ |
| Manage employees | ✅ | ✅ | ❌ | ❌ |
| Create / disable users, reset passwords | ✅ | ❌ | ❌ | ❌ |
| Export guest data / process an erasure request | ✅ | ✅ | ❌ | ❌ |
| Read an employee record | ✅ | ✅ | ❌ | own only |
| View `Employee.legalName` | ✅ | ✅ | ❌ | own only |

> **Why reception can read the catalogue and the roster.** An earlier draft put
> `/services` and `/rooms` at MANAGER+, alongside the reports. That leaves
> reception unable to quote a price or pick a room — unable to take a booking at
> all. A price list is not a revenue total, and *totals* are what this matrix
> exists to defend: what the business earned, what a therapist is owed, what the
> night added up to. Reading the menu crosses none of it. The same reasoning
> opens the shift roster, because reception must find a therapist's shift to
> clock them in, and a shift row carries no money.

### 6.5 Guard implementation

`JwtAuthGuard` is registered globally; endpoints opt out with `@Public()`. `RolesGuard` runs after it.

```ts
// apps/api/src/auth/roles.decorator.ts
export const ROLES_KEY = 'roles';
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

// apps/api/src/auth/roles.guard.ts
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required?.length) return true;

    const { user } = ctx.switchToHttp().getRequest();
    if (!user) throw new UnauthorizedException();
    if (!required.includes(user.role)) {
      throw new ForbiddenException({
        error: { code: 'INSUFFICIENT_ROLE', message: 'Your account cannot perform this action.' },
      });
    }
    return true;
  }
}
```

Usage:

```ts
@Controller('reports')
@Roles(UserRole.OWNER, UserRole.MANAGER)   // the whole controller is financial
export class ReportsController {
  @Get('daily') daily(@Query() q: DailyReportQuery, @CurrentUser() u: AuthUser) {
    return this.reports.daily(u.branchId, q);   // branchId from the token, never the query
  }
}
```

### 6.6 Branch scoping is not optional

Every repository method takes `branchId` as its first argument, sourced from `req.user.bid`. There is no code path where a branch id arrives from the client. With one branch this is invisible; the day a second branch opens it is the difference between a config change and a security incident.

A Prisma client extension enforces it mechanically so nobody has to remember:

```ts
// apps/api/src/prisma/branch-scope.extension.ts
const BRANCH_SCOPED = new Set([
  'Reservation', 'BookingRequest', 'Payment', 'Tip', 'Guest',
  'Employee', 'Shift', 'Room', 'Service', 'TherapistPayoutLedger',
  'PayoutBatch', 'FinancialAuditLog',
]);

export const branchScope = (branchId: string) =>
  Prisma.defineExtension((client) =>
    client.$extends({
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            if (!model || !BRANCH_SCOPED.has(model)) return query(args);
            if (operation.startsWith('find') || operation === 'count' || operation === 'aggregate') {
              args.where = { ...(args.where ?? {}), branchId };
            }
            if (operation === 'create') {
              args.data = { ...args.data, branchId };
            }
            return query(args);
          },
        },
      },
    }),
  );
```

The extension is applied per-request from an interceptor. It is a safety net, not a licence to be careless — service methods still pass `branchId` explicitly.

---

## 7. API Surface

Base URL: `https://api.berelax.ae/v1`. Every response is JSON. Every authenticated request carries `Authorization: Bearer <access token>`.

### 7.1 Public — no authentication

Rate limited to 10 requests per minute per IP, 60 per hour. Protected by a Cloudflare Turnstile token on the form endpoints.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/public/booking-requests` | Website booking form → `booking_requests` row. Body carries the attribution blob. |
| `POST` | `/public/attribution/touch` | Beacon from `attribution.js` on each new touch. Fire-and-forget, returns `204`. |
| `GET` | `/public/services` | Live menu with prices, for rendering the site's pricing section from the database. |
| `GET` | `/r/wa` | Logs an `outbound_clicks` row, then `302` to `https://wa.me/...`. See [§10.4](#104-tracking-the-whatsapp-click). |
| `GET` | `/r/call` | Same, for the phone buttons. |
| `GET` | `/health` | Liveness. |

### 7.2 Auth

| Method | Path | Role |
|---|---|---|
| `POST` | `/auth/login` | public |
| `POST` | `/auth/refresh` | public (cookie) |
| `POST` | `/auth/logout` | any |
| `POST` | `/auth/change-password` | any |
| `GET` | `/auth/me` | any |
| `POST` | `/users` | OWNER |
| `PATCH` | `/users/:id` | OWNER |
| `POST` | `/users/:id/reset-password` | OWNER |
| `POST` | `/users/:id/revoke-sessions` | OWNER, MANAGER |

### 7.3 Operations

| Method | Path | Role | Notes |
|---|---|---|---|
| `GET` | `/reservations` | all staff | Filter by `businessDay`, `employeeId`, `status`. THERAPIST sees only their own. |
| `GET` | `/reservations/:id` | all staff | |
| `POST` | `/reservations` | RECEPTIONIST+ | Creates a confirmed booking. `409` on conflict. |
| `PATCH` | `/reservations/:id` | RECEPTIONIST+ | Reschedule / reassign. Same `409` behaviour. |
| `POST` | `/reservations/:id/check-in` | RECEPTIONIST+ | **[§8.2](#82-step-1--check-in)** |
| `POST` | `/reservations/:id/checkout` | RECEPTIONIST+ | **[§8.3](#83-step-2--checkout)** |
| `POST` | `/reservations/:id/cancel` | RECEPTIONIST+ (MANAGER+ if `IN_PROGRESS`) | |
| `POST` | `/reservations/:id/no-show` | RECEPTIONIST+ | |
| `GET` | `/availability` | all staff | Grid of free slots. A **hint** — see [§5.5](#55-handling-the-constraint-violation-in-application-code). |
| `GET` | `/booking-requests` | RECEPTIONIST+ | Inbox. |
| `POST` | `/booking-requests/:id/convert` | RECEPTIONIST+ | Creates the reservation and carries the attribution across. |
| `POST` | `/booking-requests/:id/decline` | RECEPTIONIST+ | |
| `GET`/`POST`/`PATCH` | `/guests` | RECEPTIONIST+ | |
| `GET`/`POST`/`PATCH` | `/employees` | MANAGER+ | |
| `GET`/`POST`/`PATCH` | `/services`, `/rooms` | MANAGER+ | |
| `GET`/`POST`/`PATCH` | `/shifts` | MANAGER+ | |
| `POST` | `/shifts/:id/clock-in`, `/clock-out` | RECEPTIONIST+ | |

### 7.4 Money and reporting

| Method | Path | Role |
|---|---|---|
| `POST` | `/payments/:id/refund` | MANAGER+ |
| `POST` | `/tips/:id/reverse` | MANAGER+ |
| `GET` | `/ledger/:employeeId` | MANAGER+, or THERAPIST for self |
| `GET` | `/ledger/:employeeId/balance` | MANAGER+, or THERAPIST for self |
| `POST` | `/payouts` | MANAGER+ |
| `POST` | `/payouts/:id/acknowledge` | THERAPIST (self) |
| `GET` | `/reports/daily` | MANAGER+ |
| `GET` | `/reports/revenue` | MANAGER+ |
| `GET` | `/reports/therapist-utilisation` | MANAGER+ |
| `GET` | `/reports/tips` | MANAGER+ |
| `GET` | `/reports/attribution` | MANAGER+ |
| `GET` | `/audit` | MANAGER+ |

### 7.5 Compliance

| Method | Path | Role |
|---|---|---|
| `GET` | `/guests/:id/export` | MANAGER+ |
| `POST` | `/guests/:id/erase` | MANAGER+ |
| `POST` | `/guests/:id/consents` | RECEPTIONIST+ |

### 7.6 Idempotency

Every `POST` that moves money **must** carry an `Idempotency-Key` header (a client-generated UUID). A global interceptor stores the first response against the key for 24 hours and replays it on a repeat.

This is not academic. Reception runs on an iPad over patchy Wi-Fi at 01:00. A request times out, the receptionist taps Confirm again, and without idempotency the guest is charged twice.

```ts
// apps/api/src/common/idempotency.interceptor.ts — behaviour
// 1. No key on a money endpoint            → 400 IDEMPOTENCY_KEY_REQUIRED
// 2. Key seen, same body hash, complete    → replay the stored response
// 3. Key seen, DIFFERENT body hash         → 409 IDEMPOTENCY_KEY_REUSED
// 4. Key seen, still in flight             → 409 REQUEST_IN_PROGRESS
// 5. New key                               → execute, store {status, body}, return
```

---

## 8. The Two-Step Financial Workflow

This is the part of the system that has to match how the spa actually runs, not how booking software usually assumes a business runs.

### 8.1 Why two steps

Base payment is taken **before** the treatment. The tip is decided **after**, when the guest knows whether they liked it. Those two events are separated by 60 or 90 minutes and, often, by a shift change at reception. Collapsing them into one "complete the booking, here's the total" screen would force staff to either guess the tip up front or re-open a closed transaction — and re-opening closed financial records is exactly what the audit log exists to prevent.

```
   Guest arrives                Treatment runs              Guest leaves
        │                              │                          │
        ▼                              │                          ▼
 ┌──────────────┐                      │                  ┌──────────────┐
 │  CHECK-IN    │                      │                  │  CHECKOUT    │
 ├──────────────┤                      │                  ├──────────────┤
 │ arrival time │                      │                  │ completion   │
 │ BASE payment │                      │                  │ TIP (opt.)   │
 │  (card/cash) │                      │                  │ ledger entry │
 │              │                      │                  │              │
 │ SCHEDULED    │                      │                  │ IN_PROGRESS  │
 │      ↓       │                      │                  │      ↓       │
 │ IN_PROGRESS  │                      │                  │  COMPLETED   │
 └──────────────┘                      │                  └──────────────┘
```

### 8.2 Step 1 — Check-in

```http
POST /v1/reservations/0192f8a1-.../check-in
Authorization: Bearer <token>
Idempotency-Key: 8f14e45f-ea3b-4f2c-9a1d-7c9b2e5a0d33
Content-Type: application/json

{
  "actualArrivalAt": "2026-09-16T19:04:00+04:00",
  "basePayments": [
    { "method": "CARD", "amountFils": 20000, "externalRef": "TRM-88213" },
    { "method": "CASH", "amountFils": 5000 }
  ],
  "note": "Guest paid AED 50 cash, rest on card"
}
```

**Validation:**

| Rule | Failure code |
|---|---|
| Reservation exists in this branch | `404 RESERVATION_NOT_FOUND` |
| `status = SCHEDULED` | `409 RESERVATION_NOT_SCHEDULED` |
| `sum(basePayments.amountFils) == reservation.baseCostFils` | `422 BASE_PAYMENT_MISMATCH` |
| Every `amountFils > 0` | `422 INVALID_AMOUNT` |
| `COMPLIMENTARY` used only by MANAGER+, and then it must be the sole line | `403 INSUFFICIENT_ROLE` |
| `actualArrivalAt` within ±12 h of `startsAt` | `422 ARRIVAL_TIME_IMPLAUSIBLE` |

Split payment across methods is supported because guests genuinely do pay part cash, part card. The sum must reconcile exactly to `baseCostFils` — a short payment is a discount, and a discount is a manager decision recorded as an `ADJUSTMENT`, not a quiet under-collection at the desk.

**Transaction:**

```ts
// apps/api/src/reservations/check-in.handler.ts
async checkIn(id: string, dto: CheckInDto, actor: AuthUser, ctx: RequestContext) {
  return this.prisma.$transaction(async (tx) => {
    // Lock the row so two receptionists cannot check the same guest in twice.
    //
    // Take the lock with raw SQL, then read through the typed client inside the
    // SAME transaction. $queryRaw returns the database's own column names, so a
    // `SELECT *` mapped to Reservation would hand you base_cost_fils and leave
    // reservation.baseCostFils undefined — a silent zero in a money comparison.
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM reservations
       WHERE id = ${id}::uuid AND branch_id = ${actor.branchId}::uuid
       FOR UPDATE`;

    if (locked.length === 0) throw new NotFoundException({ error: { code: 'RESERVATION_NOT_FOUND' } });
    const reservation = await tx.reservation.findUniqueOrThrow({ where: { id } });
    if (reservation.status !== 'SCHEDULED') {
      throw new ConflictException({
        error: { code: 'RESERVATION_NOT_SCHEDULED', details: { status: reservation.status } },
      });
    }

    const total = dto.basePayments.reduce((s, p) => s + p.amountFils, 0);
    if (total !== reservation.baseCostFils) {
      throw new UnprocessableEntityException({
        error: {
          code: 'BASE_PAYMENT_MISMATCH',
          message: `Collected ${formatAed(total)} but the service costs ${formatAed(reservation.baseCostFils)}.`,
          details: { expectedFils: reservation.baseCostFils, receivedFils: total },
        },
      });
    }

    const arrivedAt = dto.actualArrivalAt ?? new Date();
    const day = businessDay(arrivedAt);

    await tx.payment.createMany({
      data: dto.basePayments.map((p, i) => ({
        branchId:          actor.branchId,
        reservationId:     reservation.id,
        kind:              'BASE' as const,
        method:            p.method,
        amountFils:        p.amountFils,
        businessDay:       day,
        collectedByUserId: actor.id,
        collectedAt:       arrivedAt,
        externalRef:       p.externalRef ?? null,
        note:              dto.note ?? null,
        // Derive a per-line key so a replayed request cannot insert twice.
        idempotencyKey:    `${ctx.idempotencyKey}:base:${i}`,
      })),
    });

    const updated = await tx.reservation.update({
      where: { id: reservation.id },
      data:  { status: 'IN_PROGRESS', actualArrivalAt: arrivedAt },
    });

    // Commission accrues on the base service, if the therapist is on commission.
    const employee = await tx.employee.findUniqueOrThrow({ where: { id: reservation.employeeId } });
    if (employee.commissionBps > 0) {
      await tx.therapistPayoutLedger.create({
        data: {
          branchId:        actor.branchId,
          employeeId:      employee.id,
          entryType:       'COMMISSION_ACCRUAL',
          amountFils:      Math.round((reservation.baseCostFils * employee.commissionBps) / 10_000),
          businessDay:     day,
          reservationId:   reservation.id,
          createdByUserId: actor.id,
          note:            `Commission ${employee.commissionBps / 100}% on ${reservation.ref}`,
        },
      });
    }

    await this.audit.write(tx, {
      action:      'RESERVATION_CHECK_IN',
      entityType:  'Reservation',
      entityId:    reservation.id,
      beforeState: pickAuditFields(reservation),
      afterState:  pickAuditFields(updated),
      amountFils:  total,
      ...ctx,
    });

    return this.present(updated);
  });
}
```

**Response `200`:**

```json
{
  "id": "0192f8a1-...",
  "ref": "BR-2026-0417",
  "status": "IN_PROGRESS",
  "actualArrivalAt": "2026-09-16T19:04:00+04:00",
  "baseCostFils": 25000,
  "basePaidFils": 25000,
  "payments": [
    { "id": "0192f8b2-...", "kind": "BASE", "method": "CARD", "amountFils": 20000 },
    { "id": "0192f8b3-...", "kind": "BASE", "method": "CASH", "amountFils": 5000 }
  ]
}
```

### 8.3 Step 2 — Checkout

```http
POST /v1/reservations/0192f8a1-.../checkout
Authorization: Bearer <token>
Idempotency-Key: 2b7c9d10-3e4f-4a5b-8c6d-1f2e3a4b5c6d
Content-Type: application/json

{
  "completedAt": "2026-09-16T20:12:00+04:00",
  "tip": {
    "amountFils": 5000,
    "type": "COLLECTED_BY_BUSINESS",
    "method": "CARD",
    "externalRef": "TRM-88240"
  }
}
```

`tip` is **nullable** — most checkouts are `{ "tip": null }` and that is a perfectly valid, fully recorded outcome.

**Validation:**

| Rule | Failure code |
|---|---|
| `status = IN_PROGRESS` | `409 RESERVATION_NOT_IN_PROGRESS` |
| Base payment fully settled | `409 BASE_PAYMENT_OUTSTANDING` |
| `tip.amountFils > 0` when `tip` present | `422 INVALID_AMOUNT` |
| `tip.method` required **iff** `type = COLLECTED_BY_BUSINESS` | `422 TIP_METHOD_REQUIRED` / `TIP_METHOD_NOT_ALLOWED` |
| `tip.amountFils <= baseCostFils × 3` | `422 TIP_EXCEEDS_SANITY_LIMIT` (MANAGER+ can override with `"confirmLargeTip": true`) |
| `completedAt >= actualArrivalAt` | `422 COMPLETION_BEFORE_ARRIVAL` |

**The branch that matters:**

```ts
async checkout(id: string, dto: CheckoutDto, actor: AuthUser, ctx: RequestContext) {
  return this.prisma.$transaction(async (tx) => {
    // Lock raw, read typed — see the note in check-in above.
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM reservations
       WHERE id = ${id}::uuid AND branch_id = ${actor.branchId}::uuid
       FOR UPDATE`;

    if (locked.length === 0) throw new NotFoundException({ error: { code: 'RESERVATION_NOT_FOUND' } });
    const reservation = await tx.reservation.findUniqueOrThrow({ where: { id } });
    if (reservation.status !== 'IN_PROGRESS') {
      throw new ConflictException({ error: { code: 'RESERVATION_NOT_IN_PROGRESS' } });
    }

    const completedAt = dto.completedAt ?? new Date();
    const day = businessDay(completedAt);
    let tipRecord: Tip | null = null;

    if (dto.tip) {
      // ── Mode A: the business collects the tip. It now OWES the therapist. ──
      if (dto.tip.type === 'COLLECTED_BY_BUSINESS') {
        const payment = await tx.payment.create({
          data: {
            branchId:          actor.branchId,
            reservationId:     reservation.id,
            kind:              'TIP',
            method:            dto.tip.method!,
            amountFils:        dto.tip.amountFils,
            businessDay:       day,
            collectedByUserId: actor.id,
            collectedAt:       completedAt,
            externalRef:       dto.tip.externalRef ?? null,
            idempotencyKey:    `${ctx.idempotencyKey}:tip`,
          },
        });

        tipRecord = await tx.tip.create({
          data: {
            branchId:         actor.branchId,
            reservationId:    reservation.id,
            employeeId:       reservation.employeeId,
            type:             'COLLECTED_BY_BUSINESS',
            amountFils:       dto.tip.amountFils,
            method:           dto.tip.method,
            paymentId:        payment.id,
            businessDay:      day,
            recordedByUserId: actor.id,
            recordedAt:       completedAt,
          },
        });

        // The liability. This is the ONLY place a tip becomes payable.
        await tx.therapistPayoutLedger.create({
          data: {
            branchId:        actor.branchId,
            employeeId:      reservation.employeeId,
            entryType:       'TIP_ACCRUAL',
            amountFils:      dto.tip.amountFils,      // positive: owed to the therapist
            businessDay:     day,
            reservationId:   reservation.id,
            tipId:           tipRecord.id,
            createdByUserId: actor.id,
            note:            `Tip collected by business on ${reservation.ref}`,
          },
        });

      // ── Mode B: cash straight to the therapist. Recorded, but no liability. ──
      } else {
        tipRecord = await tx.tip.create({
          data: {
            branchId:         actor.branchId,
            reservationId:    reservation.id,
            employeeId:       reservation.employeeId,
            type:             'DIRECT_CASH',
            amountFils:       dto.tip.amountFils,
            method:           null,            // never touched the till
            paymentId:        null,            // no payment row: no money entered the business
            businessDay:      day,
            recordedByUserId: actor.id,
            recordedAt:       completedAt,
          },
        });
        // Deliberately NO ledger entry. See §9.2.
      }
    }

    const updated = await tx.reservation.update({
      where: { id: reservation.id },
      data:  { status: 'COMPLETED', completedAt },
    });

    await this.audit.write(tx, {
      action:      'RESERVATION_CHECKOUT',
      entityType:  'Reservation',
      entityId:    reservation.id,
      beforeState: pickAuditFields(reservation),
      afterState:  { ...pickAuditFields(updated), tip: tipRecord && pickAuditFields(tipRecord) },
      amountFils:  dto.tip?.amountFils ?? 0,
      ...ctx,
    });

    return this.present(updated, { tip: tipRecord });
  });
}
```

**Response `200`:**

```json
{
  "id": "0192f8a1-...",
  "ref": "BR-2026-0417",
  "status": "COMPLETED",
  "completedAt": "2026-09-16T20:12:00+04:00",
  "totals": {
    "baseCollectedFils": 25000,
    "tipFils": 5000,
    "tipType": "COLLECTED_BY_BUSINESS",
    "businessReceivedFils": 30000,
    "therapistOwedFromThisVisitFils": 5000
  }
}
```

### 8.4 What the receptionist actually sees

Two taps, not a form. The checkout sheet offers **No tip** / **Cash to therapist** / **Added to bill**, with an amount pad for the latter two. `No tip` is the default and requires one tap to confirm — because a checkout that is easy to skip is a checkout that gets skipped, and a reservation stuck in `IN_PROGRESS` overnight is a bad report tomorrow.

An `IN_PROGRESS` reservation whose `blockedUntil` passed more than 2 hours ago is flagged red on the grid with a **Needs checkout** badge, and appears in the manager's end-of-day close-out list.

---

## 9. Tips, the Payout Ledger and the Audit Trail

### 9.1 The distinction that makes the whole design work

A tip is not one thing. It is two things that happen to share a word:

| | `DIRECT_CASH` | `COLLECTED_BY_BUSINESS` |
|---|---|---|
| Who holds the money after checkout | the therapist | the business |
| Enters the till / merchant account | ❌ | ✅ |
| Creates a `payments` row | ❌ | ✅ |
| Creates a `tips` row | ✅ | ✅ |
| Creates a ledger liability | ❌ | ✅ |
| Appears in "therapist earned this month" | ✅ | ✅ |
| Appears in "business owes this therapist" | ❌ | ✅ |
| Appears in business revenue | ❌ | as a pass-through, **not** as revenue |

Conflating these is how spas end up paying a tip twice: once in cash on the night, once again in the monthly payout because the system recorded it as owed.

### 9.2 Why `DIRECT_CASH` creates no ledger entry

The `therapist_payout_ledger` answers exactly one question: **how much money does the business currently owe this person?**

When a guest hands cash directly to a therapist, the business never held it and never owes it. Writing a `+50 AED` accrual and an immediate `-50 AED` settlement to "keep it symmetrical" would be an accounting fiction — the settlement never happened, because there was nothing to settle. Worse, it makes the ledger's `SUM()` a number you have to *interpret* rather than *trust*, and the moment a balance needs interpreting, disputes become unresolvable.

So: **earnings** and **payable** are two different reports, computed from two different tables, and the spec keeps them apart on purpose.

```sql
-- What the business owes right now.
SELECT COALESCE(SUM(amount_fils), 0) AS balance_fils
  FROM therapist_payout_ledger
 WHERE employee_id = $1;

-- What the therapist earned in tips this month, regardless of who held the cash.
SELECT type,
       COUNT(*)          AS tip_count,
       SUM(amount_fils)  AS total_fils
  FROM tips
 WHERE employee_id = $1
   AND business_day BETWEEN $2 AND $3
   AND reversed_by_tip_id IS NULL
 GROUP BY type;
```

The therapist's earnings statement shows both lines, labelled plainly: *"Cash received directly: AED 640. Held by BE RELAX and payable: AED 385."*

### 9.3 Balances are never stored

There is no `employee.balance_fils` column, and there will not be one. A denormalised balance is a second source of truth that drifts, and the drift is discovered during a dispute — the worst possible moment.

The balance is always `SUM(amount_fils)` over the ledger. With a few hundred entries per therapist per year this is instant. If it ever is not, the answer is a materialised view refreshed on a schedule, with the raw sum still available as the arbiter — not a mutable column.

```sql
CREATE INDEX therapist_payout_ledger_balance_idx
  ON therapist_payout_ledger (employee_id) INCLUDE (amount_fils);
```

### 9.4 Corrections are reversals, never edits

Reception records a 500 AED tip when the guest gave 50. The fix is **not** an update.

```ts
async reverseTip(tipId: string, reason: string, actor: AuthUser, ctx: RequestContext) {
  return this.prisma.$transaction(async (tx) => {
    const original = await tx.tip.findUniqueOrThrow({
      where: { id: tipId },
      include: { payment: true },
    });
    if (original.reversedByTipId) {
      throw new ConflictException({ error: { code: 'TIP_ALREADY_REVERSED' } });
    }

    // 1. A mirror tip row with a negative amount.
    const reversal = await tx.tip.create({
      data: {
        branchId:         original.branchId,
        reservationId:    original.reservationId,
        employeeId:       original.employeeId,
        type:             original.type,
        amountFils:       -original.amountFils,
        method:           original.method,
        businessDay:      businessDay(new Date()),
        recordedByUserId: actor.id,
        note:             `Reversal of ${original.id}: ${reason}`,
      },
    });
    await tx.tip.update({ where: { id: original.id }, data: { reversedByTipId: reversal.id } });

    // 2. If money had entered the business, a REFUND payment row.
    if (original.paymentId) {
      await tx.payment.create({
        data: {
          branchId:          original.branchId,
          reservationId:     original.reservationId,
          kind:              'REFUND',
          method:            original.method!,
          amountFils:        -original.amountFils,
          businessDay:       businessDay(new Date()),
          collectedByUserId: actor.id,
          reversesPaymentId: original.paymentId,
          note:              reason,
          idempotencyKey:    `${ctx.idempotencyKey}:refund`,
        },
      });

      // 3. And a REVERSAL ledger entry cancelling the liability.
      const accrual = await tx.therapistPayoutLedger.findFirstOrThrow({
        where: { tipId: original.id, entryType: 'TIP_ACCRUAL' },
      });
      if (accrual.payoutBatchId) {
        // Already paid out. Clawback is a human conversation, not a silent write.
        throw new ConflictException({
          error: {
            code: 'TIP_ALREADY_PAID_OUT',
            message: 'This tip was already included in a payout. Raise a manual adjustment instead.',
            details: { payoutBatchId: accrual.payoutBatchId },
          },
        });
      }
      await tx.therapistPayoutLedger.create({
        data: {
          branchId:        original.branchId,
          employeeId:      original.employeeId,
          entryType:       'REVERSAL',
          amountFils:      -original.amountFils,
          businessDay:     businessDay(new Date()),
          reservationId:   original.reservationId,
          tipId:           reversal.id,
          reversesEntryId: accrual.id,
          createdByUserId: actor.id,
          note:            reason,
        },
      });
    }

    await this.audit.write(tx, {
      action: 'TIP_REVERSED', entityType: 'Tip', entityId: original.id,
      beforeState: pickAuditFields(original), afterState: { reversedBy: reversal.id, reason },
      amountFils: -original.amountFils, ...ctx,
    });

    return reversal;
  });
}
```

The original row stays. Anyone reading the ledger six months later sees the mistake **and** the correction, with two names and two timestamps against them. That is the artefact that settles an argument.

### 9.5 Payout batches

```
POST /v1/payouts
{
  "employeeId": "0192bbbb-...",
  "periodStart": "2026-09-01",
  "periodEnd":   "2026-09-30",
  "method":      "CASH",
  "note":        "September settlement"
}
```

The handler, in one transaction:

1. `SELECT ... FOR UPDATE` every unbatched ledger entry for that employee with `business_day` in range.
2. Sums them. Refuses with `422 PAYOUT_NOT_POSITIVE` if the total is ≤ 0.
3. Creates the `payout_batches` row.
4. Stamps `payout_batch_id` onto each entry — the one mutation the ledger guard permits.
5. Inserts a `PAYOUT` entry with the **negative** total, bringing the balance to zero.
6. Writes `PAYOUT_CREATED` to the audit log with the full list of entry IDs in `afterState`.

The therapist confirms receipt via `POST /payouts/:id/acknowledge` from their own login, which sets `acknowledgedAt`. An acknowledged payout is the strongest evidence in a dispute: the money was calculated from an immutable ledger and the recipient signed for it.

### 9.6 The audit interceptor

Auditing is not something a developer remembers to do. It is infrastructure.

```ts
// apps/api/src/common/audit.service.ts
@Injectable()
export class AuditService {
  /** Always called with the SAME transaction client as the write it records.
   *  If the business write rolls back, so does its audit row — no phantom entries. */
  async write(tx: Prisma.TransactionClient, entry: AuditEntry) {
    await tx.financialAuditLog.create({
      data: {
        branchId:    entry.branchId,
        actorUserId: entry.actorUserId ?? null,
        actorRole:   entry.actorRole ?? null,
        action:      entry.action,
        entityType:  entry.entityType,
        entityId:    entry.entityId,
        beforeState: entry.beforeState ?? Prisma.JsonNull,
        afterState:  entry.afterState  ?? Prisma.JsonNull,
        amountFils:  entry.amountFils ?? null,
        ipAddress:   entry.ipAddress ?? null,
        userAgent:   entry.userAgent ?? null,
        requestId:   entry.requestId,
      },
    });
  }
}
```

`pickAuditFields` strips guest PII from the snapshots — the audit log records *what changed about the money*, not a second copy of the guest database. It keeps IDs, amounts, statuses and timestamps.

**Audited actions:** `RESERVATION_CREATED`, `RESERVATION_RESCHEDULED`, `RESERVATION_CHECK_IN`, `RESERVATION_CHECKOUT`, `RESERVATION_CANCELLED`, `RESERVATION_NO_SHOW`, `PAYMENT_REFUNDED`, `PAYMENT_ADJUSTED`, `TIP_REVERSED`, `PAYOUT_CREATED`, `PAYOUT_ACKNOWLEDGED`, `SERVICE_PRICE_CHANGED`, `EMPLOYEE_COMMISSION_CHANGED`, `USER_CREATED`, `USER_ROLE_CHANGED`, `USER_DISABLED`, `PASSWORD_RESET`, `AUTH_REFRESH_REUSE_DETECTED`, `GUEST_DATA_EXPORTED`, `GUEST_ERASED`.

### 9.7 Answering a dispute

A therapist says September's tips were short. One query:

```sql
SELECT l.created_at,
       l.entry_type,
       l.amount_fils,
       r.ref                AS reservation,
       t.type               AS tip_type,
       u.full_name          AS recorded_by,
       b.paid_at            AS paid_in_batch_at,
       b.acknowledged_at
  FROM therapist_payout_ledger l
  LEFT JOIN reservations  r ON r.id = l.reservation_id
  LEFT JOIN tips          t ON t.id = l.tip_id
  LEFT JOIN users         u ON u.id = l.created_by_user_id
  LEFT JOIN payout_batches b ON b.id = l.payout_batch_id
 WHERE l.employee_id = $1
   AND l.business_day BETWEEN '2026-09-01' AND '2026-09-30'
 ORDER BY l.created_at;
```

Every line has a booking reference, a named person who entered it, a timestamp, and — where relevant — the batch it was paid in and the moment the therapist acknowledged receipt. Cross-checked against `financial_audit_log` for the same entity IDs, the record is complete.

---

## 10. Multi-Touch Attribution

### 10.1 The model

A 90-day window, first-touch and last-touch both retained, plus the full ordered touch list capped at 10.

```ts
// public/attribution.js — the shape stored under berelax_attr
type Touch = {
  ts:        string;   // ISO-8601
  source:    string;   // "google" | "instagram" | "direct" | referrer host
  medium:    string;   // "organic" | "cpc" | "paid_social" | "referral" | "none"
  campaign?: string;
  term?:     string;
  content?:  string;
  gclid?:    string;
  fbclid?:   string;
  referrer?: string;
  landing:   string;   // path only, never the full URL with query
};

type AttributionStore = {
  v:         1;
  visitorId: string;   // UUID v4, first-party, generated on first visit
  first:     Touch;
  last:      Touch;
  touches:   Touch[];  // max 10; the oldest middle touches drop first, first/last always survive
  createdAt: string;
  updatedAt: string;
};
```

### 10.2 The client script

```html
<!-- index.html, before </body>. Loads only after consent — see §11.3 -->
<script src="/attribution.js" defer></script>
```

```js
/* public/attribution.js */
(function () {
  'use strict';

  var KEY        = 'berelax_attr';
  var WINDOW_DAYS = 90;
  var SESSION_GAP = 30 * 60 * 1000;   // 30 minutes defines a new session
  var MAX_TOUCHES = 10;
  var API         = 'https://api.berelax.ae/v1';

  function read() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (s.v !== 1) return null;
      // Expire the whole store once the FIRST touch falls out of the window.
      if (Date.now() - new Date(s.createdAt).getTime() > WINDOW_DAYS * 864e5) return null;
      return s;
    } catch (e) { return null; }   // private mode, blocked storage, corrupt JSON
  }

  function write(s) {
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* non-fatal */ }
  }

  function classify() {
    var p = new URLSearchParams(location.search);
    var ref = document.referrer || '';
    var refHost = '';
    try { refHost = ref ? new URL(ref).hostname.replace(/^www\./, '') : ''; } catch (e) {}

    var t = {
      ts:       new Date().toISOString(),
      landing:  location.pathname,
      referrer: refHost || undefined,
      campaign: p.get('utm_campaign') || undefined,
      term:     p.get('utm_term')     || undefined,
      content:  p.get('utm_content')  || undefined,
      gclid:    p.get('gclid')        || undefined,
      fbclid:   p.get('fbclid')       || undefined
    };

    if (p.get('utm_source')) {
      t.source = p.get('utm_source');
      t.medium = p.get('utm_medium') || 'unknown';
    } else if (t.gclid) {
      t.source = 'google'; t.medium = 'cpc';
    } else if (t.fbclid) {
      t.source = 'facebook'; t.medium = 'paid_social';
    } else if (/google\.|bing\.|duckduckgo|yahoo\./.test(refHost)) {
      t.source = refHost.split('.')[0]; t.medium = 'organic';
    } else if (/instagram\.|facebook\.|tiktok\./.test(refHost)) {
      t.source = refHost.split('.')[0]; t.medium = 'social';
    } else if (refHost && refHost !== location.hostname) {
      t.source = refHost; t.medium = 'referral';
    } else {
      t.source = 'direct'; t.medium = 'none';
    }
    return t;
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : ((r & 0x3) | 0x8)).toString(16);
    });
  }

  var now   = Date.now();
  var store = read();
  var touch = classify();

  if (!store) {
    store = {
      v: 1, visitorId: uuid(),
      first: touch, last: touch, touches: [touch],
      createdAt: touch.ts, updatedAt: touch.ts
    };
  } else {
    var gap        = now - new Date(store.updatedAt).getTime();
    var newSession = gap > SESSION_GAP;
    var changed    = touch.source !== store.last.source || touch.medium !== store.last.medium;

    // A direct hit NEVER overwrites a known last-touch. Someone who found you on
    // Google and returned by typing the URL was still found on Google.
    var meaningful = touch.medium !== 'none' && (newSession || changed);

    if (meaningful) {
      store.last = touch;
      store.touches.push(touch);
      if (store.touches.length > MAX_TOUCHES) {
        store.touches = [store.touches[0]]
          .concat(store.touches.slice(-(MAX_TOUCHES - 1)));   // keep first + most recent
      }
    }
    store.updatedAt = new Date(now).toISOString();
  }

  write(store);
  window.__berelaxAttr = store;

  // Mirror to the server so a visitor who never submits a form is still counted,
  // and so the visitorId lands in a server-set HttpOnly cookie (see §10.5).
  try {
    var body = JSON.stringify({
      visitorId: store.visitorId,
      touch:     store.last,
      first:     store.first,
      touchCount: store.touches.length
    });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(API + '/public/attribution/touch', new Blob([body], { type: 'application/json' }));
    } else {
      fetch(API + '/public/attribution/touch', {
        method: 'POST', body: body, credentials: 'include', keepalive: true,
        headers: { 'Content-Type': 'application/json' }
      }).catch(function () {});
    }
  } catch (e) {}

  // Strip tracking parameters from the address bar so a shared link is clean.
  if (/[?&](utm_|gclid|fbclid)/.test(location.search)) {
    history.replaceState(null, '', location.pathname + location.hash);
  }
})();
```

### 10.3 Carrying attribution to conversion

The website booking form posts the whole blob:

```js
fetch(API + '/public/booking-requests', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({
    guestName, guestPhone, guestEmail, requestedServiceId, requestedAt, message,
    turnstileToken,
    attribution: window.__berelaxAttr || null
  })
});
```

The API writes an `attribution_snapshots` row and links it to the `booking_requests` row. When reception converts the request, `attributionId` copies onto the `reservations` row. From that moment the chain is unbroken: **touch → request → reservation → payment**, and channel ROI is a join, not a guess.

### 10.4 Tracking the WhatsApp click

Most of this business converts through WhatsApp, and a `wa.me` link is a dead end — the click leaves the site and nothing comes back. The fix is a first-party redirect.

```html
<!-- Instead of href="https://wa.me/971525108633?text=..." -->
<a href="https://api.berelax.ae/v1/r/wa?ctx=hero&amp;text=...">WhatsApp</a>
```

```ts
@Public()
@Get('r/wa')
async whatsappRedirect(@Query() q: WaRedirectQuery, @Req() req: Request, @Res() res: Response) {
  // Log first, never block the redirect on it.
  this.clicks.record({
    target: 'whatsapp',
    context: q.ctx,
    visitorId: req.cookies?.brx_vid ?? null,
    referrer: req.get('referer'),
    userAgent: req.get('user-agent'),
    ...pickUtm(q),
  }).catch((e) => this.logger.warn({ e }, 'click log failed'));

  const text = q.text ? `?text=${encodeURIComponent(q.text)}` : '';
  return res.redirect(302, `https://wa.me/${WHATSAPP_NUMBER}${text}`);
}
```

Then, when the guest arrives on WhatsApp and reception creates the reservation, the receptionist picks `WHATSAPP` as the source channel. Joining `outbound_clicks` on `visitorId` closes the loop for the subset of guests who clicked from the site.

This is honest, partial attribution: it tells you *how many people clicked through to WhatsApp from which page and which campaign*, and — when the visitor is identifiable — which of those became bookings. It does not read WhatsApp.

### 10.5 The Safari problem, and why the cookie mirror exists

**A 90-day `localStorage` window is not achievable on Safari or on any iOS browser.** Safari's Intelligent Tracking Prevention caps script-writable storage — `localStorage`, `sessionStorage`, IndexedDB, and cookies set via `document.cookie` — at **seven days** of no interaction. Given how much of Abu Dhabi's traffic is iPhone, this would quietly halve the window for most guests, and nobody would notice until a campaign report looked wrong.

ITP's seven-day cap applies to *script-written* storage. A cookie set by the server in an HTTP response header, on a first-party domain, is not subject to it.

So `/public/attribution/touch` sets the mirror:

```ts
res.cookie('brx_vid', dto.visitorId, {
  httpOnly: true,
  secure:   true,
  sameSite: 'lax',
  domain:   '.berelax.ae',
  maxAge:   90 * 24 * 60 * 60 * 1000,
  path:     '/',
});
```

`localStorage` is the fast path. The cookie is the durable one. On each visit the script sends whatever it has; the server reconciles by `visitorId`, and if `localStorage` was evicted but the cookie survived, the server restores continuity from the `attribution_snapshots` rows it already holds for that visitor.

**This requires the API to be on a subdomain of the site's own domain** — `api.berelax.ae` alongside `berelax.ae`. On a `*.netlify.app` host or a separate API domain the cookie is third-party and gets blocked outright. Buying the `.ae` domain is therefore a prerequisite for attribution working properly, not a nice-to-have.

### 10.6 The channel ROI report

```sql
SELECT a.last_touch->>'source'   AS source,
       a.last_touch->>'medium'   AS medium,
       a.last_touch->>'campaign' AS campaign,
       count(DISTINCT br.id)                                    AS enquiries,
       count(DISTINCT r.id) FILTER (WHERE r.status = 'COMPLETED') AS completed_visits,
       COALESCE(SUM(p.amount_fils) FILTER (WHERE p.kind = 'BASE'), 0) AS revenue_fils,
       round(
         100.0 * count(DISTINCT r.id) FILTER (WHERE r.status = 'COMPLETED')
         / NULLIF(count(DISTINCT br.id), 0), 1
       ) AS conversion_pct
  FROM attribution_snapshots a
  LEFT JOIN booking_requests br ON br.attribution_id = a.id
  LEFT JOIN reservations     r  ON r.attribution_id  = a.id
  LEFT JOIN payments         p  ON p.reservation_id  = r.id
 WHERE a.captured_at >= $1 AND a.captured_at < $2
 GROUP BY 1, 2, 3
 ORDER BY revenue_fils DESC;
```

Swap `last_touch` for `first_touch` to see which channel *discovers* guests rather than which one *closes* them. They are usually different, and the gap between them is the most useful number in the report — it is the difference between a channel you should cut and a channel that is doing the work you are crediting elsewhere.

---

## 11. UAE PDPL and Data Compliance

> **This section is an engineering specification, not legal advice.** It describes what the system does and why. Have UAE counsel review the privacy notice, the consent wording and the cross-border transfer basis before launch — and specifically confirm the current status of the PDPL's Executive Regulations, which set the procedural detail for several of the obligations below.

### 11.1 Which law applies

BE RELAX operates onshore in Abu Dhabi (Al Zahiyah, not a financial free zone), so the governing instrument is **Federal Decree-Law No. 45 of 2021 on the Protection of Personal Data** — the PDPL. The separate regimes of the DIFC and ADGM do not apply to an onshore establishment.

The spa is the **Controller**. Supabase, Vercel, Railway, Netlify and Cloudflare are **Processors**.

### 11.2 Lawful basis, per data category

| Data | Basis | Notes |
|---|---|---|
| Guest name, phone, booking history | Necessary for performance of a contract | No consent needed to take a booking; you cannot deliver the service without it. |
| Payment and tip records | Legal obligation (tax/accounting) + contract | Retained 5 years regardless of an erasure request — see [§11.6](#116-retention-schedule). |
| Marketing messages | **Consent** — separate, opt-in, withdrawable | Recorded in `guest_consents` with the policy version and timestamp. Never bundled into the booking form's submit action. |
| Attribution / analytics identifiers | **Consent** | A `visitorId` is a unique identifier tied to behaviour. It is personal data even without a name attached. See [§11.3](#113-the-consent-gate-on-the-public-site). |
| Employee records, payouts | Employment contract + legal obligation | |
| Guest preference notes | Contract | **Strictly non-medical.** See [§11.5](#115-health-data-is-a-hard-stop). |

### 11.3 The consent gate on the public site

`attribution.js` **must not run before consent**. This is the one place where the current website needs a change before the CRM goes live.

```html
<!-- index.html -->
<script>
(function () {
  var C = 'berelax_consent';
  function load() {
    var s = document.createElement('script');
    s.src = '/attribution.js'; s.defer = true;
    document.body.appendChild(s);
  }
  var saved = null;
  try { saved = localStorage.getItem(C); } catch (e) {}
  if (saved === 'granted') { load(); return; }
  if (saved === 'denied')  { return; }
  window.__berelaxConsent = {
    grant: function () { try { localStorage.setItem(C, 'granted'); } catch (e) {} load(); },
    deny:  function () { try { localStorage.setItem(C, 'denied');  } catch (e) {} }
  };
  // Render the banner. Accept and Decline are equally prominent — a dark-pattern
  // banner is not valid consent under Art. 6.
})();
</script>
```

Requirements the banner has to meet:

- **Accept and Decline are visually equal.** No greyed-out refusal.
- Declining is a single click, not a settings journey.
- The banner names what is collected and links to the privacy notice.
- The choice is re-openable from a persistent footer link, because consent must be as easy to withdraw as to give (Art. 6).
- The site works fully when consent is declined. Attribution is the only thing that stops.

> The booking form and the WhatsApp buttons are **not** gated — those are contract-necessity, and blocking a guest from booking until they accept analytics would invalidate the consent anyway.

### 11.4 Data subject rights

PDPL Articles 13–17 give guests the right to be informed, to access, to portability, to correction, to erasure, to restriction and to object. Two endpoints implement them; both are `MANAGER+` and both write to the audit log.

**`GET /v1/guests/:id/export`** returns a complete JSON bundle — guest record, consents, every reservation, every payment, every tip, and any attribution snapshots linked to their bookings. It is the answer to an access request and a portability request at once.

**`POST /v1/guests/:id/erase`** is an anonymisation, not a `DELETE`:

```ts
async erase(guestId: string, reason: string, actor: AuthUser, ctx: RequestContext) {
  return this.prisma.$transaction(async (tx) => {
    const before = await tx.guest.findUniqueOrThrow({ where: { id: guestId } });

    await tx.guest.update({
      where: { id: guestId },
      data: {
        fullName:     'Erased guest',
        // Keep a salted hash so a blocked guest stays blocked and duplicate
        // detection still works, without retaining the number itself.
        phone:        `erased:${sha256(before.phone + ERASURE_SALT).slice(0, 24)}`,
        email:        null,
        notes:        null,
        anonymisedAt: new Date(),
        deletedAt:    new Date(),
      },
    });

    await tx.guestConsent.deleteMany({ where: { guestId } });

    // Attribution is severed from the person immediately, even inside the 90 days.
    await tx.attributionSnapshot.updateMany({
      where: { reservations: { some: { guestId } } },
      data:  { visitorId: NULL_UUID, touches: [], landingPath: null, prunedAt: new Date() },
    });

    // Reservations and payments are NOT deleted. See below.
    await this.audit.write(tx, {
      action: 'GUEST_ERASED', entityType: 'Guest', entityId: guestId,
      beforeState: { hadEmail: !!before.email, createdAt: before.createdAt },
      afterState:  { anonymised: true, reason },
      ...ctx,
    });
  });
}
```

**Why financial records survive an erasure request.** The right to erasure is not absolute — it yields where the controller must retain data to comply with another legal obligation, and UAE tax law requires accounting records to be kept for five years. The reconciliation is that the *transaction* is retained while the *person* is severed from it: the reservation keeps its amounts, dates, therapist and audit trail, and its `guest_id` now points at an anonymised shell. The books still balance; the guest is no longer identifiable from them.

The privacy notice must say this in plain language, because a guest who asks to be deleted and later learns that records remain will not be reassured by Article 15.

### 11.5 Health data is a hard stop

Massage intake forms routinely ask about pregnancy, injuries, blood pressure, recent surgery and allergies. Under PDPL Article 1 that is **sensitive personal data** — data revealing physical or mental health — and it carries stricter handling obligations.

Beyond the PDPL there is a second, sharper problem. **Federal Law No. 2 of 2019 on the Use of ICT in Health Fields** requires health data generated inside the UAE to be stored and processed inside the UAE, and restricts transferring it abroad without health-authority approval. Supabase has no UAE region. If the CRM stores medical intake answers on Supabase infrastructure in Frankfurt or Singapore, you are potentially in breach of a statute that has nothing to do with the PDPL.

Whether Law 2/2019 reaches a wellness spa that is not a licensed health facility is genuinely arguable, and that argument is one for counsel, not for a schema design.

**The engineering decision, taken to avoid the question entirely:**

1. **The CRM stores no medical or health information.** The `Guest.notes` field is for preferences — *"prefers firm pressure"*, *"requests a female therapist"*, *"allergic to jasmine oil"* is already borderline and should be phrased as *"no jasmine oil"*.
2. Application-level validation rejects known medical terms in `notes` with a warning to reception, and the field's helper text says **"Preferences only. Do not record medical information."**
3. If a health questionnaire is operationally required, it stays **on paper**, in a locked cabinet on site, and is not digitised. This is a real, if unglamorous, compliance strategy and it is what most Abu Dhabi spas do.
4. Should a digital intake form become necessary later, it is a **separate system hosted in the UAE** (AWS `me-central-1`, G42, Etisalat or Khazna), referenced from the CRM by ID only — never a column on `guests`.

Flagging this now costs nothing. Discovering it after two years of intake data sits on a Frankfurt database is expensive.

### 11.6 Retention schedule

| Data | Retained | Then |
|---|---|---|
| Guest identity (name, phone, email) | 3 years after the last visit | Anonymised by the retention job |
| Reservations | 5 years | Guest fields already severed; the booking row persists |
| Payments, tips, ledger, payout batches | 5 years minimum (tax) | Reviewed, then archived — never deleted while any dispute is open |
| `financial_audit_log` | 7 years | Cold storage |
| `attribution_snapshots` | **90 days** | Identifiers stripped, channel aggregates kept ([§5.6](#56-retention-job)) |
| `outbound_clicks` | 90 days | Deleted |
| `refresh_tokens` (revoked/expired) | 30 days | Deleted |
| Marketing consent records | Until withdrawal + 3 years | Proof that consent existed is itself a legal necessity |
| Application logs with IPs | 90 days | Deleted |

### 11.7 Cross-border transfer

Guest data will sit outside the UAE. PDPL Articles 22–23 permit this where the destination offers adequate protection as recognised by the UAE Data Office, or — absent such a determination — under an appropriate contractual undertaking, or with the data subject's express consent.

The engineering obligations:

1. **Pick the region deliberately and document it.** Check Supabase's current region list before provisioning; at the time of writing there is no UAE region, so the realistic choices are Frankfurt (`eu-central-1`) or Mumbai/Singapore. Frankfurt has the stronger argument on "adequate protection" because of the GDPR regime around it. **Record the choice and its reasoning in this repository** — that record is the first thing anyone will ask for.
2. **Sign the Data Processing Addendum** with Supabase, Vercel, Railway, Netlify and Cloudflare, and keep countersigned copies in the business records.
3. **Name the transfer in the privacy notice.** The notice must state that data is processed outside the UAE, name the country, and name the safeguard relied upon.
4. **Maintain a record of processing activities** (Art. 7): what is collected, why, on what basis, who it goes to, where it is stored and how long it is kept. A `docs/data-processing-register.md` in this repository, reviewed each quarter.
5. **If strict localisation is ever required** — by counsel or by a future regulation — the schema is host-agnostic. It is stock PostgreSQL 15 plus `btree_gist` and `pgcrypto`, both in contrib. It moves to any UAE-hosted Postgres with a `pg_dump` and a connection-string change. Nothing in this specification is Supabase-specific. That portability is deliberate.

### 11.8 Breach response

PDPL Article 9 requires notification to the UAE Data Office without undue delay on becoming aware of a breach that would prejudice the privacy, confidentiality or security of the data, and notification to affected data subjects where the breach poses a risk to them.

The runbook lives at `docs/runbooks/data-breach.md`:

1. **Contain** — revoke all refresh tokens (`UPDATE refresh_tokens SET revoked_at = now()`), rotate `JWT_SECRET`, rotate database credentials, rotate every API key.
2. **Assess** — from `financial_audit_log` and the platform access logs, establish what was reached, by whom, and when. This is the reason the audit log is append-only and database-enforced: during a breach it is the only record you can still trust.
3. **Notify** the UAE Data Office with the required particulars, without undue delay.
4. **Notify affected guests** where there is risk to them, in plain Arabic and English.
5. **Record** the incident, the timeline and the remediation.

The named breach contact — a person with a phone number, not a shared inbox — goes in that runbook before launch.

### 11.9 Security controls that carry compliance weight

| Control | Implementation |
|---|---|
| Transport encryption | TLS 1.2+ everywhere; HSTS `max-age=31536000; includeSubDomains; preload` |
| Encryption at rest | Supabase AES-256 on volumes and backups |
| Access control | RBAC ([§6.4](#64-the-role-matrix)) + branch scoping ([§6.6](#66-branch-scoping-is-not-optional)) |
| Least privilege | The application's DB role has no `SUPERUSER`, no `CREATEROLE`, and `REVOKE DELETE` on `financial_audit_log`, `payments` and `therapist_payout_ledger` |
| Accountability | Every money action carries an actor, an IP and a request ID |
| Secrets | Platform secret managers only. No `.env` file is ever committed; `.env.example` holds names and no values |
| Backups | Supabase daily backups + PITR, retained 30 days; **a restore is rehearsed quarterly** — an untested backup is a hope |
| Data minimisation | No date of birth, no ID/passport number, no nationality, no address. The system asks for a name, a phone number and an optional email, because that is all a booking needs |

---

## 12. Non-Functional Requirements

### 12.1 Performance targets

| Operation | p95 |
|---|---|
| `GET /reservations?businessDay=…` (a full night's grid) | < 150 ms |
| `POST /reservations` | < 250 ms |
| `POST /reservations/:id/check-in` | < 300 ms |
| `POST /reservations/:id/checkout` | < 300 ms |
| `GET /reports/daily` | < 600 ms |
| Dashboard first contentful paint | < 1.5 s on 4G |

These are comfortable targets for a single-branch workload — roughly 30–60 reservations a night, under 25,000 rows a year in the busiest table. The system is not performance-constrained and should not be designed as if it were. It is correctness-constrained.

### 12.2 Availability

The spa runs 11:00–02:00 Dubai. Deployments happen between 03:00 and 09:00 Dubai, never during trading.

The dashboard degrades rather than dies: if the API is unreachable, the booking grid renders from the last cached response with a prominent stale banner, and every write button is disabled. A receptionist must never be able to *believe* they took a payment that was not recorded. Queued offline writes are explicitly **out of scope** — a money write that might land later is worse than a write that plainly failed.

### 12.3 Observability

- **Structured JSON logs** (pino) with `requestId`, `userId`, `branchId` and `route` on every line. Guest names, phone numbers and token values are redacted by a serialiser.
- **Sentry** for the API and the dashboard, with `beforeSend` stripping PII from breadcrumbs.
- **Health endpoints**: `/health` (liveness) and `/health/ready` (a `SELECT 1` against the pool).
- **Alerts**, to the owner's phone: API 5xx rate > 1% over 5 minutes; database connection failures; any `AUTH_REFRESH_REUSE_DETECTED`; any exclusion-constraint violation rate above 5 per hour (which means the availability UI is showing stale slots); a failed nightly backup; any reservation still `IN_PROGRESS` more than 4 hours after `blocked_until`.

### 12.4 API hardening

```ts
// apps/api/src/main.ts
app.use(helmet());
app.enableCors({
  origin: ['https://berelax.ae', 'https://www.berelax.ae', 'https://crm.berelax.ae'],
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
});
app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
app.useGlobalFilters(new PrismaErrorFilter(), new AllExceptionsFilter());
app.useGlobalInterceptors(new RequestContextInterceptor(), new IdempotencyInterceptor());
app.use(json({ limit: '128kb' }));
```

Rate limits (`@nestjs/throttler`, Redis-backed):

| Scope | Limit |
|---|---|
| `POST /auth/login` | 5 / 15 min per IP **and** per email |
| `/public/*` | 10 / min, 60 / hour per IP |
| Authenticated endpoints | 300 / min per user |
| `/r/*` redirects | 60 / min per IP |

### 12.5 Environment variables

```bash
# ─ Database ─
DATABASE_URL=                 # pooled, :6543, ?pgbouncer=true&connection_limit=1
DIRECT_URL=                   # direct,  :5432, migrations only

# ─ Auth ─
JWT_SECRET=                   # 32 random bytes, base64
JWT_SECRET_PREVIOUS=          # set only during a rotation window
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=7d
BCRYPT_COST=12

# ─ App ─
NODE_ENV=production
PORT=3000
API_BASE_URL=https://api.berelax.ae
DASHBOARD_ORIGIN=https://crm.berelax.ae
PUBLIC_SITE_ORIGIN=https://berelax.ae
COOKIE_DOMAIN=.berelax.ae
DEFAULT_BRANCH_ID=

# ─ Business ─
TZ=Asia/Dubai
BUSINESS_DAY_CUTOFF_HOURS=6
WHATSAPP_NUMBER=971525108633

# ─ Compliance ─
ATTRIBUTION_RETENTION_DAYS=90
GUEST_RETENTION_YEARS=3
FINANCIAL_RETENTION_YEARS=5
ERASURE_SALT=                 # 32 random bytes; NEVER rotate — rotation orphans every erased record

# ─ Ops ─
SENTRY_DSN=
REDIS_URL=
TURNSTILE_SECRET=
LOG_LEVEL=info
```

---

## 13. Testing Strategy

### 13.1 The test that matters most

Everything else in this system is ordinary CRUD. This is the one that has to pass, and it must run against a **real PostgreSQL instance** — an in-memory or mocked database has no exclusion constraints and will pass while proving nothing.

```ts
// apps/api/test/booking-concurrency.e2e-spec.ts
describe('double-booking prevention', () => {
  it('admits exactly one of N simultaneous bookings for the same therapist and slot', async () => {
    const N = 25;
    const slot = {
      employeeId, roomId, serviceId,
      startsAt: '2026-09-20T19:00:00+04:00',
      durationMinutes: 60,
    };

    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        api.post('/v1/reservations')
           .set('Idempotency-Key', randomUUID())
           .send({ ...slot, guestName: `Guest ${i}`, guestPhone: `+9715000000${i}` }),
      ),
    );

    const created  = results.filter((r) => r.status === 'fulfilled' && r.value.status === 201);
    const rejected = results.filter((r) => r.status === 'fulfilled' && r.value.status === 409);

    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(N - 1);
    rejected.forEach((r: any) =>
      expect(r.value.body.error.code).toBe('THERAPIST_ALREADY_BOOKED'),
    );

    const rows = await prisma.reservation.count({
      where: { employeeId, startsAt: new Date(slot.startsAt), status: { in: ['SCHEDULED', 'IN_PROGRESS'] } },
    });
    expect(rows).toBe(1);
  });

  it('allows a back-to-back booking that starts exactly when the previous slot frees', async () => {
    // 19:00–20:00 service + 15 min turnaround ⇒ blocked_until 20:15.
    // 20:15 must succeed; 20:14 must not. This proves the half-open range
    // and the turnaround arithmetic in one assertion pair.
    await expect(book({ startsAt: '2026-09-20T20:15:00+04:00' })).resolves.toHaveProperty('status', 201);
    await expect(book({ startsAt: '2026-09-20T20:14:00+04:00' })).resolves.toHaveProperty('status', 409);
  });

  it('frees the slot the instant the blocking reservation is cancelled', async () => {
    await api.post(`/v1/reservations/${first.id}/cancel`).send({ reason: 'guest called' });
    await expect(book(slot)).resolves.toHaveProperty('status', 201);
  });
});
```

### 13.2 Coverage expectations

| Layer | Target | Tool |
|---|---|---|
| Money logic — check-in, checkout, tips, reversals, payout batches | **100 %** of branches | Jest, unit |
| Auth — hashing, rotation, reuse detection, lockout, guards | **100 %** of branches | Jest, unit |
| Other services | 80 % | Jest |
| API endpoints | every route, happy + primary failure | Supertest + Testcontainers Postgres |
| Concurrency | the suite in §13.1 | Supertest, real DB |
| Dashboard critical flows | book → check in → check out → report | Playwright |

### 13.3 Financial invariants, asserted in CI

Property tests that run against a seeded database after every migration:

1. For every employee, `SUM(ledger.amount_fils)` equals `SUM(tips WHERE type = 'COLLECTED_BY_BUSINESS' AND not reversed) + SUM(commission accruals) - SUM(payouts)`.
2. No ledger entry exists for any `DIRECT_CASH` tip.
3. Every **live** `COLLECTED_BY_BUSINESS` tip — one with a positive amount — has exactly one `payments` row and exactly one `TIP_ACCRUAL` ledger entry.
3b. Every reversed tip moved as a whole: the original marked reversed, a negative mirror of equal size, the money sent back where the business had held it, and the liability cancelled by a `REVERSAL` entry.
4. Every `COMPLETED` reservation has `SUM(payments WHERE kind = 'BASE') = base_cost_fils` — the desk collected the quoted price in full.
4b. No payment was refunded for more than it was worth: the refunds against any payment never exceed it.
5. No reservation is `COMPLETED` without a `completed_at`, and none is `IN_PROGRESS` without an `actual_arrival_at`.
6. No two `SCHEDULED`/`IN_PROGRESS` reservations share a therapist and an overlapping range — asserted by query, independently of the constraint, so a constraint accidentally dropped by a future migration fails CI loudly.
7. Every row in `payments`, `tips` and `therapist_payout_ledger` has a corresponding `financial_audit_log` entry within 1 second of **`created_at`** — the system timestamp, not `collected_at`, which reception may legitimately back-date on a check-in.

> Invariants 3 and 4 first read "every `COLLECTED_BY_BUSINESS` tip" and "net of refunds". Neither survived a faithful reversal: the first counted the negative mirror row as corruption, and the second bucketed a refunded *tip* against the *base*, so a fully-paid booking read as short. Splitting each into the two things the system actually guarantees — the desk collected in full, and money only goes back out if it came in — made them provable rather than approximately true. An invariant you have to explain away is not an invariant.

Invariant 6 is the canary. If a migration ever drops an exclusion constraint, this is what tells you — on the pull request, not on a Friday night.

### 13.4 Seed data

`prisma/seed.ts` builds a realistic branch: the real service menu and prices from the website, 8 therapists, 5 rooms, 3 users (one per role), 200 reservations spread across the previous 60 business days with plausible arrival times, a realistic tip mix (roughly 40 % no tip, 35 % direct cash, 25 % collected by business), and attribution snapshots across all channels. Reports built against an empty database look correct and are not.

---

## 14. Delivery Plan

Sequenced so that nothing is built on an unproven foundation. Each phase ends with something demonstrable.

| Phase | Deliverable | Est. |
|---|---|---|
| **0 — Foundations** | Monorepo, Supabase project, Prisma schema, every migration in [§5](#5-sql-migrations--what-prisma-cannot-express), seed script, CI running the concurrency suite. **Exit: §13.1 is green.** | 1 week |
| **1 — Auth** | Login, refresh rotation with reuse detection, lockout, guards, role matrix, user management, the audit interceptor. **Exit: RBAC matrix verified test-by-test.** | 1 week |
| **2 — Booking core** | Reservations CRUD, availability grid, booking-request inbox and conversion, guests, employees, services, rooms. Dashboard grid and booking sheet. **Exit: a full day can be booked by hand.** | 2 weeks |
| **3 — The money** | Check-in, checkout, tips both modes, payout ledger, reversals, payout batches, the financial invariants in [§13.3](#133-financial-invariants-asserted-in-ci). **Exit: all 7 invariants green on seeded data.** | 2 weeks |
| **4 — Attribution** | `attribution.js` with the consent gate, the touch endpoint and cookie mirror, the `/r/*` redirects, the channel ROI report. Requires the `.ae` domain and the `api.` subdomain to exist. | 1 week |
| **5 — Reporting & attendance** | Daily close-out, revenue, therapist utilisation, tips by mode, shifts and clock-in/out. | 1 week |
| **6 — Compliance & hardening** | Export and erasure endpoints, retention jobs on `pg_cron`, privacy notice, processing register, breach runbook, rate limits, rehearsed backup restore, penetration pass. | 1 week |
| **7 — Pilot** | Two weeks running **in parallel with the current paper process**, reconciled nightly. Reception trained. Switch over only when the numbers match for five consecutive nights. | 2 weeks |

**Roughly 11 weeks to a supervised switchover.** Phases 0–3 are the irreducible core; 4–6 can be resequenced against business priority, but 6 must complete before real guest data enters the system.

> **Do not skip Phase 7.** A booking system that loses a Friday night's takings destroys more trust than it will earn back in a year, and the parallel run is the only thing that catches the class of bug that only appears with real staff moving at real speed.

---

## 15. Known Limitations — Read This Before You Promise Anything

An honest specification names what it cannot do.

### 15.1 Google Search Console cannot attribute a booking to a keyword

GSC reports impressions, clicks, CTR and average position **aggregated by query and by page**. It does not expose a per-visitor identifier, and its API cannot be joined to a session, a booking or a guest. Google also withholds the query entirely for long-tail terms below a privacy threshold, so the totals in the query report never sum to the totals in the page report.

What you get is: *"the page `/` received 1,240 clicks from search last month, and among the queries Google chose to disclose, 'massage al zahiyah' was the largest."*

What you **cannot** get is: *"this guest, who paid AED 250 on Tuesday, found us by searching 'massage al zahiyah'."*

The attribution system in [§10](#10-multi-touch-attribution) records `source: google, medium: organic` for that visitor — the channel, not the keyword. Correlating keyword performance with revenue is therefore a **trend exercise** across weeks, not a per-booking fact. Any dashboard tile claiming otherwise is lying.

Google Ads is different: `gclid` is captured, and with auto-tagging plus offline conversion import you can attribute paid clicks to specific campaigns and keywords. That path is real and worth building — it is simply not available for organic search.

### 15.2 The 90-day window is a target, not a guarantee

Covered in [§10.5](#105-the-safari-problem-and-why-the-cookie-mirror-exists). On Chrome and Android, 90 days is achievable. On Safari and every iOS browser, script-written storage is capped at seven days, and the server-set cookie mirror is what carries the rest. Expect measurable attribution loss on iOS regardless. Plan campaign decisions around directional data, not precise counts.

### 15.3 Walk-ins and phone bookings are self-reported

`source_channel` for a walk-in is whatever the receptionist taps. There is no technical verification, and at 01:00 on a busy Saturday it will sometimes be wrong. Keep the dropdown short — five options, not fifteen — and treat walk-in attribution as a soft signal.

### 15.4 Cash is trust, with a paper trail

The system records that a receptionist said cash was collected. It cannot prove the cash reached the drawer. What it does provide is a per-shift cash reconciliation: expected cash from `payments WHERE method = 'CASH'` for a business day, against counted cash at close-out, with the variance recorded and attributed to the user on shift. A persistent variance pattern is visible within a fortnight. That is as far as software can go; the rest is a camera and a drawer count.

### 15.5 No payment processing

Payments are recorded, not taken. Card transactions still go through the existing terminal, and `externalRef` is where the slip number is typed. Integrating a UAE payment gateway — Telr, Network International, Stripe UAE — is a phase of its own, and it brings PCI-DSS scope with it. It is deliberately not in v1.

### 15.6 Single branch, in practice

`branch_id` is on every table and every query is scoped, which means the *data model* is multi-branch on day one. The **user interface is not**: there is no branch switcher, no cross-branch report, and no concept of a therapist working across branches. Adding a second branch is a UI project of perhaps two weeks — not a migration, which is exactly the point of carrying the column now.

### 15.7 WhatsApp is a black box

The redirect in [§10.4](#104-tracking-the-whatsapp-click) counts the click and its context. Everything after that happens in an app this system cannot see. Whether that conversation became a booking is known only when reception creates the reservation and marks it `WHATSAPP`. The WhatsApp Business API would close this loop with real message-level attribution, and is worth revisiting once booking volume justifies the setup cost.

---

## Appendix A — Local Development

```bash
git clone git@github.com:ahmedabuseif1997/berelax-platform.git
cd berelax-platform
pnpm install

# Local Postgres with btree_gist available
docker compose up -d postgres

cp apps/api/.env.example apps/api/.env      # fill DATABASE_URL, DIRECT_URL, JWT_SECRET

pnpm --filter api prisma migrate dev
pnpm --filter api prisma db seed

pnpm dev                                    # API :3000, dashboard :3001
pnpm test                                   # unit
pnpm test:e2e                               # requires Docker — spins a real Postgres

# Prove the database guarantees still hold after any migration
psql -d berelax -f docs/sql/verify-core-constraints.sql   # every line must start with "ok"
```

`docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_PASSWORD: dev
      POSTGRES_DB: berelax
    ports: ['5432:5432']
    volumes: ['pgdata:/var/lib/postgresql/data']
    command: ['postgres', '-c', 'log_statement=all']
volumes:
  pgdata:
```

`btree_gist` and `pgcrypto` ship with the official image's contrib package, and `uuid_generate_v7()` is defined in the first migration rather than pulled from an extension, so a stock `postgres:16-alpine` container needs nothing added. The same migration runs unchanged on Supabase.

## Appendix B — Error Code Reference

| Code | HTTP | Meaning |
|---|---|---|
| `THERAPIST_ALREADY_BOOKED` | 409 | Exclusion constraint on `employee_id` |
| `ROOM_ALREADY_BOOKED` | 409 | Exclusion constraint on `room_id` |
| `GUEST_ALREADY_BOOKED` | 409 | Exclusion constraint on `guest_id` |
| `SLOT_CONFLICT` | 409 | Exclusion violation, constraint unrecognised |
| `RESERVATION_NOT_FOUND` | 404 | Missing, or belongs to another branch |
| `RESERVATION_NOT_SCHEDULED` | 409 | Check-in attempted on a non-`SCHEDULED` booking |
| `RESERVATION_NOT_IN_PROGRESS` | 409 | Checkout attempted on a non-`IN_PROGRESS` booking |
| `BASE_PAYMENT_MISMATCH` | 422 | Collected total ≠ `base_cost_fils` |
| `BASE_PAYMENT_OUTSTANDING` | 409 | Checkout before the base is settled |
| `INVALID_AMOUNT` | 422 | Non-positive amount |
| `TIP_METHOD_REQUIRED` | 422 | `COLLECTED_BY_BUSINESS` without a method |
| `TIP_METHOD_NOT_ALLOWED` | 422 | `DIRECT_CASH` with a method |
| `TIP_EXCEEDS_SANITY_LIMIT` | 422 | Over 3× the base; needs `confirmLargeTip` |
| `TIP_ALREADY_REVERSED` | 409 | |
| `TIP_ALREADY_PAID_OUT` | 409 | Reversal blocked; raise a manual adjustment |
| `PAYOUT_NOT_POSITIVE` | 422 | Batch total ≤ 0 |
| `ARRIVAL_TIME_IMPLAUSIBLE` | 422 | Arrival more than 12 h from `starts_at` |
| `COMPLETION_BEFORE_ARRIVAL` | 422 | |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | Money endpoint without a key |
| `IDEMPOTENCY_KEY_REUSED` | 409 | Same key, different body |
| `REQUEST_IN_PROGRESS` | 409 | Same key, still executing |
| `INVALID_CREDENTIALS` | 401 | |
| `ACCOUNT_LOCKED` | 423 | Five failed attempts |
| `ACCOUNT_DISABLED` | 401 | |
| `PASSWORD_CHANGE_REQUIRED` | 403 | |
| `INVALID_REFRESH_TOKEN` | 401 | |
| `REFRESH_TOKEN_EXPIRED` | 401 | |
| `REFRESH_TOKEN_REUSED` | 401 | Family revoked; audited |
| `INSUFFICIENT_ROLE` | 403 | |

---

*End of specification. Changes to this document are proposed by pull request against `docs/spa-crm-architecture-spec.md`; the schema, the role matrix and the retention schedule are the sections that must never drift from the implementation.*

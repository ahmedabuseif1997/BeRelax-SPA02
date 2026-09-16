-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('OWNER', 'MANAGER', 'RECEPTIONIST', 'THERAPIST');

-- CreateEnum
CREATE TYPE "EmployeeStatus" AS ENUM ('ACTIVE', 'ON_LEAVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "BookingRequestStatus" AS ENUM ('NEW', 'CONTACTED', 'CONVERTED', 'DECLINED', 'SPAM');

-- CreateEnum
CREATE TYPE "SourceChannel" AS ENUM ('WEBSITE_FORM', 'WHATSAPP', 'PHONE', 'WALK_IN', 'INSTAGRAM', 'GOOGLE_MAPS', 'REFERRAL', 'OTHER');

-- CreateEnum
CREATE TYPE "PaymentKind" AS ENUM ('BASE', 'TIP', 'REFUND', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'CARD', 'BANK_TRANSFER', 'VOUCHER', 'COMPLIMENTARY');

-- CreateEnum
CREATE TYPE "TipType" AS ENUM ('DIRECT_CASH', 'COLLECTED_BY_BUSINESS');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('TIP_ACCRUAL', 'COMMISSION_ACCRUAL', 'PAYOUT', 'ADJUSTMENT', 'REVERSAL');

-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('PLANNED', 'ACTIVE', 'ENDED', 'ABSENT');

-- CreateEnum
CREATE TYPE "ConsentType" AS ENUM ('DATA_PROCESSING', 'MARKETING', 'PHOTO');

-- CreateTable
CREATE TABLE "branches" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "name" TEXT NOT NULL,
    "address_line" TEXT NOT NULL,
    "city" TEXT NOT NULL DEFAULT 'Abu Dhabi',
    "phone_primary" TEXT NOT NULL,
    "phone_secondary" TEXT,
    "phone_landline" TEXT,
    "whatsapp_number" TEXT NOT NULL,
    "google_maps_url" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Dubai',
    "opens_at" TEXT NOT NULL DEFAULT '11:00',
    "closes_at" TEXT NOT NULL DEFAULT '02:00',
    "turnaround_mins" INTEGER NOT NULL DEFAULT 15,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "branch_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "must_change_password" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ(6),
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "password_changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "employee_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "replaced_by_id" UUID,
    "user_agent" TEXT,
    "ip_address" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_categories" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "service_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "services" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "branch_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "price_fils" INTEGER NOT NULL,
    "description" TEXT,
    "requires_room" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rooms" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "branch_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "branch_id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "legal_name" TEXT,
    "phone" TEXT,
    "status" "EmployeeStatus" NOT NULL DEFAULT 'ACTIVE',
    "commission_bps" INTEGER NOT NULL DEFAULT 0,
    "hired_on" DATE,
    "photo_url" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shifts" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "branch_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "business_day" DATE NOT NULL,
    "planned_start" TIMESTAMPTZ(6) NOT NULL,
    "planned_end" TIMESTAMPTZ(6) NOT NULL,
    "clock_in_at" TIMESTAMPTZ(6),
    "clock_out_at" TIMESTAMPTZ(6),
    "status" "ShiftStatus" NOT NULL DEFAULT 'PLANNED',
    "note" TEXT,

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guests" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "branch_id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "notes" TEXT,
    "is_blocked" BOOLEAN NOT NULL DEFAULT false,
    "anonymised_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "guests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guest_consents" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "guest_id" UUID NOT NULL,
    "type" "ConsentType" NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawn_at" TIMESTAMPTZ(6),
    "source" TEXT NOT NULL,
    "policy_version" TEXT NOT NULL,
    "ip_address" TEXT,

    CONSTRAINT "guest_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_requests" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "branch_id" UUID NOT NULL,
    "guest_id" UUID,
    "guest_name" TEXT NOT NULL,
    "guest_phone" TEXT NOT NULL,
    "guest_email" TEXT,
    "requested_service_id" UUID,
    "requested_at" TIMESTAMPTZ(6),
    "message" TEXT,
    "status" "BookingRequestStatus" NOT NULL DEFAULT 'NEW',
    "source_channel" "SourceChannel" NOT NULL,
    "attribution_id" UUID,
    "converted_reservation_id" UUID,
    "handled_by_user_id" UUID,
    "handled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservations" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "ref" TEXT NOT NULL,
    "branch_id" UUID NOT NULL,
    "guest_id" UUID,
    "employee_id" UUID NOT NULL,
    "room_id" UUID,
    "service_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "blocked_until" TIMESTAMPTZ(6) NOT NULL,
    "business_day" DATE NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'SCHEDULED',
    "base_cost_fils" INTEGER NOT NULL,
    "source_channel" "SourceChannel" NOT NULL,
    "attribution_id" UUID,
    "actual_arrival_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "cancellation_reason" TEXT,
    "notes" TEXT,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "branch_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "kind" "PaymentKind" NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount_fils" INTEGER NOT NULL,
    "business_day" DATE NOT NULL,
    "collected_by_user_id" UUID NOT NULL,
    "collected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "external_ref" TEXT,
    "reverses_payment_id" UUID,
    "note" TEXT,
    "idempotency_key" TEXT,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tips" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "branch_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "type" "TipType" NOT NULL,
    "amount_fils" INTEGER NOT NULL,
    "method" "PaymentMethod",
    "payment_id" UUID,
    "business_day" DATE NOT NULL,
    "recorded_by_user_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversed_by_tip_id" UUID,
    "note" TEXT,

    CONSTRAINT "tips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "therapist_payout_ledger" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "branch_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "entry_type" "LedgerEntryType" NOT NULL,
    "amount_fils" INTEGER NOT NULL,
    "business_day" DATE NOT NULL,
    "reservation_id" UUID,
    "tip_id" UUID,
    "payout_batch_id" UUID,
    "reverses_entry_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "therapist_payout_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_batches" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "branch_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "total_fils" INTEGER NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "paid_at" TIMESTAMPTZ(6) NOT NULL,
    "approved_by_user_id" UUID NOT NULL,
    "acknowledged_at" TIMESTAMPTZ(6),
    "note" TEXT,

    CONSTRAINT "payout_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_audit_log" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "branch_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "actor_role" "UserRole",
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "before_state" JSONB,
    "after_state" JSONB,
    "amount_fils" INTEGER,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "request_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "financial_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attribution_snapshots" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "visitor_id" UUID NOT NULL,
    "first_touch" JSONB NOT NULL,
    "last_touch" JSONB NOT NULL,
    "touches" JSONB NOT NULL,
    "touch_count" INTEGER NOT NULL,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL,
    "landing_path" TEXT,
    "captured_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pruned_at" TIMESTAMPTZ(6),

    CONSTRAINT "attribution_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbound_clicks" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v7(),
    "visitor_id" UUID,
    "target" TEXT NOT NULL,
    "context" TEXT,
    "landing_path" TEXT,
    "utm_source" TEXT,
    "utm_medium" TEXT,
    "utm_campaign" TEXT,
    "gclid" TEXT,
    "fbclid" TEXT,
    "referrer" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbound_clicks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "key" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status_code" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_employee_id_key" ON "users"("employee_id");

-- CreateIndex
CREATE INDEX "users_branch_id_role_idx" ON "users"("branch_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_revoked_at_idx" ON "refresh_tokens"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "service_categories_name_key" ON "service_categories"("name");

-- CreateIndex
CREATE INDEX "services_branch_id_is_active_idx" ON "services"("branch_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "rooms_branch_id_name_key" ON "rooms"("branch_id", "name");

-- CreateIndex
CREATE INDEX "employees_branch_id_status_idx" ON "employees"("branch_id", "status");

-- CreateIndex
CREATE INDEX "shifts_branch_id_business_day_idx" ON "shifts"("branch_id", "business_day");

-- CreateIndex
CREATE UNIQUE INDEX "shifts_employee_id_business_day_key" ON "shifts"("employee_id", "business_day");

-- CreateIndex
CREATE INDEX "guests_branch_id_full_name_idx" ON "guests"("branch_id", "full_name");

-- CreateIndex
CREATE UNIQUE INDEX "guests_branch_id_phone_key" ON "guests"("branch_id", "phone");

-- CreateIndex
CREATE INDEX "guest_consents_guest_id_type_idx" ON "guest_consents"("guest_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "booking_requests_attribution_id_key" ON "booking_requests"("attribution_id");

-- CreateIndex
CREATE UNIQUE INDEX "booking_requests_converted_reservation_id_key" ON "booking_requests"("converted_reservation_id");

-- CreateIndex
CREATE INDEX "booking_requests_branch_id_status_created_at_idx" ON "booking_requests"("branch_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "reservations_ref_key" ON "reservations"("ref");

-- CreateIndex
CREATE INDEX "reservations_branch_id_business_day_status_idx" ON "reservations"("branch_id", "business_day", "status");

-- CreateIndex
CREATE INDEX "reservations_employee_id_starts_at_idx" ON "reservations"("employee_id", "starts_at");

-- CreateIndex
CREATE INDEX "reservations_guest_id_starts_at_idx" ON "reservations"("guest_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "payments_idempotency_key_key" ON "payments"("idempotency_key");

-- CreateIndex
CREATE INDEX "payments_branch_id_business_day_kind_idx" ON "payments"("branch_id", "business_day", "kind");

-- CreateIndex
CREATE INDEX "payments_reservation_id_idx" ON "payments"("reservation_id");

-- CreateIndex
CREATE UNIQUE INDEX "tips_payment_id_key" ON "tips"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "tips_reversed_by_tip_id_key" ON "tips"("reversed_by_tip_id");

-- CreateIndex
CREATE INDEX "tips_employee_id_business_day_idx" ON "tips"("employee_id", "business_day");

-- CreateIndex
CREATE INDEX "tips_branch_id_business_day_type_idx" ON "tips"("branch_id", "business_day", "type");

-- CreateIndex
CREATE UNIQUE INDEX "therapist_payout_ledger_reverses_entry_id_key" ON "therapist_payout_ledger"("reverses_entry_id");

-- CreateIndex
CREATE INDEX "therapist_payout_ledger_employee_id_created_at_idx" ON "therapist_payout_ledger"("employee_id", "created_at");

-- CreateIndex
CREATE INDEX "therapist_payout_ledger_branch_id_business_day_idx" ON "therapist_payout_ledger"("branch_id", "business_day");

-- CreateIndex
CREATE INDEX "payout_batches_employee_id_period_end_idx" ON "payout_batches"("employee_id", "period_end");

-- CreateIndex
CREATE INDEX "financial_audit_log_entity_type_entity_id_created_at_idx" ON "financial_audit_log"("entity_type", "entity_id", "created_at");

-- CreateIndex
CREATE INDEX "financial_audit_log_actor_user_id_created_at_idx" ON "financial_audit_log"("actor_user_id", "created_at");

-- CreateIndex
CREATE INDEX "financial_audit_log_branch_id_created_at_idx" ON "financial_audit_log"("branch_id", "created_at");

-- CreateIndex
CREATE INDEX "attribution_snapshots_visitor_id_idx" ON "attribution_snapshots"("visitor_id");

-- CreateIndex
CREATE INDEX "attribution_snapshots_captured_at_idx" ON "attribution_snapshots"("captured_at");

-- CreateIndex
CREATE INDEX "outbound_clicks_target_created_at_idx" ON "outbound_clicks"("target", "created_at");

-- CreateIndex
CREATE INDEX "outbound_clicks_visitor_id_idx" ON "outbound_clicks"("visitor_id");

-- CreateIndex
CREATE INDEX "idempotency_records_expires_at_idx" ON "idempotency_records"("expires_at");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "service_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guests" ADD CONSTRAINT "guests_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guest_consents" ADD CONSTRAINT "guest_consents_guest_id_fkey" FOREIGN KEY ("guest_id") REFERENCES "guests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_requests" ADD CONSTRAINT "booking_requests_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_requests" ADD CONSTRAINT "booking_requests_guest_id_fkey" FOREIGN KEY ("guest_id") REFERENCES "guests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_requests" ADD CONSTRAINT "booking_requests_requested_service_id_fkey" FOREIGN KEY ("requested_service_id") REFERENCES "services"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_requests" ADD CONSTRAINT "booking_requests_attribution_id_fkey" FOREIGN KEY ("attribution_id") REFERENCES "attribution_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_requests" ADD CONSTRAINT "booking_requests_converted_reservation_id_fkey" FOREIGN KEY ("converted_reservation_id") REFERENCES "reservations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_guest_id_fkey" FOREIGN KEY ("guest_id") REFERENCES "guests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_attribution_id_fkey" FOREIGN KEY ("attribution_id") REFERENCES "attribution_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tips" ADD CONSTRAINT "tips_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tips" ADD CONSTRAINT "tips_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tips" ADD CONSTRAINT "tips_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tips" ADD CONSTRAINT "tips_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "therapist_payout_ledger" ADD CONSTRAINT "therapist_payout_ledger_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "therapist_payout_ledger" ADD CONSTRAINT "therapist_payout_ledger_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "therapist_payout_ledger" ADD CONSTRAINT "therapist_payout_ledger_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "therapist_payout_ledger" ADD CONSTRAINT "therapist_payout_ledger_payout_batch_id_fkey" FOREIGN KEY ("payout_batch_id") REFERENCES "payout_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_batches" ADD CONSTRAINT "payout_batches_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_batches" ADD CONSTRAINT "payout_batches_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "financial_audit_log" ADD CONSTRAINT "financial_audit_log_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The shared rate-limit counter. Spec §12.4.
--
-- @nestjs/throttler's default storage is a Map in the process. That was
-- adequate while the API was one long-lived container and wrong the moment it
-- stopped being one: every instance keeps its own Map, so "5 login attempts per
-- 15 minutes" becomes 5 × however many instances are warm. A brute-force
-- control whose limit is multiplied by a number nobody controls is not a
-- control. This table is where the count lives instead.
--
-- WHY POSTGRES AND NOT REDIS
--
-- Redis would be the reflex. It would also be a second data store, a second
-- vendor, a second DPA and a new row in docs/compliance/data-processing-register.md
-- — for a spa doing tens of bookings a night. One counter row per (route,
-- caller) with one UPDATE per request is nothing for a database that is already
-- serving every booking. See src/common/pg-throttler.storage.ts.
--
-- NO FOREIGN KEYS, NO AUDIT TRIGGER, NO uuid_generate_v7()
--
-- Deliberate. This is disposable operational state, not a business record: any
-- row may be deleted at any time by the sweep and nothing downstream cares. The
-- append-only rules in §5.4 exist to protect money; applying them here would
-- make a rate-limit counter impossible to prune.

CREATE TABLE "rate_limit_counters" (
  -- ThrottlerGuard's own key: sha256(class-handler-throttler-tracker). The
  -- tracker is `user:<uuid>` for an authenticated caller and `ip:<addr>`
  -- otherwise, so no guest-identifying value is stored here in the clear.
  "key"             TEXT        NOT NULL,
  -- The named window. The key above already encodes it, but a caller may supply
  -- its own generateKey, and a rate limiter that silently merges two windows
  -- because of someone else's key format is a bug worth making impossible.
  "throttler"       TEXT        NOT NULL,
  "hits"            INTEGER     NOT NULL,
  "window_ends_at"  TIMESTAMPTZ(6) NOT NULL,
  "blocked_until"   TIMESTAMPTZ(6),

  CONSTRAINT "rate_limit_counters_pkey" PRIMARY KEY ("key", "throttler")
);

-- The sweep's index. It deletes the oldest expired rows first and stops at a
-- bounded batch, so this has to be an ordered scan and not a sequential one:
-- the sweep runs on a request path and must never become the slow part of a
-- booking.
CREATE INDEX "rate_limit_counters_window_ends_at_idx"
    ON "rate_limit_counters" ("window_ends_at");

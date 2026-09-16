-- Extensions and helper functions. Must run before any table that uses them.
-- Spec §5.1.

-- Required: lets a GiST index combine scalar equality with range overlap, which
-- is what makes the double-booking exclusion constraints in 0002 possible.
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── UUID v7 ───────────────────────────────────────────────────────────────
-- Time-ordered UUIDs index like a sequence without leaking a row count the way
-- bigserial does. Implemented in plain SQL rather than via the pg_uuidv7
-- extension, which is not available on managed Postgres including Supabase.
--
-- Method: take a v4 UUID (which already carries the right variant bits),
-- overlay the first 48 bits with a millisecond timestamp, then flip the version
-- nibble from 0100 (v4) to 0111 (v7).
--
-- Ordering: strictly increasing ACROSS milliseconds, random within a single
-- millisecond. RFC 9562 permits this, and index locality comes from the 48-bit
-- time prefix, not from total order.
CREATE OR REPLACE FUNCTION uuid_generate_v7()
RETURNS uuid
LANGUAGE plpgsql
VOLATILE PARALLEL SAFE
AS $$
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

-- ── The business day ──────────────────────────────────────────────────────
-- The spa opens at 11:00 and closes at 02:00 the FOLLOWING morning, so a
-- reservation at 01:30 on Tuesday belongs to Monday's trading day, Monday's
-- revenue report and Monday's shift.
--
-- A 6-hour cutover sits inside the 02:00-11:00 closed window, so it can never
-- split a live session. Grouping a report by date_trunc('day', ...) instead of
-- this function is a reporting bug, and it will be the one that makes a manager
-- distrust the whole system.
--
-- Genuinely IMMUTABLE: the timezone name is a literal, not a session setting.
CREATE OR REPLACE FUNCTION business_day(ts timestamptz)
RETURNS date
LANGUAGE sql
IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT ((ts AT TIME ZONE 'Asia/Dubai') - interval '6 hours')::date;
$$;

-- ── Human-readable reservation references ─────────────────────────────────
-- Reception reads "BR-2026-0417" over the phone. Nobody reads a UUID over the
-- phone. Restarted manually each January.
CREATE SEQUENCE IF NOT EXISTS reservation_ref_seq START WITH 1 INCREMENT BY 1;

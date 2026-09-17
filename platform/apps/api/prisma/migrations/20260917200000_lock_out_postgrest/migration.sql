-- Shut PostgREST out of every table. Spec §5 and §11.
--
-- ── THE PROBLEM THIS FIXES ───────────────────────────────────────────────────
--
-- Supabase does not only give you a database. It runs PostgREST in front of it,
-- and PostgREST automatically exposes EVERY table in the `public` schema over
-- the internet at https://<ref>.supabase.co/rest/v1/<table>, authenticated with
-- the project's publishable ("anon") key. That key is public by design — it is
-- meant to ship inside browser JavaScript.
--
-- The only thing standing between that endpoint and the data is row-level
-- security. On a fresh project RLS is OFF, so on the day this database was
-- created, `guests`, `payments`, `tips`, `therapist_payout_ledger` and
-- `financial_audit_log` were all readable AND writable by anyone holding a key
-- that is designed to be published. Every guest name and phone number, every
-- payment, and the audit log that exists precisely so it can be trusted after a
-- breach.
--
-- This application does not use PostgREST at all. NestJS talks to Postgres
-- directly through Prisma, as the `postgres` role. PostgREST is simply switched
-- on because that is Supabase's default, which makes this a pure exposure with
-- no compensating benefit.
--
-- ── WHY RLS WITH NO POLICIES IS THE RIGHT SHAPE ──────────────────────────────
--
-- RLS enabled + zero policies = deny everything, for every role that does not
-- bypass RLS. On this project:
--
--     anon           rolbypassrls = false   <- PostgREST's unauthenticated role
--     authenticated  rolbypassrls = false   <- PostgREST's logged-in role
--     postgres       rolbypassrls = TRUE    <- what Prisma connects as
--     service_role   rolbypassrls = TRUE    <- the secret key; never ship it
--
-- So this denies the two roles reachable from the internet and does not touch
-- the application. Writing policies instead would mean reimplementing the API's
-- entire authorisation model in SQL, in a second place, where it would drift.
-- There is nothing to allow: the answer for these roles is "no", always.
--
-- The REVOKE below is belt and braces. If a future migration or a console
-- session ever turns RLS off on a table, the missing grant still denies access.
-- Two independent mechanisms, because this is the data that cannot be un-leaked.
--
-- ── DELIBERATELY A LOOP ──────────────────────────────────────────────────────
--
-- Naming the tables here would mean a table added next year is exposed by
-- default and nobody notices, which is the same failure mode a hand-written
-- denylist has for the website's publish directory. This covers whatever is in
-- `public` at the time it runs; the assertion at the end fails the migration if
-- even one table is left uncovered.

DO $lock_out$
DECLARE
  r       record;
  v_roles text;
BEGIN
  -- WHICH OF POSTGREST'S ROLES ACTUALLY EXIST HERE?
  --
  -- On Supabase, both. On a stock PostgreSQL — a developer's laptop, and the
  -- postgres:16-alpine service Platform CI runs against — neither, because
  -- there is no PostgREST and nothing was ever granted to it. The first
  -- version of this migration named them unconditionally and CI failed with
  -- `role "anon" does not exist`, which is the correct response to a
  -- migration that assumed its own deployment target.
  --
  -- Detecting rather than assuming does NOT weaken the control. RLS below is
  -- enabled unconditionally, on every database; the REVOKE is the second of
  -- the two mechanisms and it is only meaningful where the grantee exists.
  SELECT string_agg(quote_ident(rolname), ', ' ORDER BY rolname)
    INTO v_roles
    FROM pg_roles
   WHERE rolname IN ('anon', 'authenticated');

  FOR r IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.relname);
    IF v_roles IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM %s', r.relname, v_roles);
    END IF;
  END LOOP;

  IF v_roles IS NULL THEN
    RAISE NOTICE
      'Neither anon nor authenticated exists on this database, so there is no PostgREST '
      'grant to revoke. RLS has still been enabled on every table. Expected on local '
      'PostgreSQL and in CI; if you see this against Supabase, stop and investigate.';
  ELSE
    RAISE NOTICE 'RLS enabled on every table in public, and all privileges revoked from %.', v_roles;
  END IF;
END
$lock_out$;

-- Nothing new should be granted to those roles by default either — same
-- existence check, same reason.
DO $default_privs$
DECLARE
  v_roles text;
BEGIN
  SELECT string_agg(quote_ident(rolname), ', ' ORDER BY rolname)
    INTO v_roles
    FROM pg_roles
   WHERE rolname IN ('anon', 'authenticated');

  IF v_roles IS NULL THEN
    RETURN;
  END IF;

  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM %s', v_roles);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %s', v_roles);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %s', v_roles);
END
$default_privs$;

-- Refuse to finish if a single table was missed. A migration that half-applies
-- a security control is worse than one that fails, because it reports success.
DO $assert$
DECLARE
  n_unprotected int;
BEGIN
  SELECT count(*) INTO n_unprotected
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity;

  IF n_unprotected > 0 THEN
    RAISE EXCEPTION 'RLS is still disabled on % table(s) in public', n_unprotected;
  END IF;
END
$assert$;

-- ── search_path on our own functions ─────────────────────────────────────────
--
-- All seven are SECURITY INVOKER, so this is hardening rather than a hole: it
-- stops a caller whose search_path names a schema they control from shadowing
-- `branches` or `now()` and changing what a trigger does. Cheap, and it clears
-- the seven advisor warnings so the next real one is not lost among them.
--
-- `public` must stay on the path: business_day() and the trigger functions
-- reference tables there, and btree_gist's operator classes live there too.
ALTER FUNCTION public.uuid_generate_v7()                 SET search_path = public, pg_temp;
ALTER FUNCTION public.business_day(timestamptz)          SET search_path = public, pg_temp;
ALTER FUNCTION public.reservations_derive_columns()      SET search_path = public, pg_temp;
ALTER FUNCTION public.reservations_guard_status()        SET search_path = public, pg_temp;
ALTER FUNCTION public.forbid_mutation()                  SET search_path = public, pg_temp;
ALTER FUNCTION public.ledger_guard()                     SET search_path = public, pg_temp;
ALTER FUNCTION public.prune_attribution(int)             SET search_path = public, pg_temp;

-- NOT DONE, on purpose: the advisor also flags btree_gist as installed in
-- `public`. Moving it would require every exclusion constraint's operator class
-- to resolve through the new schema, and those three constraints are the single
-- most important thing in this database. The risk of moving it exceeds the
-- benefit of silencing one warning about an extension that exposes no data.

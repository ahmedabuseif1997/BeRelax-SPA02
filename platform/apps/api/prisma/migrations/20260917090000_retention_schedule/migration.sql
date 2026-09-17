-- Scheduling the retention job. Spec §5.6 and §11.6.
--
-- The `prune_attribution()` function itself was created by 20260916200400_retention;
-- this migration is the half that makes it actually RUN. A retention policy that
-- exists only as a function nobody calls is a policy the business does not have,
-- and §11.6 is a commitment to a regulator, not a comment.
--
-- WHY THIS IS WRAPPED IN A DO BLOCK
--
-- `pg_cron` is available on Supabase and absent from a stock local Postgres and
-- from the docker-compose image this repository's tests run against. A migration
-- that assumes one of those two worlds breaks the other, and a migration that
-- only applies on one environment is a broken migration: `prisma migrate deploy`
-- would fail on CI, or `prisma migrate dev` would fail on a laptop, and either
-- way somebody starts passing --skip and stops trusting the migration history.
--
-- So: check `pg_extension`, schedule if it is there, RAISE NOTICE if it is not.
-- A notice is visible in the migration output without failing the deploy, and
-- `GET /v1/compliance/processing-register` reports `retentionJob.scheduled`
-- afterwards — so an unscheduled production database is a finding in the
-- register rather than a silence.
--
-- 03:30 UTC is 07:30 Dubai: after the spa closes at 02:00, before the morning
-- shift. A prune that runs while reception is taking a booking competes with the
-- work; a prune that runs at 07:30 competes with nobody.

DO $retention_schedule$
DECLARE
  retention_days int := 90;   -- ATTRIBUTION_RETENTION_DAYS. §11.6.
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE
      'pg_cron is not installed on this database, so prune_attribution(%) was NOT scheduled. '
      'This is expected on local Postgres and in CI. On Supabase, enable the pg_cron extension '
      'and re-run this migration, or schedule it by hand: '
      'SELECT cron.schedule(''prune-attribution'', ''30 3 * * *'', $job$SELECT prune_attribution(90)$job$);',
      retention_days;
    RETURN;
  END IF;

  BEGIN
    -- Idempotent. `cron.schedule` updates a job of the same name in recent
    -- versions and inserts a duplicate in older ones, so the old one is removed
    -- first and the migration can be replayed onto a database that already has it.
    PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'prune-attribution';

    PERFORM cron.schedule(
      'prune-attribution',
      '30 3 * * *',
      format('SELECT prune_attribution(%s)', retention_days)
    );

    RAISE NOTICE 'Scheduled prune-attribution at 03:30 UTC (07:30 Dubai), retention % days.', retention_days;
  EXCEPTION
    WHEN insufficient_privilege OR undefined_table OR undefined_function THEN
      -- The extension is installed but this role cannot reach the cron schema —
      -- true on some managed platforms where only the project owner may schedule.
      -- Worth a notice and not worth failing a deploy over.
      RAISE NOTICE
        'pg_cron is installed but this role cannot schedule jobs (%). Schedule prune-attribution manually.',
        SQLERRM;
  END;
END
$retention_schedule$;

-- ─────────────────────────────────────────────────────────────────────────────
-- THE OTHER HALF, DELIBERATELY NOT SCHEDULED HERE
--
-- Guest identity is anonymised three years after the last visit (§11.6), and
-- that half is NOT a pg_cron job. Anonymising a guest writes a GUEST_ERASED row
-- to `financial_audit_log` with an actor, severs the attribution snapshots,
-- rewrites the enquiry inbox and clears the click log — the same work the
-- erasure endpoint does, because §11.4 and §11.6 must not be able to disagree
-- about what "erased" means. Reimplementing that in SQL would create a second
-- definition, and the second definition is always the one that drifts.
--
-- It runs through the application instead:
--
--   POST /v1/compliance/retention/run     (OWNER)   { "dryRun": true }   to look
--   POST /v1/compliance/retention/run     (OWNER)   { }                  to do it
--
-- Point a platform scheduler (Railway cron, a GitHub Actions schedule, or
-- Supabase's pg_net if the API is reachable from the database) at that endpoint
-- nightly with an OWNER token. Run it with `dryRun` first against real data: the
-- first pass over a guest book that has never been pruned is the one where a
-- mistake anonymises three years of guests at once, and it cannot be undone —
-- ERASURE_SALT is one-way by design.

-- Retention. Spec §5.6 and §11.6.
--
-- Strips identifying fields from attribution snapshots past the 90-day window
-- while keeping the aggregate channel data reporting needs. Attribution is
-- consent-based personal data; keeping it beyond its stated window would be a
-- PDPL problem even though no name is attached to it.
CREATE OR REPLACE FUNCTION prune_attribution(retention_days int DEFAULT 90)
RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  n int;
BEGIN
  WITH pruned AS (
    UPDATE attribution_snapshots
       SET visitor_id   = '00000000-0000-0000-0000-000000000000'::uuid,
           touches      = '[]'::jsonb,
           first_touch  = jsonb_build_object('source',   first_touch->>'source',
                                             'medium',   first_touch->>'medium',
                                             'campaign', first_touch->>'campaign'),
           last_touch   = jsonb_build_object('source',   last_touch->>'source',
                                             'medium',   last_touch->>'medium',
                                             'campaign', last_touch->>'campaign'),
           landing_path = NULL,
           pruned_at    = now()
     WHERE pruned_at IS NULL
       AND captured_at < now() - make_interval(days => retention_days)
    RETURNING 1
  )
  SELECT count(*) INTO n FROM pruned;

  DELETE FROM outbound_clicks      WHERE created_at < now() - make_interval(days => retention_days);
  DELETE FROM idempotency_records  WHERE expires_at < now();
  DELETE FROM refresh_tokens       WHERE expires_at < now() - interval '30 days';

  RETURN n;
END;
$$;

-- On Supabase, schedule with pg_cron. 03:30 UTC is 07:30 Dubai -- after the spa
-- closes at 02:00, before the morning shift.
--
--   SELECT cron.schedule('prune-attribution', '30 3 * * *',
--                        $$SELECT prune_attribution(90)$$);

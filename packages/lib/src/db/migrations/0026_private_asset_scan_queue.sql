SET ROLE selena_schema_owner;

CREATE OR REPLACE FUNCTION selena_registry.claim_next_quarantined_asset(
  p_lease_seconds integer DEFAULT 300
) RETURNS TABLE (
  id uuid,
  organization_id text,
  brand_id text,
  content_version_id uuid,
  storage_bucket text,
  storage_key text,
  sha256 text,
  mime_type text,
  scan_attempts integer,
  scan_lease_token uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, selena_registry
AS $$
BEGIN
  IF p_lease_seconds < 30 OR p_lease_seconds > 1800 THEN
    RAISE EXCEPTION 'Scanner lease must be between 30 and 1800 seconds';
  END IF;

  IF NOT pg_has_role(session_user, 'selena_scanner_runtime', 'member')
    OR current_setting('app.selena_service_identity', true) <> 'scanner'
    OR current_setting('app.selena_actor_id', true) <> 'service:scanner'
    OR current_setting('app.selena_auth_type', true) <> 'service' THEN
    RAISE EXCEPTION 'Only the scanner runtime may claim Selena assets';
  END IF;

  RETURN QUERY
  WITH candidate AS (
    SELECT a.id
    FROM selena_registry.content_assets a
    WHERE a.object_version_id IS NOT NULL
      AND (
        (a.scan_status = 'QUARANTINED' AND a.scan_available_at <= now())
        OR (a.scan_status = 'SCANNING' AND a.scan_lease_expires_at <= now())
      )
    ORDER BY a.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  ), claimed AS (
    UPDATE selena_registry.content_assets a
    SET scan_status = 'SCANNING',
        scan_started_at = now(),
        scan_attempts = a.scan_attempts + 1,
        scan_lease_token = gen_random_uuid(),
        scan_lease_expires_at = now() + make_interval(secs => p_lease_seconds),
        scan_error = NULL,
        rejection_reason = NULL
    FROM candidate c
    WHERE a.id = c.id
    RETURNING a.*
  )
  SELECT c.id, c.organization_id, c.brand_id, c.content_version_id, c.storage_bucket,
         c.storage_key, c.sha256, c.mime_type, c.scan_attempts, c.scan_lease_token
  FROM claimed c;
END;
$$;

REVOKE ALL ON FUNCTION selena_registry.claim_next_quarantined_asset(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION selena_registry.claim_next_quarantined_asset(integer)
  TO selena_scanner_runtime;

DO $$
BEGIN
  IF has_table_privilege('selena_web_runtime', 'selena_registry.content_assets', 'INSERT') THEN
    RAISE EXCEPTION 'web runtime must not insert content asset records';
  END IF;
  IF has_table_privilege('selena_web_runtime', 'selena_registry.content_assets', 'UPDATE') THEN
    RAISE EXCEPTION 'web runtime must not update content asset records';
  END IF;
  IF NOT has_table_privilege('selena_scanner_runtime', 'selena_registry.content_assets', 'INSERT') THEN
    RAISE EXCEPTION 'scanner runtime requires content asset INSERT';
  END IF;
END $$;

RESET ROLE;

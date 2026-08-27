SET ROLE selena_schema_owner;

-- A provider response is stored once as immutable evidence and is then linked
-- to exactly one normalized metrics snapshot for that definition version.
CREATE UNIQUE INDEX IF NOT EXISTS metric_snapshots_raw_definition_unique
  ON selena_performance.metric_snapshots (raw_snapshot_id, definition_version)
  WHERE raw_snapshot_id IS NOT NULL;

CREATE POLICY raw_platform_snapshots_schema_owner_select ON selena_ingest_raw.raw_platform_snapshots
  FOR SELECT TO selena_schema_owner USING (true);
CREATE POLICY raw_platform_snapshots_schema_owner_insert ON selena_ingest_raw.raw_platform_snapshots
  FOR INSERT TO selena_schema_owner WITH CHECK (true);
CREATE POLICY metric_snapshots_schema_owner_select ON selena_performance.metric_snapshots
  FOR SELECT TO selena_schema_owner USING (true);
CREATE POLICY metric_snapshots_schema_owner_insert ON selena_performance.metric_snapshots
  FOR INSERT TO selena_schema_owner WITH CHECK (true);

GRANT USAGE ON SCHEMA selena_registry TO selena_ingestion_runtime;
REVOKE SELECT, INSERT ON selena_ingest_raw.raw_platform_snapshots FROM selena_ingestion_runtime;
REVOKE INSERT ON selena_performance.metric_snapshots FROM selena_ingestion_runtime;

CREATE OR REPLACE FUNCTION selena_ingest_raw.record_postiz_performance_snapshot(
  p_publication_attempt_id uuid,
  p_request_key text,
  p_window_started_at timestamptz,
  p_window_ended_at timestamptz,
  p_captured_at timestamptz,
  p_payload jsonb,
  p_payload_sha256 text,
  p_definition_version text,
  p_quality selena_performance.metric_quality,
  p_values jsonb
) RETURNS TABLE (raw_snapshot_id uuid, metric_snapshot_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, selena_ingest_raw, selena_performance, selena_registry, selena_release
AS $$
#variable_conflict use_column
DECLARE
  v_attempt selena_release.publication_attempts%ROWTYPE;
  v_account selena_registry.channel_accounts%ROWTYPE;
  v_raw selena_ingest_raw.raw_platform_snapshots%ROWTYPE;
  v_metric selena_performance.metric_snapshots%ROWTYPE;
BEGIN
  IF NOT pg_has_role(session_user, 'selena_ingestion_runtime', 'member')
    OR current_setting('app.selena_service_identity', true) IS DISTINCT FROM 'ingestion'
    OR current_setting('app.selena_actor_id', true) IS DISTINCT FROM 'service:ingestion'
    OR current_setting('app.selena_auth_type', true) IS DISTINCT FROM 'service' THEN
    RAISE EXCEPTION 'Only the ingestion runtime may record Postiz performance';
  END IF;
  IF length(btrim(p_request_key)) <> 64 OR p_request_key !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Postiz ingestion request key must be a SHA-256 value';
  END IF;
  IF length(btrim(p_payload_sha256)) <> 64 OR p_payload_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'Postiz payload hash must be a SHA-256 value';
  END IF;
  IF length(btrim(p_definition_version)) = 0 OR jsonb_typeof(p_payload) <> 'array' OR jsonb_typeof(p_values) <> 'object' THEN
    RAISE EXCEPTION 'Postiz ingestion payload is invalid';
  END IF;
  IF p_window_started_at > p_window_ended_at OR p_captured_at < p_window_ended_at THEN
    RAISE EXCEPTION 'Postiz ingestion timestamps are invalid';
  END IF;
  IF COALESCE(p_values ->> 'provider', '') <> 'postiz' THEN
    RAISE EXCEPTION 'Postiz normalized values must retain provider attribution';
  END IF;

  SELECT attempt.* INTO v_attempt
  FROM selena_release.publication_attempts AS attempt
  WHERE attempt.id = p_publication_attempt_id
    AND attempt.organization_id = current_setting('app.selena_organization_id', true)
    AND attempt.brand_id = current_setting('app.selena_brand_id', true);
  IF NOT FOUND THEN RAISE EXCEPTION 'Publication attempt is not available for this brand'; END IF;
  IF v_attempt.platform <> 'linkedin_page' OR v_attempt.provider_reference_id IS NULL THEN
    RAISE EXCEPTION 'Postiz performance requires a provider-accepted LinkedIn Page attempt';
  END IF;

  SELECT account.* INTO v_account
  FROM selena_registry.channel_accounts AS account
  WHERE account.id = v_attempt.channel_account_id
    AND account.organization_id = v_attempt.organization_id
    AND account.brand_id = v_attempt.brand_id
    AND account.platform = 'linkedin_page';
  IF NOT FOUND THEN RAISE EXCEPTION 'Publication attempt has no matching LinkedIn Page account'; END IF;

  INSERT INTO selena_ingest_raw.raw_platform_snapshots (
    organization_id, brand_id, channel_account_id, provider, checkpoint, request_key,
    window_started_at, window_ended_at, captured_at, payload, payload_sha256
  ) VALUES (
    v_attempt.organization_id, v_attempt.brand_id, v_attempt.channel_account_id, 'postiz', 'analytics', p_request_key,
    p_window_started_at, p_window_ended_at, p_captured_at, p_payload, p_payload_sha256
  )
  ON CONFLICT (channel_account_id, request_key) DO NOTHING
  RETURNING * INTO v_raw;

  IF v_raw.id IS NULL THEN
    SELECT raw.* INTO v_raw
    FROM selena_ingest_raw.raw_platform_snapshots AS raw
    WHERE raw.channel_account_id = v_attempt.channel_account_id AND raw.request_key = p_request_key;
    IF NOT FOUND
      OR v_raw.organization_id <> v_attempt.organization_id
      OR v_raw.brand_id <> v_attempt.brand_id
      OR v_raw.provider <> 'postiz'
      OR v_raw.checkpoint <> 'analytics'
      OR v_raw.payload_sha256 <> p_payload_sha256
      OR v_raw.payload <> p_payload
      OR v_raw.window_started_at <> p_window_started_at
      OR v_raw.window_ended_at <> p_window_ended_at THEN
      RAISE EXCEPTION 'Postiz request key conflicts with different immutable evidence';
    END IF;
  END IF;

  INSERT INTO selena_performance.metric_snapshots (
    organization_id, brand_id, publication_attempt_id, raw_snapshot_id, platform,
    observed_at, data_cutoff_at, definition_version, quality, values
  ) VALUES (
    v_attempt.organization_id, v_attempt.brand_id, v_attempt.id, v_raw.id, 'linkedin_page',
    p_captured_at, p_window_ended_at, p_definition_version, p_quality, p_values
  )
  ON CONFLICT (raw_snapshot_id, definition_version) WHERE raw_snapshot_id IS NOT NULL DO NOTHING
  RETURNING * INTO v_metric;

  IF v_metric.id IS NULL THEN
    SELECT metric.* INTO v_metric
    FROM selena_performance.metric_snapshots AS metric
    WHERE metric.raw_snapshot_id = v_raw.id AND metric.definition_version = p_definition_version;
    IF NOT FOUND
      OR v_metric.publication_attempt_id <> v_attempt.id
      OR v_metric.values <> p_values
      OR v_metric.quality <> p_quality THEN
      RAISE EXCEPTION 'Postiz metric definition conflicts with immutable evidence';
    END IF;
  END IF;

  RETURN QUERY SELECT v_raw.id, v_metric.id;
END;
$$;

REVOKE ALL ON FUNCTION selena_ingest_raw.record_postiz_performance_snapshot(
  uuid, text, timestamptz, timestamptz, timestamptz, jsonb, text, text, selena_performance.metric_quality, jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION selena_ingest_raw.record_postiz_performance_snapshot(
  uuid, text, timestamptz, timestamptz, timestamptz, jsonb, text, text, selena_performance.metric_quality, jsonb
) TO selena_ingestion_runtime;

DO $$
BEGIN
  IF has_table_privilege('selena_ingestion_runtime', 'selena_ingest_raw.raw_platform_snapshots', 'INSERT')
    OR has_table_privilege('selena_ingestion_runtime', 'selena_performance.metric_snapshots', 'INSERT') THEN
    RAISE EXCEPTION 'Postiz ingestion must use the raw-evidence boundary';
  END IF;
END $$;

RESET ROLE;

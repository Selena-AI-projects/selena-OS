SET ROLE selena_schema_owner;

-- ────────────────────────── inbox: contract 1.1 ──────────────────────────

ALTER TABLE selena_ingest_raw.aether_events DROP CONSTRAINT aether_events_event_type_check;
ALTER TABLE selena_ingest_raw.aether_events DROP CONSTRAINT aether_events_schema_version_check;
ALTER TABLE selena_ingest_raw.aether_events
  ADD CONSTRAINT aether_events_event_type_known
    CHECK (event_type IN ('task.result.ready', 'content.draft_ready')),
  ADD CONSTRAINT aether_events_schema_version_known
    CHECK (schema_version IN ('1', '1.1')),
  ADD CONSTRAINT aether_events_draft_needs_schema_1_1
    CHECK (event_type <> 'content.draft_ready' OR schema_version = '1.1');

-- A material event is projected once into a content version by the registry
-- worker. The outcome is recorded next to the event: either the version it
-- became, or the code of the reason it did not. Neither is ever overwritten.
ALTER TABLE selena_ingest_raw.aether_events
  ADD COLUMN projected_content_version_id uuid REFERENCES selena_registry.content_versions(id),
  ADD COLUMN projection_error text,
  ADD COLUMN projected_at timestamptz,
  ADD CONSTRAINT aether_events_projection_outcome_single
    CHECK (projected_content_version_id IS NULL OR projection_error IS NULL),
  ADD CONSTRAINT aether_events_projection_error_shape
    CHECK (projection_error IS NULL OR projection_error ~ '^[A-Z_]{3,64}$');

CREATE INDEX aether_events_unprojected_drafts_idx
  ON selena_ingest_raw.aether_events (received_at)
  WHERE event_type = 'content.draft_ready' AND projected_content_version_id IS NULL AND projection_error IS NULL;

-- The recording function learns conflicts. Version 1 treated a repeated
-- (aggregate, version) as either a duplicate or a stale event; a material
-- pipeline must not let changed content pass as a repeat, so the same version
-- carrying a different payload is refused with SQLSTATE SE409 and the receiver
-- answers 409. An identical payload under a new event id stays a duplicate.
CREATE OR REPLACE FUNCTION selena_ingest_raw.record_aether_event(
  p_event_id uuid,
  p_event_type text,
  p_schema_version text,
  p_source_project_id uuid,
  p_aggregate_id uuid,
  p_version integer,
  p_occurred_at timestamptz,
  p_trace_id uuid,
  p_payload jsonb,
  p_payload_sha256 text
) RETURNS TABLE (event_row_id uuid, outcome text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, selena_ingest_raw
AS $$
#variable_conflict use_column
DECLARE
  v_existing selena_ingest_raw.aether_events%ROWTYPE;
  v_same_version selena_ingest_raw.aether_events%ROWTYPE;
  v_latest_version integer;
  v_row selena_ingest_raw.aether_events%ROWTYPE;
BEGIN
  IF NOT pg_has_role(session_user, 'selena_ingestion_runtime', 'member')
    OR current_setting('app.selena_service_identity', true) IS DISTINCT FROM 'ingestion'
    OR current_setting('app.selena_auth_type', true) IS DISTINCT FROM 'service' THEN
    RAISE EXCEPTION 'Only the ingestion runtime may record Aether events';
  END IF;
  IF p_payload_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Aether payload hash must be a SHA-256 value';
  END IF;
  IF jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'Aether event payload must be an object';
  END IF;

  SELECT existing.* INTO v_existing
  FROM selena_ingest_raw.aether_events AS existing
  WHERE existing.event_id = p_event_id;
  IF FOUND THEN
    IF v_existing.aggregate_id <> p_aggregate_id
      OR v_existing.version <> p_version
      OR v_existing.payload_sha256 <> p_payload_sha256 THEN
      RAISE EXCEPTION 'Aether event id was reused for different content' USING ERRCODE = 'SE409';
    END IF;
    RETURN QUERY SELECT v_existing.id, 'duplicate'::text;
    RETURN;
  END IF;

  SELECT existing.* INTO v_same_version
  FROM selena_ingest_raw.aether_events AS existing
  WHERE existing.aggregate_id = p_aggregate_id AND existing.version = p_version;
  IF FOUND THEN
    IF v_same_version.payload_sha256 <> p_payload_sha256 THEN
      RAISE EXCEPTION 'Aether aggregate version was redelivered with different content' USING ERRCODE = 'SE409';
    END IF;
    RETURN QUERY SELECT v_same_version.id, 'duplicate'::text;
    RETURN;
  END IF;

  SELECT max(existing.version) INTO v_latest_version
  FROM selena_ingest_raw.aether_events AS existing
  WHERE existing.aggregate_id = p_aggregate_id;
  IF v_latest_version IS NOT NULL AND p_version < v_latest_version THEN
    RETURN QUERY SELECT NULL::uuid, 'stale'::text;
    RETURN;
  END IF;

  INSERT INTO selena_ingest_raw.aether_events (
    event_id, event_type, schema_version, source_project_id, aggregate_id,
    version, occurred_at, trace_id, payload, payload_sha256
  ) VALUES (
    p_event_id, p_event_type, p_schema_version, p_source_project_id, p_aggregate_id,
    p_version, p_occurred_at, p_trace_id, p_payload, p_payload_sha256
  )
  RETURNING * INTO v_row;

  RETURN QUERY SELECT v_row.id, 'recorded'::text;
END;
$$;

-- ─────────────────── content items learn where they came from ───────────────────

ALTER TABLE selena_registry.content_items
  ADD COLUMN kind text,
  ADD COLUMN external_source text,
  ADD COLUMN external_ref uuid,
  ADD COLUMN brief_ref uuid,
  ADD CONSTRAINT content_items_kind_known
    CHECK (kind IS NULL OR kind IN ('ARTICLE', 'SOCIAL_ADAPTATION', 'BRIEF', 'PAGE_UPDATE', 'VIDEO_SCRIPT')),
  ADD CONSTRAINT content_items_external_pair
    CHECK ((external_source IS NULL) = (external_ref IS NULL)),
  ADD CONSTRAINT content_items_external_source_known
    CHECK (external_source IS NULL OR external_source IN ('aether'));

-- One material aggregate is one content item in its brand, whatever the number
-- of events about it. This is what makes the projection idempotent.
CREATE UNIQUE INDEX content_items_external_ref_unique
  ON selena_registry.content_items (brand_id, external_source, external_ref)
  WHERE external_ref IS NOT NULL;
CREATE INDEX content_items_brief_idx ON selena_registry.content_items (brand_id, brief_ref) WHERE brief_ref IS NOT NULL;

-- ─────────────────── the registry worker as projection writer ───────────────────

GRANT USAGE ON SCHEMA selena_ingest_raw TO selena_registry_worker_runtime;
GRANT USAGE ON SCHEMA selena_audit TO selena_registry_worker_runtime;

GRANT SELECT (
  id, event_id, event_type, schema_version, source_project_id, aggregate_id, version,
  occurred_at, trace_id, payload, payload_sha256, received_at,
  projected_content_version_id, projection_error, projected_at
) ON selena_ingest_raw.aether_events TO selena_registry_worker_runtime;
GRANT SELECT (projected_content_version_id, projection_error, projected_at)
  ON selena_ingest_raw.aether_events TO selena_web_runtime;
CREATE POLICY aether_events_worker_select ON selena_ingest_raw.aether_events
  FOR SELECT TO selena_registry_worker_runtime USING (true);

GRANT SELECT, INSERT, UPDATE ON selena_registry.content_items TO selena_registry_worker_runtime;
GRANT SELECT, INSERT ON selena_registry.content_versions TO selena_registry_worker_runtime;
GRANT SELECT ON selena_registry.content_policies TO selena_registry_worker_runtime;
GRANT SELECT, INSERT ON selena_audit.audit_events TO selena_registry_worker_runtime;

CREATE POLICY content_items_worker_select ON selena_registry.content_items
  FOR SELECT TO selena_registry_worker_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['registry_worker']));
CREATE POLICY content_items_worker_insert ON selena_registry.content_items
  FOR INSERT TO selena_registry_worker_runtime
  WITH CHECK (selena_registry.can_write_brand(organization_id, brand_id, ARRAY['registry_worker']));
CREATE POLICY content_items_worker_update ON selena_registry.content_items
  FOR UPDATE TO selena_registry_worker_runtime
  USING (selena_registry.can_write_brand(organization_id, brand_id, ARRAY['registry_worker']))
  WITH CHECK (selena_registry.can_write_brand(organization_id, brand_id, ARRAY['registry_worker']));
CREATE POLICY content_versions_worker_select ON selena_registry.content_versions
  FOR SELECT TO selena_registry_worker_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['registry_worker']));
CREATE POLICY content_versions_worker_insert ON selena_registry.content_versions
  FOR INSERT TO selena_registry_worker_runtime
  WITH CHECK (selena_registry.can_write_brand(organization_id, brand_id, ARRAY['registry_worker']));
CREATE POLICY content_policies_worker_select ON selena_registry.content_policies
  FOR SELECT TO selena_registry_worker_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['registry_worker']));
CREATE POLICY audit_events_worker_select ON selena_audit.audit_events
  FOR SELECT TO selena_registry_worker_runtime
  USING (selena_registry.can_access_brand(organization_id, COALESCE(brand_id, current_setting('app.selena_brand_id', true)), ARRAY['registry_worker']));
CREATE POLICY audit_events_worker_insert ON selena_audit.audit_events
  FOR INSERT TO selena_registry_worker_runtime
  WITH CHECK (selena_registry.can_write_brand(organization_id, COALESCE(brand_id, current_setting('app.selena_brand_id', true)), ARRAY['registry_worker']));

-- Claiming and marking go through functions so the worker never needs UPDATE on
-- the inbox table: it can take the next unprojected material and record one
-- outcome for it, and nothing else.
CREATE FUNCTION selena_ingest_raw.claim_next_aether_draft_event()
RETURNS TABLE (
  event_row_id uuid, event_id uuid, schema_version text, source_project_id uuid, aggregate_id uuid,
  version integer, occurred_at timestamptz, trace_id uuid, payload jsonb, payload_sha256 text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, selena_ingest_raw
AS $$
BEGIN
  IF NOT pg_has_role(session_user, 'selena_registry_worker_runtime', 'member')
    OR current_setting('app.selena_service_identity', true) IS DISTINCT FROM 'registry_worker'
    OR current_setting('app.selena_actor_id', true) IS DISTINCT FROM 'service:registry-worker'
    OR current_setting('app.selena_auth_type', true) IS DISTINCT FROM 'service' THEN
    RAISE EXCEPTION 'Only the registry worker may claim Aether material events';
  END IF;
  RETURN QUERY
    SELECT e.id, e.event_id, e.schema_version, e.source_project_id, e.aggregate_id,
           e.version, e.occurred_at, e.trace_id, e.payload, e.payload_sha256
    FROM selena_ingest_raw.aether_events AS e
    WHERE e.event_type = 'content.draft_ready'
      AND e.projected_content_version_id IS NULL
      AND e.projection_error IS NULL
    ORDER BY e.received_at, e.version, e.id
    FOR UPDATE SKIP LOCKED
    LIMIT 1;
END;
$$;

CREATE FUNCTION selena_ingest_raw.mark_aether_event_projected(
  p_event_row_id uuid,
  p_content_version_id uuid,
  p_error text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, selena_ingest_raw
AS $$
BEGIN
  IF NOT pg_has_role(session_user, 'selena_registry_worker_runtime', 'member')
    OR current_setting('app.selena_service_identity', true) IS DISTINCT FROM 'registry_worker'
    OR current_setting('app.selena_actor_id', true) IS DISTINCT FROM 'service:registry-worker'
    OR current_setting('app.selena_auth_type', true) IS DISTINCT FROM 'service' THEN
    RAISE EXCEPTION 'Only the registry worker may mark Aether material events';
  END IF;
  IF (p_content_version_id IS NULL) = (p_error IS NULL) THEN
    RAISE EXCEPTION 'A projection outcome is either a content version or an error code';
  END IF;
  UPDATE selena_ingest_raw.aether_events
  SET projected_content_version_id = p_content_version_id,
      projection_error = p_error,
      projected_at = now()
  WHERE id = p_event_row_id
    AND event_type = 'content.draft_ready'
    AND projected_content_version_id IS NULL
    AND projection_error IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Aether material event is not awaiting projection';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION selena_ingest_raw.claim_next_aether_draft_event() FROM PUBLIC;
REVOKE ALL ON FUNCTION selena_ingest_raw.mark_aether_event_projected(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION selena_ingest_raw.claim_next_aether_draft_event() TO selena_registry_worker_runtime;
GRANT EXECUTE ON FUNCTION selena_ingest_raw.mark_aether_event_projected(uuid, uuid, text) TO selena_registry_worker_runtime;

DO $$
BEGIN
  IF has_table_privilege('selena_registry_worker_runtime', 'selena_ingest_raw.aether_events', 'INSERT')
    OR has_table_privilege('selena_registry_worker_runtime', 'selena_ingest_raw.aether_events', 'UPDATE')
    OR has_table_privilege('selena_registry_worker_runtime', 'selena_ingest_raw.aether_events', 'DELETE') THEN
    RAISE EXCEPTION 'The registry worker reads the inbox and marks it through a function only';
  END IF;
  IF has_table_privilege('selena_ingestion_runtime', 'selena_registry.content_items', 'SELECT')
    OR has_table_privilege('selena_ingestion_runtime', 'selena_registry.content_versions', 'INSERT') THEN
    RAISE EXCEPTION 'The receiver identity must not reach the content registry';
  END IF;
  IF has_function_privilege('selena_ingestion_runtime', 'selena_ingest_raw.claim_next_aether_draft_event()', 'EXECUTE')
    OR has_function_privilege('selena_web_runtime', 'selena_ingest_raw.mark_aether_event_projected(uuid, uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Projection claims and marks belong to the registry worker alone';
  END IF;
END $$;

RESET ROLE;

SET ROLE selena_schema_owner;

-- Events arriving from Aether. The sender's envelope is stored as it arrived,
-- because the receiver's job is to record what it was told, not to decide what
-- that meant: the Control Room reads the projection, and a disagreement about
-- interpretation can still be settled against the original bytes.
CREATE TABLE IF NOT EXISTS selena_ingest_raw.aether_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The wire idempotency key. A redelivery carries the same event_id, so the
  -- second arrival must not become a second inbox item.
  event_id          uuid NOT NULL UNIQUE,
  event_type        text NOT NULL CHECK (event_type IN ('task.result.ready')),
  schema_version    text NOT NULL CHECK (schema_version = '1'),

  -- Identifiers belong to Aether, not to this database, so they are recorded
  -- rather than joined: a foreign key here would make the receiver refuse
  -- events about projects it has not been told about yet.
  source_project_id uuid NOT NULL,
  aggregate_id      uuid NOT NULL,
  version           integer NOT NULL CHECK (version > 0),
  occurred_at       timestamptz NOT NULL,
  trace_id          uuid NOT NULL,

  payload           jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_sha256    text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  received_at       timestamptz NOT NULL DEFAULT now(),

  -- One row per version of an aggregate. Together with the version check in
  -- the recording function this is what makes redelivery and reordering safe.
  UNIQUE (aggregate_id, version)
);

CREATE INDEX IF NOT EXISTS aether_events_aggregate_idx
  ON selena_ingest_raw.aether_events (aggregate_id, version DESC);

ALTER TABLE selena_ingest_raw.aether_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY aether_events_schema_owner_select ON selena_ingest_raw.aether_events
  FOR SELECT TO selena_schema_owner USING (true);
CREATE POLICY aether_events_schema_owner_insert ON selena_ingest_raw.aether_events
  FOR INSERT TO selena_schema_owner WITH CHECK (true);

-- The ingestion runtime reaches this table only through the function below.
-- Direct INSERT would let a compromised receiver write any version it liked,
-- including one that walks an aggregate backwards.
REVOKE ALL ON selena_ingest_raw.aether_events FROM selena_ingestion_runtime;

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

  -- A redelivery is a normal event, not an error, so it reports 'duplicate'
  -- and changes nothing. It is still checked: the same event id carrying
  -- different content means something is wrong upstream and must not be
  -- accepted quietly.
  SELECT existing.* INTO v_existing
  FROM selena_ingest_raw.aether_events AS existing
  WHERE existing.event_id = p_event_id;
  IF FOUND THEN
    IF v_existing.aggregate_id <> p_aggregate_id
      OR v_existing.version <> p_version
      OR v_existing.payload_sha256 <> p_payload_sha256 THEN
      RAISE EXCEPTION 'Aether event id was reused for different content';
    END IF;
    RETURN QUERY SELECT v_existing.id, 'duplicate'::text;
    RETURN;
  END IF;

  -- Delivery order is not guaranteed, so an event no newer than what has
  -- already been recorded is dropped rather than applied on top of it.
  SELECT max(existing.version) INTO v_latest_version
  FROM selena_ingest_raw.aether_events AS existing
  WHERE existing.aggregate_id = p_aggregate_id;
  IF v_latest_version IS NOT NULL AND p_version <= v_latest_version THEN
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

REVOKE ALL ON FUNCTION selena_ingest_raw.record_aether_event(
  uuid, text, text, uuid, uuid, integer, timestamptz, uuid, jsonb, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION selena_ingest_raw.record_aether_event(
  uuid, text, text, uuid, uuid, integer, timestamptz, uuid, jsonb, text
) TO selena_ingestion_runtime;

-- The Control Room reads the events; it must never be able to write one.
GRANT USAGE ON SCHEMA selena_ingest_raw TO selena_web_runtime;
GRANT SELECT (
  id, event_id, event_type, source_project_id, aggregate_id, version,
  occurred_at, trace_id, payload, received_at
) ON selena_ingest_raw.aether_events TO selena_web_runtime;

CREATE POLICY aether_events_web_select ON selena_ingest_raw.aether_events
  FOR SELECT TO selena_web_runtime USING (true);

DO $$
BEGIN
  IF has_table_privilege('selena_ingestion_runtime', 'selena_ingest_raw.aether_events', 'INSERT') THEN
    RAISE EXCEPTION 'Aether ingestion must go through the recording function';
  END IF;
  IF has_table_privilege('selena_web_runtime', 'selena_ingest_raw.aether_events', 'INSERT')
    OR has_table_privilege('selena_web_runtime', 'selena_ingest_raw.aether_events', 'UPDATE')
    OR has_table_privilege('selena_web_runtime', 'selena_ingest_raw.aether_events', 'DELETE') THEN
    RAISE EXCEPTION 'The Control Room reads Aether events and never writes them';
  END IF;
  IF has_function_privilege('selena_web_runtime',
    'selena_ingest_raw.record_aether_event(uuid, text, text, uuid, uuid, integer, timestamptz, uuid, jsonb, text)',
    'EXECUTE') THEN
    RAISE EXCEPTION 'Only the ingestion runtime may record Aether events';
  END IF;
END $$;

RESET ROLE;

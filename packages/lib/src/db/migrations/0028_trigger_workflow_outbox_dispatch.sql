SET ROLE selena_schema_owner;

CREATE TABLE IF NOT EXISTS selena_release.workflow_dispatches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id text NOT NULL REFERENCES public.organization(id),
  brand_id text NOT NULL REFERENCES public.brands(id),
  outbox_event_id uuid NOT NULL REFERENCES selena_release.outbox_events(id),
  release_intent_id uuid NOT NULL REFERENCES selena_release.release_intents(id),
  correlation_id uuid NOT NULL,
  trigger_run_id text,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED',
  attempt_count integer NOT NULL DEFAULT 0,
  last_error text,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workflow_dispatches_status_valid CHECK (status IN ('QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'RECONCILIATION_REQUIRED', 'CANCELLED', 'COMPLETED', 'FAILED')),
  CONSTRAINT workflow_dispatches_attempt_count_nonnegative CHECK (attempt_count >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS workflow_dispatches_outbox_event_unique
  ON selena_release.workflow_dispatches (outbox_event_id);
CREATE UNIQUE INDEX IF NOT EXISTS workflow_dispatches_idempotency_unique
  ON selena_release.workflow_dispatches (idempotency_key);
CREATE INDEX IF NOT EXISTS workflow_dispatches_brand_status_idx
  ON selena_release.workflow_dispatches (brand_id, status, created_at);
ALTER TABLE selena_release.workflow_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE selena_release.workflow_dispatches FORCE ROW LEVEL SECURITY;

CREATE POLICY workflow_dispatches_web_select ON selena_release.workflow_dispatches
  FOR SELECT TO selena_web_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['web']));
CREATE POLICY workflow_dispatches_schema_owner_select ON selena_release.workflow_dispatches
  FOR SELECT TO selena_schema_owner USING (true);
CREATE POLICY workflow_dispatches_schema_owner_insert ON selena_release.workflow_dispatches
  FOR INSERT TO selena_schema_owner WITH CHECK (true);
CREATE POLICY workflow_dispatches_schema_owner_update ON selena_release.workflow_dispatches
  FOR UPDATE TO selena_schema_owner USING (true) WITH CHECK (true);
CREATE POLICY outbox_events_schema_owner_select ON selena_release.outbox_events
  FOR SELECT TO selena_schema_owner USING (true);
CREATE POLICY outbox_events_schema_owner_update ON selena_release.outbox_events
  FOR UPDATE TO selena_schema_owner USING (true) WITH CHECK (true);
CREATE POLICY incidents_schema_owner_insert ON selena_audit.incidents
  FOR INSERT TO selena_schema_owner WITH CHECK (true);

GRANT SELECT ON selena_release.workflow_dispatches TO selena_web_runtime;

CREATE OR REPLACE FUNCTION selena_release.claim_next_trigger_outbox(
  p_lease_seconds integer DEFAULT 300
) RETURNS TABLE (
  outbox_event_id uuid,
  release_intent_id uuid,
  organization_id text,
  brand_id text,
  correlation_id uuid,
  idempotency_key text,
  attempt_count integer,
  lease_owner text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, selena_registry, selena_release
AS $$
DECLARE
  v_lease_owner text;
BEGIN
  IF p_lease_seconds < 30 OR p_lease_seconds > 1800 THEN
    RAISE EXCEPTION 'Workflow outbox lease must be between 30 and 1800 seconds';
  END IF;
  IF NOT pg_has_role(session_user, 'selena_registry_worker_runtime', 'member')
    OR current_setting('app.selena_service_identity', true) IS DISTINCT FROM 'registry_worker'
    OR current_setting('app.selena_actor_id', true) IS DISTINCT FROM 'service:registry-worker'
    OR current_setting('app.selena_auth_type', true) IS DISTINCT FROM 'service' THEN
    RAISE EXCEPTION 'Only the registry worker may claim a Trigger workflow outbox event';
  END IF;

  v_lease_owner := current_setting('app.selena_correlation_id', true);
  RETURN QUERY
  WITH candidate AS (
    SELECT outbox.id
    FROM selena_release.outbox_events AS outbox
    WHERE outbox.event_type = 'release.intent_queued'
      AND (
        (outbox.status = 'PENDING' AND outbox.available_at <= now())
        OR (outbox.status = 'LEASED' AND outbox.lease_expires_at <= now())
      )
    ORDER BY outbox.available_at, outbox.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  ), claimed AS (
    UPDATE selena_release.outbox_events AS outbox
    SET status = 'LEASED',
        lease_owner = v_lease_owner,
        lease_expires_at = now() + make_interval(secs => p_lease_seconds),
        attempt_count = outbox.attempt_count + 1,
        last_error = NULL
    FROM candidate
    WHERE outbox.id = candidate.id
    RETURNING outbox.*
  )
  SELECT claimed.id, claimed.release_intent_id, claimed.organization_id, claimed.brand_id,
         intent.correlation_id, claimed.idempotency_key, claimed.attempt_count, v_lease_owner
  FROM claimed
  JOIN selena_release.release_intents AS intent ON intent.id = claimed.release_intent_id;
END;
$$;

CREATE OR REPLACE FUNCTION selena_release.record_trigger_workflow_dispatch(
  p_outbox_event_id uuid,
  p_lease_owner text,
  p_trigger_run_id text
) RETURNS TABLE (workflow_dispatch_id uuid, trigger_run_id text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, selena_registry, selena_release
AS $$
DECLARE
  v_outbox selena_release.outbox_events%ROWTYPE;
  v_intent selena_release.release_intents%ROWTYPE;
BEGIN
  IF NOT pg_has_role(session_user, 'selena_registry_worker_runtime', 'member')
    OR current_setting('app.selena_service_identity', true) IS DISTINCT FROM 'registry_worker'
    OR current_setting('app.selena_actor_id', true) IS DISTINCT FROM 'service:registry-worker'
    OR current_setting('app.selena_auth_type', true) IS DISTINCT FROM 'service' THEN
    RAISE EXCEPTION 'Only the registry worker may record a Trigger workflow dispatch';
  END IF;
  IF length(btrim(p_trigger_run_id)) = 0 THEN RAISE EXCEPTION 'Trigger run ID is required'; END IF;

  SELECT outbox.* INTO v_outbox
  FROM selena_release.outbox_events AS outbox
  WHERE outbox.id = p_outbox_event_id
    AND outbox.status = 'LEASED'
    AND outbox.lease_owner = p_lease_owner
    AND outbox.lease_expires_at > now();
  IF NOT FOUND THEN RAISE EXCEPTION 'Workflow outbox lease is not active'; END IF;
  SELECT intent.* INTO v_intent FROM selena_release.release_intents AS intent WHERE intent.id = v_outbox.release_intent_id;

  INSERT INTO selena_release.workflow_dispatches AS workflow (
    organization_id, brand_id, outbox_event_id, release_intent_id, correlation_id,
    trigger_run_id, idempotency_key, status, attempt_count
  ) VALUES (
    v_outbox.organization_id, v_outbox.brand_id, v_outbox.id, v_outbox.release_intent_id, v_intent.correlation_id,
    p_trigger_run_id, v_outbox.idempotency_key, 'RUNNING', v_outbox.attempt_count
  ) ON CONFLICT (outbox_event_id) DO UPDATE
    SET trigger_run_id = workflow.trigger_run_id,
        updated_at = now()
  RETURNING workflow.id, workflow.trigger_run_id INTO workflow_dispatch_id, trigger_run_id;

  UPDATE selena_release.outbox_events AS outbox
  SET status = 'DELIVERED', lease_owner = NULL, lease_expires_at = NULL, delivered_at = now()
  WHERE outbox.id = v_outbox.id;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION selena_release.retry_or_dead_letter_trigger_outbox(
  p_outbox_event_id uuid,
  p_lease_owner text,
  p_error text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, selena_audit, selena_registry, selena_release
AS $$
DECLARE
  v_outbox selena_release.outbox_events%ROWTYPE;
  v_status text;
BEGIN
  IF NOT pg_has_role(session_user, 'selena_registry_worker_runtime', 'member')
    OR current_setting('app.selena_service_identity', true) IS DISTINCT FROM 'registry_worker'
    OR current_setting('app.selena_actor_id', true) IS DISTINCT FROM 'service:registry-worker'
    OR current_setting('app.selena_auth_type', true) IS DISTINCT FROM 'service' THEN
    RAISE EXCEPTION 'Only the registry worker may retry a Trigger workflow outbox event';
  END IF;
  SELECT outbox.* INTO v_outbox
  FROM selena_release.outbox_events AS outbox
  WHERE outbox.id = p_outbox_event_id
    AND outbox.status = 'LEASED'
    AND outbox.lease_owner = p_lease_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'Workflow outbox lease is not active'; END IF;

  IF v_outbox.attempt_count >= v_outbox.max_attempts THEN
    UPDATE selena_release.outbox_events AS outbox
    SET status = 'DEAD_LETTER', lease_owner = NULL, lease_expires_at = NULL, last_error = left(p_error, 1000)
    WHERE outbox.id = v_outbox.id;
    INSERT INTO selena_audit.incidents (organization_id, brand_id, severity, code, summary, detected_by)
    VALUES (v_outbox.organization_id, v_outbox.brand_id, 'HIGH', 'TRIGGER_OUTBOX_DEAD_LETTER', left(p_error, 1000), 'service:registry-worker');
    RETURN 'DEAD_LETTER';
  END IF;

  UPDATE selena_release.outbox_events AS outbox
  SET status = 'PENDING', lease_owner = NULL, lease_expires_at = NULL,
      available_at = now() + make_interval(secs => LEAST(900, 30 * (2 ^ GREATEST(0, outbox.attempt_count - 1))::integer)),
      last_error = left(p_error, 1000)
  WHERE outbox.id = v_outbox.id;
  RETURN 'PENDING';
END;
$$;

REVOKE ALL ON FUNCTION selena_release.claim_next_trigger_outbox(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION selena_release.record_trigger_workflow_dispatch(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION selena_release.retry_or_dead_letter_trigger_outbox(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION selena_release.claim_next_trigger_outbox(integer) TO selena_registry_worker_runtime;
GRANT EXECUTE ON FUNCTION selena_release.record_trigger_workflow_dispatch(uuid, text, text) TO selena_registry_worker_runtime;
GRANT EXECUTE ON FUNCTION selena_release.retry_or_dead_letter_trigger_outbox(uuid, text, text) TO selena_registry_worker_runtime;

DO $$
BEGIN
  IF has_table_privilege('selena_trigger_runtime', 'selena_release.outbox_events', 'SELECT') THEN
    RAISE EXCEPTION 'Trigger runtime must not receive direct outbox access';
  END IF;
END $$;

RESET ROLE;

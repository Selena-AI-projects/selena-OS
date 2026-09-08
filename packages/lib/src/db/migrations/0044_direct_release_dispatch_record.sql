SET ROLE selena_schema_owner;

-- A release carried by the worker itself finishes before the outbox row is
-- closed, so the dispatch it records is already terminal. The Trigger path
-- records RUNNING because something else finishes the work later; recording
-- RUNNING here would leave a row that nothing can ever advance, and a queue of
-- permanently running releases is indistinguishable from a stuck one.
--
-- What the outcome was is not decided here: `record_postiz_submission_outcome`
-- has already written the publication attempt and moved the release intent.
-- This function only closes the queue entry and states how the carry ended.
CREATE OR REPLACE FUNCTION selena_release.record_direct_release_dispatch(
  p_outbox_event_id uuid,
  p_lease_owner text,
  p_reference text,
  p_status text
) RETURNS TABLE (workflow_dispatch_id uuid, dispatch_status text)
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
    RAISE EXCEPTION 'Only the registry worker may record a direct release dispatch';
  END IF;
  IF p_status NOT IN ('COMPLETED', 'FAILED', 'RECONCILIATION_REQUIRED') THEN
    RAISE EXCEPTION 'A direct release dispatch ends COMPLETED, FAILED or RECONCILIATION_REQUIRED';
  END IF;
  IF length(btrim(p_reference)) = 0 THEN RAISE EXCEPTION 'Direct release dispatch reference is required'; END IF;

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
    p_reference, v_outbox.idempotency_key, p_status, v_outbox.attempt_count
  ) ON CONFLICT (outbox_event_id) DO UPDATE
    SET status = EXCLUDED.status,
        updated_at = now()
  RETURNING workflow.id, workflow.status INTO workflow_dispatch_id, dispatch_status;

  UPDATE selena_release.outbox_events AS outbox
  SET status = 'DELIVERED', lease_owner = NULL, lease_expires_at = NULL, delivered_at = now()
  WHERE outbox.id = v_outbox.id;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION selena_release.record_direct_release_dispatch(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION selena_release.record_direct_release_dispatch(uuid, text, text, text) TO selena_registry_worker_runtime;

DO $$
BEGIN
  IF has_function_privilege('selena_web_runtime', 'selena_release.record_direct_release_dispatch(uuid, text, text, text)', 'EXECUTE')
    OR has_function_privilege('selena_gateway_runtime', 'selena_release.record_direct_release_dispatch(uuid, text, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Only the registry worker may close a release queue entry';
  END IF;
END $$;

RESET ROLE;

SET ROLE selena_schema_owner;

ALTER TYPE selena_release.release_intent_status ADD VALUE IF NOT EXISTS 'CANCEL_REQUESTED';
ALTER TYPE selena_release.outbox_event_status ADD VALUE IF NOT EXISTS 'CANCELLED';

CREATE OR REPLACE FUNCTION selena_release.request_release_cancellation(
  p_release_intent_id uuid,
  p_reason text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, selena_registry, selena_release
AS $$
DECLARE
  v_intent selena_release.release_intents%ROWTYPE;
  v_next_status text;
BEGIN
  IF NOT pg_has_role(session_user, 'selena_web_runtime', 'member')
    OR current_setting('app.selena_service_identity', true) IS DISTINCT FROM 'web'
    OR current_setting('app.selena_auth_type', true) IS DISTINCT FROM 'session'
    OR current_setting('app.selena_role', true) IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Only an interactive owner may request release cancellation';
  END IF;
  IF length(btrim(p_reason)) = 0 THEN RAISE EXCEPTION 'Release cancellation reason is required'; END IF;

  SELECT intent.* INTO v_intent
  FROM selena_release.release_intents AS intent
  WHERE intent.id = p_release_intent_id
    AND intent.organization_id = current_setting('app.selena_organization_id', true)
    AND intent.brand_id = current_setting('app.selena_brand_id', true)
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Release intent is not available for this brand'; END IF;
  IF v_intent.status = 'CANCELLED' THEN RETURN 'CANCELLED'; END IF;
  IF v_intent.status = 'CANCEL_REQUESTED' THEN RETURN 'CANCEL_REQUESTED'; END IF;
  IF v_intent.status IN ('FAILED', 'BLOCKED') THEN RAISE EXCEPTION 'Release intent is not cancellable'; END IF;

  v_next_status := CASE
    WHEN v_intent.status IN ('QUEUED', 'DISPATCHING') THEN 'CANCELLED'
    WHEN v_intent.status IN ('SUCCEEDED', 'UNKNOWN') THEN 'CANCEL_REQUESTED'
    ELSE 'CANCEL_REQUESTED'
  END;
  UPDATE selena_release.release_intents
  SET status = v_next_status::selena_release.release_intent_status,
      cancellation_reason = left(p_reason, 1000)
  WHERE id = v_intent.id;

  IF v_next_status = 'CANCELLED' THEN
    UPDATE selena_release.outbox_events
    SET status = 'CANCELLED', lease_owner = NULL, lease_expires_at = NULL, last_error = 'Cancelled by interactive owner'
    WHERE release_intent_id = v_intent.id AND status IN ('PENDING', 'LEASED');
    UPDATE selena_release.workflow_dispatches
    SET status = 'CANCELLED', cancelled_at = now(), updated_at = now()
    WHERE release_intent_id = v_intent.id AND status NOT IN ('CANCELLED', 'COMPLETED', 'FAILED');
  ELSE
    UPDATE selena_release.workflow_dispatches
    SET status = 'RECONCILIATION_REQUIRED', last_error = 'Cancellation requires provider reconciliation', updated_at = now()
    WHERE release_intent_id = v_intent.id AND status NOT IN ('CANCELLED', 'COMPLETED', 'FAILED');
  END IF;

  RETURN v_next_status;
END;
$$;

REVOKE ALL ON FUNCTION selena_release.request_release_cancellation(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION selena_release.request_release_cancellation(uuid, text) TO selena_web_runtime;

RESET ROLE;

SET ROLE selena_schema_owner;

-- When the provider refused to shape a release (publishing disabled, wrong
-- environment, or a kill switch), the dispatcher reports NOT_SENT, but
-- record_postiz_submission_outcome rejected that status outright. The gateway
-- answered 409 and the refusal could not be recorded, so a release that was
-- never sent could not reach a terminal state. NOT_SENT is a real, terminal
-- outcome: nothing was published and nothing should be retried for this
-- reservation. Record it as a NOT_SENT attempt classified as a publish refusal
-- and block the intent (not FAILED, which reads as a provider error, and not
-- an incident, which this expected refusal is not). The signature is unchanged,
-- so the gateway's EXECUTE grant carries over.
CREATE OR REPLACE FUNCTION selena_release.record_postiz_submission_outcome(
  p_reservation_id uuid,
  p_status selena_release.publication_attempt_status,
  p_provider_reference_id text DEFAULT NULL,
  p_error_detail text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, selena_audit, selena_registry, selena_release
AS $$
DECLARE
  v_reservation selena_release.dispatch_reservations%ROWTYPE;
  v_manifest selena_release.release_manifests%ROWTYPE;
  v_attempt_number integer;
  v_transition_number integer;
  v_attempt_id uuid;
  v_intent_id uuid;
BEGIN
  IF NOT pg_has_role(session_user, 'selena_gateway_runtime', 'member')
    OR current_setting('app.selena_service_identity', true) IS DISTINCT FROM 'gateway'
    OR current_setting('app.selena_actor_id', true) IS DISTINCT FROM 'service:gateway'
    OR current_setting('app.selena_auth_type', true) IS DISTINCT FROM 'service' THEN
    RAISE EXCEPTION 'Only the Release Gateway may record a Postiz submission outcome';
  END IF;
  IF p_status NOT IN ('ACCEPTED', 'DEFINITIVE_FAILURE', 'AMBIGUOUS', 'RECONCILE_REQUIRED', 'CONFIRMED', 'MANUAL_REVIEW', 'NOT_SENT') THEN
    RAISE EXCEPTION 'Postiz outcome status is invalid';
  END IF;
  SELECT reservation.* INTO v_reservation FROM selena_release.dispatch_reservations AS reservation WHERE reservation.id = p_reservation_id;
  IF NOT FOUND OR current_setting('app.selena_release_manifest_id', true) IS DISTINCT FROM v_reservation.release_manifest_id::text THEN
    RAISE EXCEPTION 'Gateway may only record an outcome for its exact manifest';
  END IF;
  SELECT manifest.* INTO v_manifest FROM selena_release.release_manifests AS manifest WHERE manifest.id = v_reservation.release_manifest_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Release manifest was not found'; END IF;
  IF p_status IN ('ACCEPTED', 'CONFIRMED') AND length(btrim(COALESCE(p_provider_reference_id, ''))) = 0 THEN
    RAISE EXCEPTION 'A confirmed Postiz outcome requires a provider post ID';
  END IF;

  SELECT attempt.attempt_number, attempt.transition_number
  INTO v_attempt_number, v_transition_number
  FROM selena_release.publication_attempts AS attempt
  WHERE attempt.reservation_id = p_reservation_id
  ORDER BY attempt.attempt_number DESC, attempt.transition_number DESC
  LIMIT 1;
  IF v_attempt_number IS NULL OR v_transition_number IS NULL THEN RAISE EXCEPTION 'Postiz reservation has no initial attempt'; END IF;
  IF EXISTS (
    SELECT 1 FROM selena_release.publication_attempts AS attempt
    WHERE attempt.reservation_id = p_reservation_id
      AND attempt.status IN ('ACCEPTED', 'AMBIGUOUS', 'RECONCILE_REQUIRED', 'CONFIRMED', 'MANUAL_REVIEW')
  ) THEN RAISE EXCEPTION 'Postiz reservation already has a terminal or ambiguous outcome'; END IF;

  INSERT INTO selena_release.publication_attempts AS attempt (
    organization_id, brand_id, reservation_id, release_manifest_id, channel_account_id, platform,
    integration_id, allowlist_reference, manifest_hash, attempt_number, transition_number, status,
    provider_request_id, provider_reference_id, error_classification, error_detail
  ) VALUES (
    v_manifest.organization_id, v_manifest.brand_id, v_reservation.id, v_manifest.id, v_manifest.channel_account_id, v_manifest.platform,
    v_reservation.integration_id, v_reservation.allowlist_reference, v_manifest.manifest_hash, v_attempt_number, v_transition_number + 1, p_status,
    NULL, p_provider_reference_id,
    CASE WHEN p_status IN ('AMBIGUOUS', 'RECONCILE_REQUIRED', 'MANUAL_REVIEW') THEN 'AMBIGUOUS_PROVIDER_RESULT'
      WHEN p_status = 'DEFINITIVE_FAILURE' THEN 'DEFINITIVE_PROVIDER_FAILURE'
      WHEN p_status = 'NOT_SENT' THEN 'PUBLISH_REFUSED' ELSE NULL END,
    CASE WHEN p_error_detail IS NULL THEN NULL ELSE left(p_error_detail, 1000) END
  ) RETURNING attempt.id INTO v_attempt_id;

  v_intent_id := (v_manifest.manifest ->> 'releaseIntentId')::uuid;
  IF p_status IN ('ACCEPTED', 'CONFIRMED') THEN
    UPDATE selena_release.release_intents SET status = 'SUCCEEDED' WHERE id = v_intent_id;
  ELSIF p_status = 'DEFINITIVE_FAILURE' THEN
    UPDATE selena_release.release_intents SET status = 'FAILED' WHERE id = v_intent_id;
  ELSIF p_status = 'NOT_SENT' THEN
    -- Nothing was sent and nothing is pending reconciliation; the intent is
    -- blocked, not failed, and no incident is raised for an expected refusal.
    UPDATE selena_release.release_intents SET status = 'BLOCKED' WHERE id = v_intent_id;
  ELSE
    UPDATE selena_release.release_intents SET status = 'UNKNOWN' WHERE id = v_intent_id;
    INSERT INTO selena_audit.incidents (organization_id, brand_id, publication_attempt_id, severity, code, summary, detected_by)
    VALUES (v_manifest.organization_id, v_manifest.brand_id, v_attempt_id, 'HIGH', 'POSTIZ_AMBIGUOUS_RESULT',
      COALESCE(left(p_error_detail, 1000), 'Postiz outcome needs reconciliation before any retry'), 'service:gateway');
  END IF;
  RETURN v_attempt_id;
END;
$$;

RESET ROLE;

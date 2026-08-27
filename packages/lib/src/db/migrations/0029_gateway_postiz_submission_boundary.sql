SET ROLE selena_schema_owner;

-- Gateway writes immutable reservations and attempts only through the audited
-- functions below. The generic table grants from the initial control-room
-- migration would otherwise permit a forged provider state.
REVOKE INSERT ON selena_release.dispatch_reservations FROM selena_gateway_runtime;
REVOKE INSERT ON selena_release.publication_attempts FROM selena_gateway_runtime;

CREATE POLICY dispatch_reservations_schema_owner_select ON selena_release.dispatch_reservations
  FOR SELECT TO selena_schema_owner USING (true);
CREATE POLICY dispatch_reservations_schema_owner_insert ON selena_release.dispatch_reservations
  FOR INSERT TO selena_schema_owner WITH CHECK (true);
CREATE POLICY publication_attempts_schema_owner_select ON selena_release.publication_attempts
  FOR SELECT TO selena_schema_owner USING (true);
CREATE POLICY publication_attempts_schema_owner_insert ON selena_release.publication_attempts
  FOR INSERT TO selena_schema_owner WITH CHECK (true);
CREATE POLICY release_intents_schema_owner_update ON selena_release.release_intents
  FOR UPDATE TO selena_schema_owner USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION selena_release.prepare_postiz_submission(
  p_manifest_id uuid,
  p_idempotency_key text,
  p_nonce text
) RETURNS TABLE (
  reservation_id uuid,
  release_intent_id uuid,
  manifest_hash text,
  integration_id text,
  publication_package jsonb,
  should_submit boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, selena_registry, selena_release
AS $$
DECLARE
  v_manifest selena_release.release_manifests%ROWTYPE;
  v_reservation selena_release.dispatch_reservations%ROWTYPE;
  v_intent_id uuid;
  v_expected jsonb;
  v_last_status text;
  v_integration_id text;
BEGIN
  IF NOT pg_has_role(session_user, 'selena_gateway_runtime', 'member')
    OR current_setting('app.selena_service_identity', true) IS DISTINCT FROM 'gateway'
    OR current_setting('app.selena_actor_id', true) IS DISTINCT FROM 'service:gateway'
    OR current_setting('app.selena_auth_type', true) IS DISTINCT FROM 'service'
    OR current_setting('app.selena_release_manifest_id', true) IS DISTINCT FROM p_manifest_id::text THEN
    RAISE EXCEPTION 'Only the Release Gateway may prepare a Postiz submission for its exact manifest';
  END IF;
  IF length(btrim(p_idempotency_key)) = 0 OR length(btrim(p_nonce)) = 0 THEN
    RAISE EXCEPTION 'Gateway idempotency key and nonce are required';
  END IF;

  SELECT manifest.* INTO v_manifest
  FROM selena_release.release_manifests AS manifest
  WHERE manifest.id = p_manifest_id
    AND manifest.status = 'READY'
    AND manifest.expires_at > now();
  IF NOT FOUND THEN RAISE EXCEPTION 'Release manifest is unavailable or expired'; END IF;

  BEGIN
    v_intent_id := (v_manifest.manifest ->> 'releaseIntentId')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'Release manifest has no valid release intent';
  END;
  v_expected := selena_release.build_gateway_release_package(v_intent_id);
  IF v_expected <> v_manifest.manifest THEN
    RAISE EXCEPTION 'Release package no longer matches the signed manifest';
  END IF;
  v_integration_id := v_expected -> 'destination' ->> 'integrationId';
  IF v_integration_id IS NULL OR v_integration_id <> v_manifest.manifest -> 'destination' ->> 'integrationId' THEN
    RAISE EXCEPTION 'Release manifest destination is invalid';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_manifest_id::text || ':' || p_idempotency_key));
  SELECT reservation.* INTO v_reservation
  FROM selena_release.dispatch_reservations AS reservation
  WHERE reservation.organization_id = v_manifest.organization_id
    AND reservation.brand_id = v_manifest.brand_id
    AND reservation.channel_account_id = v_manifest.channel_account_id
    AND reservation.idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_reservation.release_manifest_id <> p_manifest_id THEN
      RAISE EXCEPTION 'Gateway idempotency key belongs to a different manifest';
    END IF;
    SELECT attempt.status INTO v_last_status
    FROM selena_release.publication_attempts AS attempt
    WHERE attempt.reservation_id = v_reservation.id
    ORDER BY attempt.attempt_number DESC, attempt.transition_number DESC
    LIMIT 1;
    RETURN QUERY SELECT v_reservation.id, v_intent_id, v_manifest.manifest_hash, v_integration_id, v_manifest.manifest, false;
    RETURN;
  END IF;

  INSERT INTO selena_release.dispatch_reservations AS reservation (
    organization_id, brand_id, release_manifest_id, channel_account_id, platform,
    integration_id, allowlist_reference, idempotency_key, nonce
  ) VALUES (
    v_manifest.organization_id, v_manifest.brand_id, v_manifest.id, v_manifest.channel_account_id, v_manifest.platform,
    v_integration_id, 'postiz:exact-integration', p_idempotency_key, p_nonce
  ) RETURNING reservation.* INTO v_reservation;

  INSERT INTO selena_release.publication_attempts (
    organization_id, brand_id, reservation_id, release_manifest_id, channel_account_id, platform,
    integration_id, allowlist_reference, manifest_hash, attempt_number, transition_number, status
  ) VALUES (
    v_manifest.organization_id, v_manifest.brand_id, v_reservation.id, v_manifest.id, v_manifest.channel_account_id, v_manifest.platform,
    v_integration_id, v_reservation.allowlist_reference, v_manifest.manifest_hash, 1, 1, 'RESERVED'
  );

  RETURN QUERY SELECT v_reservation.id, v_intent_id, v_manifest.manifest_hash, v_integration_id, v_manifest.manifest, true;
END;
$$;

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
  IF p_status NOT IN ('ACCEPTED', 'DEFINITIVE_FAILURE', 'AMBIGUOUS', 'RECONCILE_REQUIRED', 'CONFIRMED', 'MANUAL_REVIEW') THEN
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
      WHEN p_status = 'DEFINITIVE_FAILURE' THEN 'DEFINITIVE_PROVIDER_FAILURE' ELSE NULL END,
    CASE WHEN p_error_detail IS NULL THEN NULL ELSE left(p_error_detail, 1000) END
  ) RETURNING attempt.id INTO v_attempt_id;

  v_intent_id := (v_manifest.manifest ->> 'releaseIntentId')::uuid;
  IF p_status IN ('ACCEPTED', 'CONFIRMED') THEN
    UPDATE selena_release.release_intents SET status = 'SUCCEEDED' WHERE id = v_intent_id;
  ELSIF p_status = 'DEFINITIVE_FAILURE' THEN
    UPDATE selena_release.release_intents SET status = 'FAILED' WHERE id = v_intent_id;
  ELSE
    UPDATE selena_release.release_intents SET status = 'UNKNOWN' WHERE id = v_intent_id;
    INSERT INTO selena_audit.incidents (organization_id, brand_id, publication_attempt_id, severity, code, summary, detected_by)
    VALUES (v_manifest.organization_id, v_manifest.brand_id, v_attempt_id, 'HIGH', 'POSTIZ_AMBIGUOUS_RESULT',
      COALESCE(left(p_error_detail, 1000), 'Postiz outcome needs reconciliation before any retry'), 'service:gateway');
  END IF;
  RETURN v_attempt_id;
END;
$$;

REVOKE ALL ON FUNCTION selena_release.prepare_postiz_submission(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION selena_release.record_postiz_submission_outcome(uuid, selena_release.publication_attempt_status, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION selena_release.prepare_postiz_submission(uuid, text, text) TO selena_gateway_runtime;
GRANT EXECUTE ON FUNCTION selena_release.record_postiz_submission_outcome(uuid, selena_release.publication_attempt_status, text, text) TO selena_gateway_runtime;

DO $$
BEGIN
  IF has_table_privilege('selena_gateway_runtime', 'selena_release.dispatch_reservations', 'INSERT')
    OR has_table_privilege('selena_gateway_runtime', 'selena_release.publication_attempts', 'INSERT')
    OR has_table_privilege('selena_gateway_runtime', 'selena_release.release_intents', 'UPDATE') THEN
    RAISE EXCEPTION 'Release Gateway must use the Postiz submission boundary';
  END IF;
END $$;

RESET ROLE;

SET ROLE selena_schema_owner;

-- On the site an accepted attempt is a branch or an open pull request; the
-- article is public only once the owner merges it. The gateway watches those
-- attempts and records how each one ended. record_postiz_submission_outcome
-- refuses anything after ACCEPTED, because for a social post ACCEPTED already
-- is the end, so the site gets its own pair of functions.

-- The site attempts still waiting on the owner: the latest attempt of each
-- reservation, when it is ACCEPTED. The manifest travels with it so the gateway
-- can tell which edition file the attempt wrote.
CREATE FUNCTION selena_release.list_pending_site_publications(p_limit integer)
RETURNS TABLE (
  reservation_id uuid,
  release_manifest_id uuid,
  manifest_hash text,
  manifest jsonb,
  provider_reference_id text,
  accepted_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, selena_release
AS $$
BEGIN
  IF NOT pg_has_role(session_user, 'selena_gateway_runtime', 'member')
    OR current_setting('app.selena_service_identity', true) IS DISTINCT FROM 'gateway'
    OR current_setting('app.selena_actor_id', true) IS DISTINCT FROM 'service:gateway'
    OR current_setting('app.selena_auth_type', true) IS DISTINCT FROM 'service' THEN
    RAISE EXCEPTION 'Only the Release Gateway may watch site publications';
  END IF;
  RETURN QUERY
  SELECT latest.reservation_id, latest.release_manifest_id, latest.manifest_hash, m.manifest,
    latest.provider_reference_id, latest.created_at
  FROM (
    SELECT DISTINCT ON (attempt.reservation_id) attempt.*
    FROM selena_release.publication_attempts AS attempt
    WHERE attempt.platform = 'website_lab'
    ORDER BY attempt.reservation_id, attempt.attempt_number DESC, attempt.transition_number DESC
  ) AS latest
  JOIN selena_release.release_manifests AS m ON m.id = latest.release_manifest_id
  WHERE latest.status = 'ACCEPTED'
  ORDER BY latest.created_at
  LIMIT greatest(1, least(COALESCE(p_limit, 50), 200));
END;
$$;

-- How an accepted site attempt ended:
--   PUBLISHED  — the edition this attempt wrote is on the base branch; the
--                reference is the public page.
--   CLOSED     — the owner closed the pull request without merging it.
--   SUPERSEDED — the pull request was merged with a later approved version of
--                the same edition; that version reports its own publication.
CREATE FUNCTION selena_release.record_site_publication_outcome(
  p_reservation_id uuid,
  p_result text,
  p_reference text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, selena_release
AS $$
DECLARE
  v_latest selena_release.publication_attempts%ROWTYPE;
  v_manifest selena_release.release_manifests%ROWTYPE;
  v_attempt_id uuid;
BEGIN
  IF NOT pg_has_role(session_user, 'selena_gateway_runtime', 'member')
    OR current_setting('app.selena_service_identity', true) IS DISTINCT FROM 'gateway'
    OR current_setting('app.selena_actor_id', true) IS DISTINCT FROM 'service:gateway'
    OR current_setting('app.selena_auth_type', true) IS DISTINCT FROM 'service' THEN
    RAISE EXCEPTION 'Only the Release Gateway may record a site publication';
  END IF;
  IF p_result IS NULL OR p_result NOT IN ('PUBLISHED', 'CLOSED', 'SUPERSEDED') THEN
    RAISE EXCEPTION 'Site publication result is invalid';
  END IF;
  IF p_result = 'PUBLISHED' AND (p_reference IS NULL OR p_reference !~ '^https://') THEN
    RAISE EXCEPTION 'A published article needs the address of its page';
  END IF;

  SELECT attempt.* INTO v_latest
  FROM selena_release.publication_attempts AS attempt
  WHERE attempt.reservation_id = p_reservation_id
  ORDER BY attempt.attempt_number DESC, attempt.transition_number DESC
  LIMIT 1;
  IF NOT FOUND OR current_setting('app.selena_release_manifest_id', true) IS DISTINCT FROM v_latest.release_manifest_id::text THEN
    RAISE EXCEPTION 'Gateway may only record an outcome for its exact manifest';
  END IF;
  IF v_latest.platform <> 'website_lab' OR v_latest.status <> 'ACCEPTED' THEN
    RAISE EXCEPTION 'Only an accepted site release is waiting on the owner';
  END IF;
  SELECT m.* INTO v_manifest FROM selena_release.release_manifests AS m WHERE m.id = v_latest.release_manifest_id;

  INSERT INTO selena_release.publication_attempts AS attempt (
    organization_id, brand_id, reservation_id, release_manifest_id, channel_account_id, platform,
    integration_id, allowlist_reference, manifest_hash, attempt_number, transition_number, status,
    provider_request_id, provider_reference_id, error_classification, error_detail
  ) VALUES (
    v_latest.organization_id, v_latest.brand_id, v_latest.reservation_id, v_latest.release_manifest_id,
    v_latest.channel_account_id, v_latest.platform, v_latest.integration_id, v_latest.allowlist_reference,
    v_latest.manifest_hash, v_latest.attempt_number, v_latest.transition_number + 1,
    CASE WHEN p_result = 'PUBLISHED' THEN 'CONFIRMED' ELSE 'DEFINITIVE_FAILURE' END::selena_release.publication_attempt_status,
    NULL,
    CASE WHEN p_result = 'PUBLISHED' THEN p_reference ELSE v_latest.provider_reference_id END,
    CASE p_result WHEN 'CLOSED' THEN 'SITE_CHANGE_CLOSED' WHEN 'SUPERSEDED' THEN 'SITE_CHANGE_SUPERSEDED' END,
    CASE p_result
      WHEN 'CLOSED' THEN 'The owner closed the pull request without merging it'
      WHEN 'SUPERSEDED' THEN 'A later approved version of this edition was merged instead'
    END
  ) RETURNING attempt.id INTO v_attempt_id;

  -- Not merged is the owner's choice, not a provider failure: the intent is
  -- cancelled, and no incident is raised.
  IF p_result <> 'PUBLISHED' THEN
    UPDATE selena_release.release_intents SET status = 'CANCELLED'
    WHERE id = (v_manifest.manifest ->> 'releaseIntentId')::uuid;
  END IF;
  RETURN v_attempt_id;
END;
$$;

REVOKE ALL ON FUNCTION selena_release.list_pending_site_publications(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION selena_release.record_site_publication_outcome(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION selena_release.list_pending_site_publications(integer) TO selena_gateway_runtime;
GRANT EXECUTE ON FUNCTION selena_release.record_site_publication_outcome(uuid, text, text) TO selena_gateway_runtime;

-- The author learns the end of a site release: the page once it is merged,
-- REJECTED when the owner closes the pull request. A superseded version stays
-- silent, because the version that replaced it returns its own outcome to the
-- same task and must not be overwritten by the older one.
CREATE OR REPLACE FUNCTION selena_registry.tg_aether_outcome_from_attempt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, selena_registry
AS $$
DECLARE
  v_outcome text;
  v_content_version_id uuid;
BEGIN
  IF NEW.platform = 'website_lab' AND NEW.status = 'ACCEPTED' THEN
    RETURN NEW;
  END IF;
  IF NEW.platform = 'website_lab' AND NEW.error_classification = 'SITE_CHANGE_SUPERSEDED' THEN
    RETURN NEW;
  END IF;
  IF NEW.status IN ('ACCEPTED', 'CONFIRMED') THEN
    v_outcome := 'PUBLISHED';
  ELSIF NEW.status = 'NOT_SENT' THEN
    v_outcome := 'REFUSED';
  ELSIF NEW.platform = 'website_lab' AND NEW.error_classification = 'SITE_CHANGE_CLOSED' THEN
    v_outcome := 'REJECTED';
  ELSIF NEW.status = 'DEFINITIVE_FAILURE' THEN
    v_outcome := 'FAILED';
  ELSE
    RETURN NEW;
  END IF;

  SELECT content_version_id INTO v_content_version_id
  FROM selena_release.release_manifests WHERE id = NEW.release_manifest_id;
  IF v_content_version_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM selena_registry.enqueue_aether_outcome(
    v_content_version_id,
    v_outcome,
    CASE WHEN v_outcome = 'PUBLISHED' THEN NEW.provider_reference_id END,
    CASE WHEN v_outcome = 'FAILED' THEN NEW.error_classification END
  );
  RETURN NEW;
END;
$$;

RESET ROLE;

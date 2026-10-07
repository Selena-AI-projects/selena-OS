SET ROLE selena_schema_owner;

-- Selena Lab, the articles section of selenasystems.com, becomes a release
-- channel. A release there does not publish by itself: the gateway opens a
-- pull request in the site repository, and the article is public only once the
-- owner merges it, because the site deploys from its main branch.
ALTER TABLE selena_registry.channel_provider_bindings
  DROP CONSTRAINT channel_provider_bindings_provider_known;
ALTER TABLE selena_registry.channel_provider_bindings
  ADD CONSTRAINT channel_provider_bindings_provider_known
  CHECK (provider IN ('postiz', 'blotato', 'selena_lab'));

COMMENT ON CONSTRAINT channel_provider_bindings_provider_known
  ON selena_registry.channel_provider_bindings IS
  'Known release providers. Extend here, not by writing a new name into a row.';

-- Binding the site is the same owner act as binding a social channel, with
-- nothing to type: the platform and provider are fixed, and the destination is
-- the site repository the web service is configured with. Repeating it
-- re-points the channel instead of failing, exactly like
-- confirm_channel_provider_binding.
CREATE FUNCTION selena_registry.confirm_site_channel_binding(
  p_brand_id text,
  p_repository text,
  p_environment selena_registry.release_environment
) RETURNS TABLE (account_id uuid, binding_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, selena_registry
AS $$
DECLARE
  v_organization_id text := current_setting('app.selena_organization_id', true);
  v_actor_id text := current_setting('app.selena_actor_id', true);
  v_account_id uuid;
  v_binding_id uuid;
BEGIN
  IF NOT pg_has_role(session_user, 'selena_web_runtime', 'member')
    OR v_organization_id IS NULL OR v_actor_id IS NULL
    OR current_setting('app.selena_brand_id', true) IS DISTINCT FROM p_brand_id
    OR NOT selena_registry.can_human_approve(v_organization_id, p_brand_id) THEN
    RAISE EXCEPTION 'Only an interactive owner session for this brand may bind a publishing channel';
  END IF;
  IF p_repository IS NULL OR p_repository !~ '^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$' THEN
    RAISE EXCEPTION 'The site repository must be named owner/name';
  END IF;

  INSERT INTO selena_registry.channel_accounts AS account (
    organization_id, brand_id, platform, provider_account_ref, provider_integration_id,
    status, allowlisted, created_by
  ) VALUES (
    v_organization_id, p_brand_id, 'website_lab', 'Selena Lab', p_repository,
    'ACTIVE', true, v_actor_id
  ) ON CONFLICT (brand_id, platform, provider_account_ref) DO UPDATE
    SET provider_integration_id = EXCLUDED.provider_integration_id,
        status = 'ACTIVE',
        allowlisted = true,
        updated_at = now()
  RETURNING account.id INTO v_account_id;

  UPDATE selena_registry.channel_provider_bindings AS binding
  SET active = false, updated_at = now()
  WHERE binding.channel_account_id = v_account_id
    AND binding.environment = p_environment
    AND binding.active
    AND binding.provider IS DISTINCT FROM 'selena_lab';

  INSERT INTO selena_registry.channel_provider_bindings AS binding (
    organization_id, brand_id, channel_account_id, provider, environment, active, created_by
  ) VALUES (
    v_organization_id, p_brand_id, v_account_id, 'selena_lab', p_environment, true, v_actor_id
  ) ON CONFLICT (channel_account_id, environment, provider) DO UPDATE
    SET active = true, updated_at = now()
  RETURNING binding.id INTO v_binding_id;

  PERFORM selena_registry.append_channel_audit(
    v_organization_id, p_brand_id, v_actor_id, 'release.channel_bound', v_binding_id::text,
    jsonb_build_object(
      'channelAccountId', v_account_id, 'environment', p_environment::text,
      'platform', 'website_lab', 'provider', 'selena_lab', 'repository', p_repository
    )
  );
  account_id := v_account_id;
  binding_id := v_binding_id;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION selena_registry.confirm_site_channel_binding(
  text, text, selena_registry.release_environment
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION selena_registry.confirm_site_channel_binding(
  text, text, selena_registry.release_environment
) TO selena_web_runtime;

-- On the site an accepted attempt is an open pull request, not a public page,
-- so it must not reach the author as PUBLISHED. A refusal or a failure still
-- returns: nothing was opened for the owner to merge.
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
  IF NEW.status IN ('ACCEPTED', 'CONFIRMED') THEN
    v_outcome := 'PUBLISHED';
  ELSIF NEW.status = 'NOT_SENT' THEN
    v_outcome := 'REFUSED';
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

DO $$
BEGIN
  IF has_table_privilege('selena_web_runtime', 'selena_registry.channel_provider_bindings', 'INSERT')
    OR has_table_privilege('selena_gateway_runtime', 'selena_registry.channel_provider_bindings', 'INSERT')
    OR has_table_privilege('selena_web_runtime', 'selena_registry.channel_accounts', 'INSERT') THEN
    RAISE EXCEPTION 'A runtime must reach a channel binding only through the owner functions';
  END IF;
END $$;

RESET ROLE;

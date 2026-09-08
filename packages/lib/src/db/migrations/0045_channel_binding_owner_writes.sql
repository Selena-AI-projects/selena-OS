SET ROLE selena_schema_owner;

-- Until now a publishing channel could not be created by anyone. Writing a
-- provider binding was reserved to the restore identity, which has no login and
-- no membership granted anywhere, and the schema owner could insert only the
-- hard-coded staging dry-run account. So the one row that decides where a
-- release may land had no legitimate author on a deployed contour.
--
-- It stays out of reach of the runtimes. What changes is that an owner, in an
-- interactive session for the brand, can create it through a function that
-- writes both rows together — an account nobody may publish to and a binding
-- pointing at nothing are equally useless apart.
CREATE POLICY channel_accounts_schema_owner_channel_insert ON selena_registry.channel_accounts
  FOR INSERT TO selena_schema_owner WITH CHECK (true);
CREATE POLICY channel_accounts_schema_owner_channel_update ON selena_registry.channel_accounts
  FOR UPDATE TO selena_schema_owner USING (true) WITH CHECK (true);
CREATE POLICY channel_provider_bindings_schema_owner_insert ON selena_registry.channel_provider_bindings
  FOR INSERT TO selena_schema_owner WITH CHECK (true);
CREATE POLICY channel_provider_bindings_schema_owner_update ON selena_registry.channel_provider_bindings
  FOR UPDATE TO selena_schema_owner USING (true) WITH CHECK (true);

CREATE FUNCTION selena_registry.append_channel_audit(
  p_organization_id text,
  p_brand_id text,
  p_actor_id text,
  p_action text,
  p_aggregate_id text,
  p_metadata jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, selena_audit
AS $$
DECLARE
  v_previous_hash text;
  v_event_hash text;
  v_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_organization_id || ':' || p_brand_id));
  SELECT event.event_hash INTO v_previous_hash
  FROM selena_audit.audit_events AS event
  WHERE event.organization_id = p_organization_id AND event.brand_id = p_brand_id
  ORDER BY event.created_at DESC, event.id DESC
  LIMIT 1;
  v_event_hash := encode(pg_catalog.sha256(convert_to(
    COALESCE(v_previous_hash, '') || '|' || p_action || '|' || p_aggregate_id || '|' || p_metadata::text, 'utf8'
  )), 'hex');
  INSERT INTO selena_audit.audit_events (
    organization_id, brand_id, actor_id, action, aggregate_type, aggregate_id, previous_hash, event_hash, metadata
  ) VALUES (
    p_organization_id, p_brand_id, p_actor_id, p_action, 'channel_provider_binding', p_aggregate_id,
    v_previous_hash, v_event_hash, p_metadata
  ) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION selena_registry.append_channel_audit(text, text, text, text, text, jsonb) FROM PUBLIC;

-- Binding a channel is an owner's interactive act in the brand's own request
-- context, like confirming a growth source. Repeating it with the same account
-- re-points the binding rather than failing: the partial unique index allows
-- one active binding per channel and environment, so the previous one is
-- stood down in the same transaction instead of colliding with the new one.
CREATE FUNCTION selena_registry.confirm_channel_provider_binding(
  p_brand_id text,
  p_account_ref text,
  p_provider_account_id text,
  p_provider text,
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
  IF length(btrim(p_account_ref)) = 0 OR length(btrim(p_provider_account_id)) = 0 THEN
    RAISE EXCEPTION 'A channel needs an account name and the provider account it stands for';
  END IF;

  INSERT INTO selena_registry.channel_accounts AS account (
    organization_id, brand_id, platform, provider_account_ref, provider_integration_id,
    status, allowlisted, created_by
  ) VALUES (
    v_organization_id, p_brand_id, 'linkedin_page', btrim(p_account_ref), btrim(p_provider_account_id),
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
    AND binding.provider IS DISTINCT FROM p_provider;

  INSERT INTO selena_registry.channel_provider_bindings AS binding (
    organization_id, brand_id, channel_account_id, provider, environment, active, created_by
  ) VALUES (
    v_organization_id, p_brand_id, v_account_id, p_provider, p_environment, true, v_actor_id
  ) ON CONFLICT (channel_account_id, environment, provider) DO UPDATE
    SET active = true, updated_at = now()
  RETURNING binding.id INTO v_binding_id;

  PERFORM selena_registry.append_channel_audit(
    v_organization_id, p_brand_id, v_actor_id, 'release.channel_bound', v_binding_id::text,
    jsonb_build_object(
      'channelAccountId', v_account_id, 'environment', p_environment::text,
      'platform', 'linkedin_page', 'provider', p_provider
    )
  );
  account_id := v_account_id;
  binding_id := v_binding_id;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION selena_registry.confirm_channel_provider_binding(
  text, text, text, text, selena_registry.release_environment
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION selena_registry.confirm_channel_provider_binding(
  text, text, text, text, selena_registry.release_environment
) TO selena_web_runtime;

DO $$
BEGIN
  IF has_table_privilege('selena_web_runtime', 'selena_registry.channel_provider_bindings', 'INSERT')
    OR has_table_privilege('selena_gateway_runtime', 'selena_registry.channel_provider_bindings', 'INSERT')
    OR has_table_privilege('selena_web_runtime', 'selena_registry.channel_accounts', 'INSERT') THEN
    RAISE EXCEPTION 'A runtime must reach a channel binding only through the owner function';
  END IF;
END $$;

RESET ROLE;

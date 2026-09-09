SET ROLE selena_schema_owner;

-- Binding a channel got a way to happen and never got a way to un-happen. An
-- owner who names the wrong environment — a real, observed case: staging bound
-- to PRODUCTION — had no function to call and no policy that would let them
-- write the row directly. Revocation is written the same way the bind is: an
-- owner's interactive act in the brand's own request context, through a
-- function that flips the flag and appends the audit entry in the same
-- transaction, never a direct write.
CREATE FUNCTION selena_registry.revoke_channel_provider_binding(
  p_brand_id text,
  p_binding_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, selena_registry
AS $$
DECLARE
  v_organization_id text := current_setting('app.selena_organization_id', true);
  v_actor_id text := current_setting('app.selena_actor_id', true);
  v_binding selena_registry.channel_provider_bindings;
BEGIN
  IF NOT pg_has_role(session_user, 'selena_web_runtime', 'member')
    OR v_organization_id IS NULL OR v_actor_id IS NULL
    OR current_setting('app.selena_brand_id', true) IS DISTINCT FROM p_brand_id
    OR NOT selena_registry.can_human_approve(v_organization_id, p_brand_id) THEN
    RAISE EXCEPTION 'Only an interactive owner session for this brand may revoke a publishing channel binding';
  END IF;

  SELECT * INTO v_binding
  FROM selena_registry.channel_provider_bindings
  WHERE id = p_binding_id AND brand_id = p_brand_id AND organization_id = v_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No such binding for this brand';
  END IF;
  IF NOT v_binding.active THEN
    -- Already stood down — revoking twice is not an error, it just has
    -- nothing left to do and nothing new to audit.
    RETURN;
  END IF;

  UPDATE selena_registry.channel_provider_bindings
  SET active = false, updated_at = now()
  WHERE id = p_binding_id;

  PERFORM selena_registry.append_channel_audit(
    v_organization_id, p_brand_id, v_actor_id, 'release.channel_unbound', p_binding_id::text,
    jsonb_build_object(
      'channelAccountId', v_binding.channel_account_id, 'environment', v_binding.environment::text,
      'provider', v_binding.provider
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION selena_registry.revoke_channel_provider_binding(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION selena_registry.revoke_channel_provider_binding(text, uuid) TO selena_web_runtime;

DO $$
BEGIN
  IF has_table_privilege('selena_web_runtime', 'selena_registry.channel_provider_bindings', 'UPDATE')
    OR has_table_privilege('selena_gateway_runtime', 'selena_registry.channel_provider_bindings', 'UPDATE') THEN
    RAISE EXCEPTION 'A runtime must reach a channel binding only through the owner functions';
  END IF;
END $$;

RESET ROLE;

SET ROLE selena_schema_owner;

-- The active-unique index guards only live rows, and confirm never looked at the
-- revoked history. So once an owner revoked a binding, a different organization
-- could confirm the same (Aether project, environment) for itself, and the next
-- draft that arrived for that project projected into the newcomer's brand. An
-- Aether project in a given environment belongs to the organization that first
-- bound it: pin it there. The same organization may still revoke and rebind it
-- (its own revoked rows are excluded), and a different organization may still
-- bind the same project in a different environment (that pair has no history),
-- so this only closes the cross-tenant reclaim after a revoke.
CREATE OR REPLACE FUNCTION selena_registry.confirm_growth_binding(
  p_brand_id text,
  p_aether_project_id uuid,
  p_aether_business_key text,
  p_source_environment text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, selena_registry
AS $$
DECLARE
  v_organization_id text := current_setting('app.selena_organization_id', true);
  v_actor_id text := current_setting('app.selena_actor_id', true);
  v_id uuid;
BEGIN
  IF NOT pg_has_role(session_user, 'selena_web_runtime', 'member')
    OR v_organization_id IS NULL OR v_actor_id IS NULL
    OR current_setting('app.selena_brand_id', true) IS DISTINCT FROM p_brand_id
    OR NOT selena_registry.can_human_approve(v_organization_id, p_brand_id) THEN
    RAISE EXCEPTION 'Only an interactive owner session for this brand may confirm a growth binding';
  END IF;
  IF EXISTS (
    SELECT 1 FROM selena_registry.growth_project_bindings
    WHERE aether_project_id = p_aether_project_id
      AND source_environment = p_source_environment
      AND organization_id <> v_organization_id
      AND revoked_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Another tenant has held this Aether project in this environment';
  END IF;
  INSERT INTO selena_registry.growth_project_bindings (
    organization_id, brand_id, aether_project_id, aether_business_key, source_environment, confirmed_by
  ) VALUES (
    v_organization_id, p_brand_id, p_aether_project_id, p_aether_business_key, p_source_environment, v_actor_id
  ) RETURNING id INTO v_id;
  PERFORM selena_registry.append_growth_audit(
    v_organization_id, p_brand_id, v_actor_id, 'growth.binding_confirmed', v_id::text,
    jsonb_build_object(
      'aetherProjectId', p_aether_project_id, 'businessKey', p_aether_business_key,
      'sourceEnvironment', p_source_environment
    )
  );
  RETURN v_id;
END;
$$;

RESET ROLE;

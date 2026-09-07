SET ROLE selena_schema_owner;

-- Which Aether project may deliver materials into which brand. The row is the
-- owner's decision, recorded once and revoked rather than edited: the worker
-- that projects an event looks the binding up by the Aether project id and the
-- environment the event came from, never by the business alias, which is a
-- six-value label shared across organizations.
CREATE TABLE selena_registry.growth_project_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id text NOT NULL REFERENCES public.organization(id),
  brand_id text NOT NULL REFERENCES public.brands(id),
  aether_project_id uuid NOT NULL,
  aether_business_key text NOT NULL,
  source_environment text NOT NULL,
  confirmed_by text NOT NULL,
  confirmed_at timestamptz DEFAULT now() NOT NULL,
  revoked_at timestamptz,
  revoked_by text,
  revoke_reason text,
  CONSTRAINT growth_project_bindings_business_key_shape CHECK (aether_business_key ~ '^[a-z_]{2,32}$'),
  CONSTRAINT growth_project_bindings_environment_known
    CHECK (source_environment IN ('local', 'staging', 'production')),
  CONSTRAINT growth_project_bindings_revocation_complete
    CHECK ((revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoke_reason IS NULL))
);

-- One Aether project reaches exactly one brand per environment, across the
-- whole database: two organizations cannot both claim the same project.
CREATE UNIQUE INDEX growth_project_bindings_active_unique
  ON selena_registry.growth_project_bindings (aether_project_id, source_environment)
  WHERE revoked_at IS NULL;
CREATE INDEX growth_project_bindings_brand_idx ON selena_registry.growth_project_bindings (brand_id);
CREATE INDEX growth_project_bindings_org_idx ON selena_registry.growth_project_bindings (organization_id);

-- A brand belongs to one organization; the row must agree with public.brands.
CREATE FUNCTION selena_registry.growth_binding_brand_in_organization()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, selena_registry
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.brands b WHERE b.id = NEW.brand_id AND b.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'Growth binding brand does not belong to the organization';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- The only permitted change is a single revocation; identity never moves.
    IF NEW.organization_id <> OLD.organization_id OR NEW.brand_id <> OLD.brand_id
      OR NEW.aether_project_id <> OLD.aether_project_id OR NEW.aether_business_key <> OLD.aether_business_key
      OR NEW.source_environment <> OLD.source_environment OR NEW.confirmed_by <> OLD.confirmed_by
      OR NEW.confirmed_at <> OLD.confirmed_at OR OLD.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'Growth bindings are revoked, never edited';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION selena_registry.growth_binding_brand_in_organization() FROM PUBLIC;
CREATE TRIGGER growth_project_bindings_identity
  BEFORE INSERT OR UPDATE ON selena_registry.growth_project_bindings
  FOR EACH ROW EXECUTE FUNCTION selena_registry.growth_binding_brand_in_organization();
CREATE TRIGGER growth_project_bindings_no_delete
  BEFORE DELETE ON selena_registry.growth_project_bindings
  FOR EACH ROW EXECUTE FUNCTION selena_audit.reject_immutable_mutation();

ALTER TABLE selena_registry.growth_project_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE selena_registry.growth_project_bindings FORCE ROW LEVEL SECURITY;

CREATE POLICY growth_project_bindings_web_select ON selena_registry.growth_project_bindings
  FOR SELECT TO selena_web_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['web']));
CREATE POLICY growth_project_bindings_schema_owner_select ON selena_registry.growth_project_bindings
  FOR SELECT TO selena_schema_owner USING (true);
CREATE POLICY growth_project_bindings_schema_owner_insert ON selena_registry.growth_project_bindings
  FOR INSERT TO selena_schema_owner WITH CHECK (true);
CREATE POLICY growth_project_bindings_schema_owner_update ON selena_registry.growth_project_bindings
  FOR UPDATE TO selena_schema_owner USING (true) WITH CHECK (true);

GRANT SELECT ON selena_registry.growth_project_bindings TO selena_web_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON selena_registry.growth_project_bindings TO selena_backup_restore;

-- Audit rows are appended by the functions below in the same chained form the
-- dispatch authorization uses, so a binding never appears without its trail.
CREATE FUNCTION selena_registry.append_growth_audit(
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
    p_organization_id, p_brand_id, p_actor_id, p_action, 'growth_project_binding', p_aggregate_id,
    v_previous_hash, v_event_hash, p_metadata
  ) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION selena_registry.append_growth_audit(text, text, text, text, text, jsonb) FROM PUBLIC;

-- Confirmation is an owner's interactive act in the brand's own request context.
CREATE FUNCTION selena_registry.confirm_growth_binding(
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

CREATE FUNCTION selena_registry.revoke_growth_binding(
  p_binding_id uuid,
  p_reason text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, selena_registry
AS $$
DECLARE
  v_organization_id text := current_setting('app.selena_organization_id', true);
  v_brand_id text := current_setting('app.selena_brand_id', true);
  v_actor_id text := current_setting('app.selena_actor_id', true);
BEGIN
  IF NOT pg_has_role(session_user, 'selena_web_runtime', 'member')
    OR v_organization_id IS NULL OR v_brand_id IS NULL OR v_actor_id IS NULL
    OR NOT selena_registry.can_human_approve(v_organization_id, v_brand_id) THEN
    RAISE EXCEPTION 'Only an interactive owner session for this brand may revoke a growth binding';
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) = 0 THEN
    RAISE EXCEPTION 'A revocation needs a reason';
  END IF;
  UPDATE selena_registry.growth_project_bindings
  SET revoked_at = now(), revoked_by = v_actor_id, revoke_reason = p_reason
  WHERE id = p_binding_id AND organization_id = v_organization_id AND brand_id = v_brand_id
    AND revoked_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Growth binding is not active in this brand';
  END IF;
  PERFORM selena_registry.append_growth_audit(
    v_organization_id, v_brand_id, v_actor_id, 'growth.binding_revoked', p_binding_id::text,
    jsonb_build_object('reason', p_reason)
  );
END;
$$;

-- The projection worker does not know the brand until it has looked the
-- binding up, so the lookup is a function bound to the worker identity rather
-- than a table read: it returns the active row for the exact project and
-- environment, or nothing, and the caller then establishes the brand context.
CREATE FUNCTION selena_registry.resolve_growth_binding(
  p_aether_project_id uuid,
  p_source_environment text
) RETURNS TABLE (binding_id uuid, organization_id text, brand_id text, aether_business_key text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, selena_registry
AS $$
BEGIN
  IF NOT pg_has_role(session_user, 'selena_registry_worker_runtime', 'member')
    OR current_setting('app.selena_service_identity', true) IS DISTINCT FROM 'registry_worker'
    OR current_setting('app.selena_actor_id', true) IS DISTINCT FROM 'service:registry-worker'
    OR current_setting('app.selena_auth_type', true) IS DISTINCT FROM 'service' THEN
    RAISE EXCEPTION 'Only the registry worker may resolve a growth binding';
  END IF;
  RETURN QUERY
    SELECT b.id, b.organization_id, b.brand_id, b.aether_business_key
    FROM selena_registry.growth_project_bindings AS b
    WHERE b.aether_project_id = p_aether_project_id
      AND b.source_environment = p_source_environment
      AND b.revoked_at IS NULL;
END;
$$;

REVOKE ALL ON FUNCTION selena_registry.confirm_growth_binding(text, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION selena_registry.revoke_growth_binding(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION selena_registry.resolve_growth_binding(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION selena_registry.confirm_growth_binding(text, uuid, text, text) TO selena_web_runtime;
GRANT EXECUTE ON FUNCTION selena_registry.revoke_growth_binding(uuid, text) TO selena_web_runtime;
GRANT EXECUTE ON FUNCTION selena_registry.resolve_growth_binding(uuid, text) TO selena_registry_worker_runtime;

DO $$
BEGIN
  IF has_table_privilege('selena_web_runtime', 'selena_registry.growth_project_bindings', 'INSERT')
    OR has_table_privilege('selena_web_runtime', 'selena_registry.growth_project_bindings', 'UPDATE')
    OR has_table_privilege('selena_web_runtime', 'selena_registry.growth_project_bindings', 'DELETE') THEN
    RAISE EXCEPTION 'Growth bindings are confirmed and revoked through functions, never written directly';
  END IF;
  IF has_table_privilege('selena_registry_worker_runtime', 'selena_registry.growth_project_bindings', 'SELECT')
    OR has_table_privilege('selena_ingestion_runtime', 'selena_registry.growth_project_bindings', 'SELECT') THEN
    RAISE EXCEPTION 'Runtimes resolve growth bindings through the worker function only';
  END IF;
  IF has_function_privilege('selena_ingestion_runtime', 'selena_registry.resolve_growth_binding(uuid, text)', 'EXECUTE')
    OR has_function_privilege('selena_web_runtime', 'selena_registry.resolve_growth_binding(uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Only the registry worker resolves growth bindings';
  END IF;
END $$;

RESET ROLE;

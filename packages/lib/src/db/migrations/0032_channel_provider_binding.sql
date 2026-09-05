SET ROLE selena_schema_owner;

CREATE TYPE selena_registry.release_environment AS ENUM ('PRODUCTION', 'STAGING', 'DRY_RUN');

-- A binding row must belong to the same brand as the account it points at, so
-- the composite reference below needs this identity key.
CREATE UNIQUE INDEX IF NOT EXISTS channel_accounts_identity_unique
  ON selena_registry.channel_accounts (id, organization_id, brand_id);

CREATE TABLE selena_registry.channel_provider_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id text NOT NULL REFERENCES public.organization(id),
  brand_id text NOT NULL REFERENCES public.brands(id),
  channel_account_id uuid NOT NULL,
  provider text NOT NULL,
  environment selena_registry.release_environment NOT NULL,
  active boolean DEFAULT false NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT channel_provider_bindings_provider_nonempty CHECK (length(btrim(provider)) > 0),
  CONSTRAINT channel_provider_bindings_account_fk
    FOREIGN KEY (channel_account_id, organization_id, brand_id)
    REFERENCES selena_registry.channel_accounts (id, organization_id, brand_id)
);

-- The invariant a second provider must not be able to violate: one channel is
-- reached through exactly one provider in a given environment. An inactive row
-- may be staged next to the active one so a switch is a single flag change.
CREATE UNIQUE INDEX channel_provider_bindings_active_unique
  ON selena_registry.channel_provider_bindings (channel_account_id, environment)
  WHERE active;
CREATE UNIQUE INDEX channel_provider_bindings_provider_unique
  ON selena_registry.channel_provider_bindings (channel_account_id, environment, provider);
CREATE INDEX channel_provider_bindings_brand_idx
  ON selena_registry.channel_provider_bindings (brand_id, environment);
CREATE INDEX channel_provider_bindings_org_idx
  ON selena_registry.channel_provider_bindings (organization_id);

ALTER TABLE selena_registry.channel_provider_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE selena_registry.channel_provider_bindings FORCE ROW LEVEL SECURITY;

-- Runtimes read a binding; changing which provider owns a channel stays an
-- operator action through the migration/restore identity.
CREATE POLICY channel_provider_bindings_web_select ON selena_registry.channel_provider_bindings
  FOR SELECT TO selena_web_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['web']));
CREATE POLICY channel_provider_bindings_gateway_select ON selena_registry.channel_provider_bindings
  FOR SELECT TO selena_gateway_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['gateway']));
CREATE POLICY channel_provider_bindings_schema_owner_select ON selena_registry.channel_provider_bindings
  FOR SELECT TO selena_schema_owner USING (true);

GRANT SELECT ON selena_registry.channel_provider_bindings TO selena_web_runtime, selena_gateway_runtime;
-- The initial control-room grant covered only the tables that existed then.
GRANT SELECT, INSERT, UPDATE, DELETE ON selena_registry.channel_provider_bindings TO selena_backup_restore;

-- The dispatch authorization below appends the audit entry itself, so the
-- Gateway loses the direct insert that would let it dispatch unrecorded.
CREATE POLICY audit_events_schema_owner_select ON selena_audit.audit_events
  FOR SELECT TO selena_schema_owner USING (true);
CREATE POLICY audit_events_schema_owner_insert ON selena_audit.audit_events
  FOR INSERT TO selena_schema_owner WITH CHECK (true);
REVOKE INSERT ON selena_audit.audit_events FROM selena_gateway_runtime;

CREATE OR REPLACE FUNCTION selena_release.authorize_provider_dispatch(
  p_manifest_id uuid,
  p_environment selena_registry.release_environment,
  p_idempotency_key text
) RETURNS TABLE (
  audit_event_id uuid,
  content_hash text,
  expires_at timestamptz,
  manifest_hash text,
  provider text,
  signature text,
  signature_algorithm text,
  signing_key_version text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, selena_audit, selena_registry, selena_release
AS $$
DECLARE
  v_manifest selena_release.release_manifests%ROWTYPE;
  v_version selena_registry.content_versions%ROWTYPE;
  v_provider text;
  v_previous_hash text;
  v_event_hash text;
  v_metadata jsonb;
  v_audit_event_id uuid;
BEGIN
  IF NOT pg_has_role(session_user, 'selena_gateway_runtime', 'member')
    OR current_setting('app.selena_service_identity', true) IS DISTINCT FROM 'gateway'
    OR current_setting('app.selena_actor_id', true) IS DISTINCT FROM 'service:gateway'
    OR current_setting('app.selena_auth_type', true) IS DISTINCT FROM 'service'
    OR current_setting('app.selena_release_manifest_id', true) IS DISTINCT FROM p_manifest_id::text THEN
    RAISE EXCEPTION 'Only the Release Gateway may authorize a dispatch for its exact manifest';
  END IF;
  IF length(btrim(p_idempotency_key)) = 0 THEN
    RAISE EXCEPTION 'Dispatch idempotency key is required';
  END IF;

  SELECT manifest.* INTO v_manifest
  FROM selena_release.release_manifests AS manifest
  WHERE manifest.id = p_manifest_id
    AND manifest.status = 'READY'
    AND manifest.expires_at > now();
  IF NOT FOUND THEN RAISE EXCEPTION 'Release manifest is unavailable or expired'; END IF;
  IF v_manifest.signature_algorithm <> 'Ed25519'
    OR length(btrim(v_manifest.signature)) = 0
    OR length(btrim(v_manifest.signing_key_version)) = 0 THEN
    RAISE EXCEPTION 'Release manifest signature contract is invalid';
  END IF;

  SELECT version.* INTO v_version
  FROM selena_registry.content_versions AS version
  WHERE version.id = v_manifest.content_version_id
    AND version.organization_id = v_manifest.organization_id
    AND version.brand_id = v_manifest.brand_id;
  IF NOT FOUND OR v_version.content_hash IS DISTINCT FROM (v_manifest.manifest -> 'content' ->> 'contentHash') THEN
    RAISE EXCEPTION 'Content version hash no longer matches the signed manifest';
  END IF;

  IF EXISTS (
    SELECT 1 FROM selena_registry.kill_switches AS kill_switch
    WHERE kill_switch.organization_id = v_manifest.organization_id
      AND kill_switch.active
      AND (
        kill_switch.scope = 'GLOBAL'
        OR (kill_switch.scope = 'BRAND' AND kill_switch.brand_id = v_manifest.brand_id)
        OR (kill_switch.scope = 'ACCOUNT' AND kill_switch.channel_account_id = v_manifest.channel_account_id)
      )
  ) THEN RAISE EXCEPTION 'Kill switch is active'; END IF;

  SELECT binding.provider INTO v_provider
  FROM selena_registry.channel_provider_bindings AS binding
  WHERE binding.channel_account_id = v_manifest.channel_account_id
    AND binding.organization_id = v_manifest.organization_id
    AND binding.brand_id = v_manifest.brand_id
    AND binding.environment = p_environment
    AND binding.active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No active provider is bound to this channel and environment';
  END IF;

  v_metadata := jsonb_build_object(
    'channelAccountId', v_manifest.channel_account_id,
    'contentVersionId', v_manifest.content_version_id,
    'environment', p_environment::text,
    'idempotencyKey', p_idempotency_key,
    'manifestHash', v_manifest.manifest_hash,
    'provider', v_provider
  );
  SELECT event.event_hash INTO v_previous_hash
  FROM selena_audit.audit_events AS event
  WHERE event.organization_id = v_manifest.organization_id
  ORDER BY event.created_at DESC, event.id DESC
  LIMIT 1;
  v_event_hash := encode(pg_catalog.sha256(convert_to(
    COALESCE(v_previous_hash, '') || '|release.dispatch_authorized|' || p_manifest_id::text || '|' || v_metadata::text,
    'utf8'
  )), 'hex');

  INSERT INTO selena_audit.audit_events (
    organization_id, brand_id, actor_id, action, aggregate_type, aggregate_id, previous_hash, event_hash, metadata
  ) VALUES (
    v_manifest.organization_id, v_manifest.brand_id, 'service:gateway', 'release.dispatch_authorized',
    'release_manifest', p_manifest_id::text, v_previous_hash, v_event_hash, v_metadata
  ) RETURNING id INTO v_audit_event_id;

  RETURN QUERY SELECT
    v_audit_event_id, v_version.content_hash, v_manifest.expires_at, v_manifest.manifest_hash,
    v_provider, v_manifest.signature, v_manifest.signature_algorithm, v_manifest.signing_key_version;
END;
$$;

REVOKE ALL ON FUNCTION selena_release.authorize_provider_dispatch(
  uuid, selena_registry.release_environment, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION selena_release.authorize_provider_dispatch(
  uuid, selena_registry.release_environment, text
) TO selena_gateway_runtime;

DO $$
BEGIN
  IF has_table_privilege('selena_gateway_runtime', 'selena_audit.audit_events', 'INSERT') THEN
    RAISE EXCEPTION 'Release Gateway must append dispatch audit entries through the authorization boundary';
  END IF;
  IF has_table_privilege('selena_web_runtime', 'selena_registry.channel_provider_bindings', 'INSERT')
    OR has_table_privilege('selena_gateway_runtime', 'selena_registry.channel_provider_bindings', 'INSERT')
    OR has_table_privilege('selena_gateway_runtime', 'selena_registry.channel_provider_bindings', 'UPDATE') THEN
    RAISE EXCEPTION 'Provider bindings must not be writable by a runtime login';
  END IF;
END $$;

RESET ROLE;

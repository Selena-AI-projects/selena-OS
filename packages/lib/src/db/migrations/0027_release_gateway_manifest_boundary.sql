SET ROLE selena_schema_owner;

CREATE TABLE IF NOT EXISTS selena_registry.content_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id text NOT NULL REFERENCES public.organization(id),
  brand_id text NOT NULL REFERENCES public.brands(id),
  policy_version text NOT NULL,
  require_evidence boolean NOT NULL DEFAULT false,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_policies_policy_version_nonempty CHECK (length(btrim(policy_version)) > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS content_policies_brand_version_unique
  ON selena_registry.content_policies (brand_id, policy_version);
CREATE INDEX IF NOT EXISTS content_policies_org_idx
  ON selena_registry.content_policies (organization_id);
ALTER TABLE selena_registry.content_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE selena_registry.content_policies FORCE ROW LEVEL SECURITY;

ALTER TABLE selena_release.release_intents
  ADD COLUMN IF NOT EXISTS schedule_timezone text NOT NULL DEFAULT 'UTC';
ALTER TABLE selena_release.release_intents
  DROP CONSTRAINT IF EXISTS release_intents_schedule_timezone_nonempty,
  ADD CONSTRAINT release_intents_schedule_timezone_nonempty CHECK (length(btrim(schedule_timezone)) > 0);

CREATE POLICY content_policies_web_select ON selena_registry.content_policies
  FOR SELECT TO selena_web_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['web']));
CREATE POLICY content_policies_web_insert ON selena_registry.content_policies
  FOR INSERT TO selena_web_runtime
  WITH CHECK (selena_registry.can_write_brand(organization_id, brand_id, ARRAY['web']));
CREATE POLICY content_policies_web_update ON selena_registry.content_policies
  FOR UPDATE TO selena_web_runtime
  USING (selena_registry.can_write_brand(organization_id, brand_id, ARRAY['web']))
  WITH CHECK (selena_registry.can_write_brand(organization_id, brand_id, ARRAY['web']));
CREATE POLICY content_policies_web_delete_denied ON selena_registry.content_policies
  FOR DELETE TO selena_web_runtime USING (false);
CREATE POLICY content_policies_schema_owner_select ON selena_registry.content_policies
  FOR SELECT TO selena_schema_owner USING (true);

CREATE POLICY approvals_schema_owner_select ON selena_registry.approvals
  FOR SELECT TO selena_schema_owner USING (true);
CREATE POLICY kill_switches_schema_owner_select ON selena_registry.kill_switches
  FOR SELECT TO selena_schema_owner USING (true);
CREATE POLICY release_intents_schema_owner_select ON selena_release.release_intents
  FOR SELECT TO selena_schema_owner USING (true);
CREATE POLICY release_manifests_schema_owner_select ON selena_release.release_manifests
  FOR SELECT TO selena_schema_owner USING (true);
CREATE POLICY release_manifests_schema_owner_insert ON selena_release.release_manifests
  FOR INSERT TO selena_schema_owner WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON selena_registry.content_policies TO selena_web_runtime;
REVOKE INSERT ON selena_release.release_manifests FROM selena_gateway_runtime;

CREATE OR REPLACE FUNCTION selena_registry.policy_requires_evidence(
  p_organization_id text,
  p_brand_id text,
  p_policy_version text
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, selena_registry
AS $$
  SELECT COALESCE((
    SELECT policy.require_evidence
    FROM selena_registry.content_policies policy
    WHERE policy.organization_id = p_organization_id
      AND policy.brand_id = p_brand_id
      AND policy.policy_version = p_policy_version
    LIMIT 1
  ), false);
$$;

CREATE OR REPLACE FUNCTION selena_registry.can_create_approval(
  p_organization_id text,
  p_brand_id text,
  p_content_version_id uuid,
  p_channel_account_id uuid,
  p_approver_id text,
  p_content_hash text,
  p_policy_version text
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, selena_registry
AS $$
  SELECT
    selena_registry.can_human_approve(p_organization_id, p_brand_id)
    AND p_approver_id = current_setting('app.selena_actor_id', true)
    AND EXISTS (
      SELECT 1 FROM selena_registry.content_versions cv
      WHERE cv.id = p_content_version_id
        AND cv.organization_id = p_organization_id
        AND cv.brand_id = p_brand_id
        AND cv.content_hash = p_content_hash
        AND cv.policy_version = p_policy_version
        AND (
          NOT selena_registry.policy_requires_evidence(p_organization_id, p_brand_id, p_policy_version)
          OR (
            cv.evidence <> '[]'::jsonb
            AND cv.evidence_expires_at IS NOT NULL
            AND cv.evidence_expires_at > now()
          )
        )
    )
    AND EXISTS (
      SELECT 1 FROM selena_registry.channel_accounts ca
      WHERE ca.id = p_channel_account_id
        AND ca.organization_id = p_organization_id
        AND ca.brand_id = p_brand_id
        AND (
          (ca.allowlisted AND ca.status = 'ACTIVE')
          OR (
            p_organization_id = 'default'
            AND p_brand_id = 'selena'
            AND ca.platform = 'linkedin_page_dry_run'
            AND ca.provider_account_ref = 'Postiz local dry run'
            AND ca.provider_integration_id IS NULL
            AND ca.status = 'DRY_RUN'
            AND ca.allowlisted = false
          )
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM selena_registry.content_assets a
      WHERE a.content_version_id = p_content_version_id
        AND a.organization_id = p_organization_id
        AND a.brand_id = p_brand_id
        AND (
          a.scan_status <> 'CLEAN'
          OR a.object_version_id IS NULL
          OR a.scan_provider_event_ref IS NULL
          OR a.verified_at IS NULL
          OR a.rights_expires_at IS NULL
          OR a.rights_expires_at <= now()
          OR a.consent_expires_at IS NULL
          OR a.consent_expires_at <= now()
        )
    );
$$;

CREATE OR REPLACE FUNCTION selena_release.build_gateway_release_package(
  p_release_intent_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, selena_registry, selena_release
AS $$
DECLARE
  v_intent selena_release.release_intents%ROWTYPE;
  v_approval selena_registry.approvals%ROWTYPE;
  v_version selena_registry.content_versions%ROWTYPE;
  v_account selena_registry.channel_accounts%ROWTYPE;
  v_latest_decision text;
  v_assets jsonb;
  v_assets_ready boolean;
  v_require_evidence boolean;
BEGIN
  IF NOT pg_has_role(session_user, 'selena_gateway_runtime', 'member')
    OR current_setting('app.selena_service_identity', true) IS DISTINCT FROM 'gateway'
    OR current_setting('app.selena_actor_id', true) IS DISTINCT FROM 'service:gateway'
    OR current_setting('app.selena_auth_type', true) IS DISTINCT FROM 'service' THEN
    RAISE EXCEPTION 'Only the Release Gateway runtime may create a publication package';
  END IF;

  SELECT * INTO v_intent FROM selena_release.release_intents WHERE id = p_release_intent_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Release intent was not found'; END IF;
  IF v_intent.status IN ('CANCELLED', 'BLOCKED', 'FAILED') THEN RAISE EXCEPTION 'Release intent is not dispatchable'; END IF;

  SELECT * INTO v_approval FROM selena_registry.approvals
  WHERE id = v_intent.approval_id
    AND organization_id = v_intent.organization_id
    AND brand_id = v_intent.brand_id
    AND decision = 'APPROVED';
  IF NOT FOUND OR v_approval.content_version_id <> v_intent.content_version_id
    OR v_approval.channel_account_id <> v_intent.channel_account_id THEN
    RAISE EXCEPTION 'Exact approved release binding is missing';
  END IF;
  IF v_approval.expires_at IS NULL OR v_approval.expires_at <= now() THEN
    RAISE EXCEPTION 'Human approval has expired';
  END IF;

  SELECT decision INTO v_latest_decision FROM selena_registry.approvals
  WHERE organization_id = v_intent.organization_id
    AND brand_id = v_intent.brand_id
    AND content_version_id = v_intent.content_version_id
    AND channel_account_id = v_intent.channel_account_id
  ORDER BY created_at DESC LIMIT 1;
  IF v_latest_decision IS DISTINCT FROM 'APPROVED' THEN RAISE EXCEPTION 'Approval was revoked or superseded'; END IF;

  SELECT * INTO v_version FROM selena_registry.content_versions
  WHERE id = v_intent.content_version_id
    AND organization_id = v_intent.organization_id
    AND brand_id = v_intent.brand_id;
  IF NOT FOUND OR v_version.content_hash <> v_approval.content_hash
    OR v_version.policy_version <> v_approval.policy_version THEN
    RAISE EXCEPTION 'Content changed after approval';
  END IF;
  IF EXISTS (
    SELECT 1 FROM selena_registry.content_versions newer_version
    WHERE newer_version.content_id = v_version.content_id
      AND newer_version.organization_id = v_intent.organization_id
      AND newer_version.brand_id = v_intent.brand_id
      AND newer_version.version > v_version.version
  ) THEN
    RAISE EXCEPTION 'A newer content version invalidates this release';
  END IF;
  -- content_hash is calculated from the disclosure in the application canonical
  -- representation. Re-hashing jsonb::text here could diverge in whitespace or
  -- key order, while this comparison binds the immutable disclosure transitively.

  SELECT * INTO v_account FROM selena_registry.channel_accounts
  WHERE id = v_intent.channel_account_id
    AND organization_id = v_intent.organization_id
    AND brand_id = v_intent.brand_id;
  IF NOT FOUND OR NOT v_account.allowlisted OR v_account.status <> 'ACTIVE'
    OR v_account.provider_integration_id IS NULL THEN
    RAISE EXCEPTION 'Destination is not an active allowlisted integration';
  END IF;

  IF EXISTS (
    SELECT 1 FROM selena_registry.kill_switches kill_switch
    WHERE kill_switch.organization_id = v_intent.organization_id
      AND kill_switch.active
      AND (
        kill_switch.scope = 'GLOBAL'
        OR (kill_switch.scope = 'BRAND' AND kill_switch.brand_id = v_intent.brand_id)
        OR (kill_switch.scope = 'ACCOUNT' AND kill_switch.channel_account_id = v_intent.channel_account_id)
      )
  ) THEN RAISE EXCEPTION 'Kill switch is active'; END IF;

  v_require_evidence := selena_registry.policy_requires_evidence(
    v_intent.organization_id, v_intent.brand_id, v_version.policy_version
  );
  IF v_require_evidence AND (v_version.evidence = '[]'::jsonb OR v_version.evidence_expires_at IS NULL OR v_version.evidence_expires_at <= now()) THEN
    RAISE EXCEPTION 'Required evidence is missing or expired';
  END IF;

  SELECT
    COALESCE(jsonb_agg(jsonb_build_object(
      'assetId', asset.id,
      'sha256', asset.sha256,
      'mimeType', asset.mime_type,
      'storageKey', asset.storage_key,
      'objectVersionId', asset.object_version_id
    ) ORDER BY asset.id), '[]'::jsonb),
    COALESCE(bool_and(
      asset.scan_status = 'CLEAN'
      AND asset.object_version_id IS NOT NULL
      AND asset.scan_provider_event_ref IS NOT NULL
      AND asset.verified_at IS NOT NULL
      AND asset.rights_expires_at > now()
      AND asset.consent_expires_at > now()
    ), true)
  INTO v_assets, v_assets_ready
  FROM selena_registry.content_assets asset
  WHERE asset.organization_id = v_intent.organization_id
    AND asset.brand_id = v_intent.brand_id
    AND asset.content_version_id = v_intent.content_version_id;
  IF NOT v_assets_ready THEN RAISE EXCEPTION 'Asset safety, rights, or consent gate failed'; END IF;

  RETURN jsonb_build_object(
    'schemaVersion', 'selena.publication-package/v1',
    'releaseIntentId', v_intent.id,
    'organizationId', v_intent.organization_id,
    'brandId', v_intent.brand_id,
    'destination', jsonb_build_object(
      'platform', v_account.platform,
      'channelAccountId', v_account.id,
      'integrationId', v_account.provider_integration_id,
      'accountRef', v_account.provider_account_ref
    ),
    'schedule', jsonb_build_object('notBefore', v_intent.not_before, 'timezone', v_intent.schedule_timezone),
    'content', jsonb_build_object(
      'contentVersionId', v_version.id,
      'body', v_version.body,
      'ctaUrl', v_version.cta_url,
      'claims', v_version.claims,
      'evidence', v_version.evidence,
      'disclosure', v_version.disclosure,
      'contentHash', v_version.content_hash,
      'policyVersion', v_version.policy_version
    ),
    'assets', v_assets,
    'approval', jsonb_build_object(
      'approvalId', v_approval.id,
      'bindingHash', v_approval.binding_hash,
      'assetBundleHash', v_approval.asset_bundle_hash,
      'expiresAt', v_approval.expires_at
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION selena_release.record_gateway_release_manifest(
  p_release_intent_id uuid,
  p_manifest jsonb,
  p_canonical_manifest text,
  p_manifest_hash text,
  p_signature_algorithm text,
  p_signing_key_version text,
  p_signature text,
  p_expires_at timestamptz
) RETURNS TABLE(id uuid, manifest_hash text, expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, selena_registry, selena_release
AS $$
DECLARE
  v_expected jsonb;
  v_intent selena_release.release_intents%ROWTYPE;
BEGIN
  v_expected := selena_release.build_gateway_release_package(p_release_intent_id);
  IF p_manifest <> v_expected THEN RAISE EXCEPTION 'Release package changed before manifest recording'; END IF;
  IF p_canonical_manifest::jsonb <> p_manifest THEN
    RAISE EXCEPTION 'Canonical manifest does not match the immutable release package';
  END IF;
  IF encode(pg_catalog.sha256(convert_to(p_canonical_manifest, 'utf8')), 'hex') <> p_manifest_hash THEN
    RAISE EXCEPTION 'Release manifest hash does not match the canonical package';
  END IF;
  IF p_manifest_hash !~ '^[a-f0-9]{64}$' OR p_signature_algorithm <> 'Ed25519'
    OR length(btrim(p_signing_key_version)) = 0 OR length(btrim(p_signature)) = 0 THEN
    RAISE EXCEPTION 'Release manifest signature contract is invalid';
  END IF;
  IF p_expires_at <= now() OR p_expires_at > now() + interval '7 days' THEN
    RAISE EXCEPTION 'Release manifest expiry is invalid';
  END IF;
  SELECT intent.* INTO v_intent
  FROM selena_release.release_intents AS intent
  WHERE intent.id = p_release_intent_id;

  INSERT INTO selena_release.release_manifests AS release_manifest (
    organization_id, brand_id, content_version_id, approval_id, channel_account_id, platform,
    manifest, manifest_hash, signature_algorithm, signing_key_version, signature, expires_at, created_by
  ) VALUES (
    v_intent.organization_id, v_intent.brand_id, v_intent.content_version_id, v_intent.approval_id,
    v_intent.channel_account_id, v_intent.platform, p_manifest, p_manifest_hash, p_signature_algorithm,
    p_signing_key_version, p_signature, p_expires_at, 'service:gateway'
  ) ON CONFLICT (approval_id, channel_account_id) DO NOTHING
  RETURNING release_manifest.id, release_manifest.manifest_hash, release_manifest.expires_at
  INTO id, manifest_hash, expires_at;

  IF id IS NULL THEN
    SELECT manifest.id, manifest.manifest_hash, manifest.expires_at
    INTO id, manifest_hash, expires_at
    FROM selena_release.release_manifests manifest
    WHERE manifest.approval_id = v_intent.approval_id
      AND manifest.channel_account_id = v_intent.channel_account_id;
    IF manifest_hash <> p_manifest_hash THEN RAISE EXCEPTION 'Existing manifest does not match this immutable package'; END IF;
  END IF;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION selena_registry.policy_requires_evidence(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION selena_release.build_gateway_release_package(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION selena_release.record_gateway_release_manifest(uuid, jsonb, text, text, text, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION selena_registry.policy_requires_evidence(text, text, text) TO selena_web_runtime, selena_gateway_runtime;
GRANT EXECUTE ON FUNCTION selena_release.build_gateway_release_package(uuid) TO selena_gateway_runtime;
GRANT EXECUTE ON FUNCTION selena_release.record_gateway_release_manifest(uuid, jsonb, text, text, text, text, text, timestamptz)
  TO selena_gateway_runtime;

DO $$
BEGIN
  IF has_table_privilege('selena_gateway_runtime', 'selena_release.release_manifests', 'INSERT') THEN
    RAISE EXCEPTION 'Release Gateway must use the signed manifest recording function';
  END IF;
END $$;

RESET ROLE;

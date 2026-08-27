-- Preserve the normal human-approval predicate while allowing the fixed
-- Selena staging dry-run account. This account has no integration ID and
-- cannot represent an externally publishable destination.
SET ROLE selena_schema_owner;

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
      SELECT 1
      FROM selena_registry.content_versions cv
      WHERE cv.id = p_content_version_id
        AND cv.organization_id = p_organization_id
        AND cv.brand_id = p_brand_id
        AND cv.content_hash = p_content_hash
        AND cv.policy_version = p_policy_version
        AND cv.evidence <> '[]'::jsonb
        AND cv.evidence_expires_at IS NOT NULL
        AND cv.evidence_expires_at > now()
    )
    AND EXISTS (
      SELECT 1
      FROM selena_registry.channel_accounts ca
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
      SELECT 1
      FROM selena_registry.content_assets a
      WHERE a.content_version_id = p_content_version_id
        AND a.organization_id = p_organization_id
        AND a.brand_id = p_brand_id
        AND (
          a.scan_status <> 'PASSED'
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

REVOKE ALL ON FUNCTION selena_registry.can_create_approval(text, text, uuid, uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION selena_registry.can_create_approval(text, text, uuid, uuid, text, text, text)
  TO selena_web_runtime;

DO $$
BEGIN
  IF NOT has_table_privilege('selena_web_runtime', 'selena_registry.approvals', 'INSERT') THEN
    RAISE EXCEPTION 'selena_web_runtime must retain approvals INSERT';
  END IF;

  IF has_table_privilege('selena_web_runtime', 'selena_release.publication_attempts', 'INSERT') THEN
    RAISE EXCEPTION 'web runtime must not insert publication attempts';
  END IF;
END $$;

-- The staging runner records the Drizzle ledger entry after this SQL completes.

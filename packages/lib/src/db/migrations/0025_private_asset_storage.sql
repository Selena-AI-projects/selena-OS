-- Private originals are never accessible through the Supabase Data API. This
-- migration prepares only Selena's private registry; the scanner runtime owns
-- the private Storage API credential and creates the bucket itself.
SET ROLE selena_schema_owner;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'selena_registry'
      AND t.typname = 'asset_scan_status'
      AND e.enumlabel = 'PASSED'
  ) THEN
    ALTER TYPE selena_registry.asset_scan_status RENAME VALUE 'PASSED' TO 'CLEAN';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'selena_registry'
      AND t.typname = 'asset_scan_status'
      AND e.enumlabel = 'SCANNING'
  ) THEN
    ALTER TYPE selena_registry.asset_scan_status ADD VALUE 'SCANNING' AFTER 'QUARANTINED';
  END IF;
END $$;

ALTER TABLE selena_registry.content_assets
  ADD COLUMN IF NOT EXISTS storage_bucket text NOT NULL DEFAULT 'selena-quarantine',
  ADD COLUMN IF NOT EXISTS original_filename text NOT NULL DEFAULT 'upload',
  ADD COLUMN IF NOT EXISTS detected_mime_type text,
  ADD COLUMN IF NOT EXISTS scan_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS scan_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS scan_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS scan_available_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS scan_lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS scan_lease_token uuid,
  ADD COLUMN IF NOT EXISTS scan_error text,
  ADD COLUMN IF NOT EXISTS scanner_version text,
  ADD COLUMN IF NOT EXISTS rejection_reason text;

ALTER TABLE selena_registry.content_assets
  DROP CONSTRAINT IF EXISTS content_assets_scan_attempts_nonnegative,
  ADD CONSTRAINT content_assets_scan_attempts_nonnegative CHECK (scan_attempts >= 0),
  DROP CONSTRAINT IF EXISTS content_assets_storage_bucket_private,
  ADD CONSTRAINT content_assets_storage_bucket_private CHECK (storage_bucket = 'selena-quarantine');

ALTER TABLE selena_registry.content_assets
  DROP COLUMN IF EXISTS legacy_scan_result;

CREATE UNIQUE INDEX IF NOT EXISTS content_assets_bucket_key_unique
  ON selena_registry.content_assets (storage_bucket, storage_key);
CREATE INDEX IF NOT EXISTS content_assets_scan_queue_idx
  ON selena_registry.content_assets (scan_status, scan_available_at, created_at);

-- Uploads are server-mediated through the scanner. The ordinary web role can
-- still read tenant-scoped asset metadata, but can never create storage claims
-- or write a scan result directly.
DROP POLICY IF EXISTS content_assets_web_insert ON selena_registry.content_assets;
REVOKE INSERT ON selena_registry.content_assets FROM selena_web_runtime;

CREATE POLICY content_assets_scanner_insert ON selena_registry.content_assets
  FOR INSERT TO selena_scanner_runtime
  WITH CHECK (
    selena_registry.can_write_brand(organization_id, brand_id, ARRAY['scanner'])
    AND scan_status = 'QUARANTINED'
    AND storage_bucket = 'selena-quarantine'
  );

CREATE POLICY content_assets_schema_owner_update ON selena_registry.content_assets
  FOR UPDATE TO selena_schema_owner USING (true) WITH CHECK (true);

GRANT INSERT, UPDATE (
  object_version_id,
  detected_mime_type,
  scan_status,
  scan_provider_event_ref,
  scan_started_at,
  scan_completed_at,
  scan_attempts,
  scan_available_at,
  scan_lease_expires_at,
  scan_lease_token,
  scan_error,
  scanner_version,
  rejection_reason,
  verified_at
) ON selena_registry.content_assets TO selena_scanner_runtime;

-- PostgreSQL keeps an enum literal in the previous SQL-language approval
-- predicate as source text. Re-author it after PASSED was renamed to CLEAN so
-- old approval rows retain their meaning without an invalid enum literal at
-- runtime. The fixed local dry-run channel remains a non-publishable account.
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

REVOKE ALL ON FUNCTION selena_registry.can_create_approval(text, text, uuid, uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION selena_registry.can_create_approval(text, text, uuid, uuid, text, text, text)
  TO selena_web_runtime;

COMMENT ON TABLE selena_registry.content_assets IS
  'Private immutable original assets. Browser access is mediated by Selena web; only selena_scanner_runtime uses the private Storage API credential and may change scan state.';

RESET ROLE;

-- Repair the missing 0022 ACL side effect without changing its historical ledger entry.
-- The staging migration login may become only the dedicated schema owner role.
SET ROLE selena_schema_owner;

GRANT USAGE ON SCHEMA selena_performance TO selena_web_runtime;
REVOKE INSERT ON TABLE selena_registry.channel_accounts FROM selena_web_runtime;

DROP POLICY IF EXISTS channel_accounts_schema_owner_staging_dry_run_select
  ON selena_registry.channel_accounts;
CREATE POLICY channel_accounts_schema_owner_staging_dry_run_select
  ON selena_registry.channel_accounts
  FOR SELECT TO selena_schema_owner
  USING (
    organization_id = 'default'
    AND brand_id = 'selena'
    AND platform = 'linkedin_page_dry_run'
    AND provider_account_ref = 'Postiz local dry run'
    AND provider_integration_id IS NULL
    AND status = 'DRY_RUN'
    AND allowlisted = false
  );
DROP POLICY IF EXISTS channel_accounts_schema_owner_staging_dry_run_insert
  ON selena_registry.channel_accounts;
CREATE POLICY channel_accounts_schema_owner_staging_dry_run_insert
  ON selena_registry.channel_accounts
  FOR INSERT TO selena_schema_owner
  WITH CHECK (
    organization_id = 'default'
    AND brand_id = 'selena'
    AND platform = 'linkedin_page_dry_run'
    AND provider_account_ref = 'Postiz local dry run'
    AND provider_integration_id IS NULL
    AND status = 'DRY_RUN'
    AND allowlisted = false
  );

CREATE OR REPLACE FUNCTION selena_registry.ensure_staging_dry_run_channel_account()
RETURNS TABLE(channel_account_id uuid, created boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, selena_registry
AS $$
DECLARE
  v_organization_id text := current_setting('app.selena_organization_id', true);
  v_brand_id text := current_setting('app.selena_brand_id', true);
BEGIN
  IF v_organization_id <> 'default'
    OR v_brand_id <> 'selena'
    OR NOT selena_registry.can_human_approve(v_organization_id, v_brand_id) THEN
    RAISE EXCEPTION 'staging dry-run account requires an interactive Selena owner session';
  END IF;

  INSERT INTO selena_registry.channel_accounts (
    organization_id,
    brand_id,
    platform,
    provider_account_ref,
    provider_integration_id,
    status,
    allowlisted,
    created_by
  ) VALUES (
    v_organization_id,
    v_brand_id,
    'linkedin_page_dry_run',
    'Postiz local dry run',
    NULL,
    'DRY_RUN',
    false,
    current_setting('app.selena_actor_id', true)
  )
  ON CONFLICT (brand_id, platform, provider_account_ref) DO NOTHING
  RETURNING id INTO channel_account_id;

  created := FOUND;
  IF NOT created THEN
    SELECT account.id INTO channel_account_id
    FROM selena_registry.channel_accounts AS account
    WHERE account.organization_id = v_organization_id
      AND account.brand_id = v_brand_id
      AND account.platform = 'linkedin_page_dry_run'
      AND account.provider_account_ref = 'Postiz local dry run'
      AND account.provider_integration_id IS NULL
      AND account.status = 'DRY_RUN'
      AND account.allowlisted = false;
  END IF;

  IF channel_account_id IS NULL THEN
    RAISE EXCEPTION 'staging dry-run account violates its fixed safety contract';
  END IF;

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION selena_registry.ensure_staging_dry_run_channel_account() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION selena_registry.ensure_staging_dry_run_channel_account() TO selena_web_runtime;

DO $$
BEGIN
  IF NOT has_schema_privilege('selena_web_runtime', 'selena_performance', 'USAGE') THEN
    RAISE EXCEPTION 'selena_web_runtime must have USAGE on selena_performance';
  END IF;

  IF NOT has_table_privilege(
    'selena_web_runtime',
    'selena_performance.metric_snapshots',
    'SELECT'
  ) THEN
    RAISE EXCEPTION 'selena_web_runtime must retain metric_snapshots SELECT';
  END IF;

  IF has_schema_privilege('selena_web_runtime', 'selena_performance', 'CREATE')
    OR has_table_privilege('selena_web_runtime', 'selena_performance.metric_snapshots', 'INSERT')
    OR has_table_privilege('selena_web_runtime', 'selena_performance.metric_snapshots', 'UPDATE')
    OR has_table_privilege('selena_web_runtime', 'selena_performance.metric_snapshots', 'DELETE')
    OR has_table_privilege('selena_web_runtime', 'selena_performance.metric_snapshots', 'TRUNCATE')
    OR has_table_privilege('selena_web_runtime', 'selena_registry.channel_accounts', 'INSERT') THEN
    RAISE EXCEPTION 'selena_web_runtime received excess selena_performance privileges';
  END IF;

  IF pg_has_role('selena_web_runtime', 'selena_migrator', 'MEMBER')
    OR pg_has_role('selena_web_runtime', 'selena_migrator', 'SET')
    OR pg_has_role('selena_web_runtime', 'selena_schema_owner', 'MEMBER')
    OR pg_has_role('selena_web_runtime', 'selena_schema_owner', 'SET')
    OR pg_has_role('selena_registry_worker_runtime', 'selena_migrator', 'MEMBER')
    OR pg_has_role('selena_registry_worker_runtime', 'selena_migrator', 'SET')
    OR pg_has_role('selena_registry_worker_runtime', 'selena_schema_owner', 'MEMBER')
    OR pg_has_role('selena_registry_worker_runtime', 'selena_schema_owner', 'SET') THEN
    RAISE EXCEPTION 'web or worker runtime can become a migration role';
  END IF;
END $$;

-- The staging runner records the Drizzle ledger entry after this SQL completes.
-- It owns this one-off connection and closes it immediately after that insert.

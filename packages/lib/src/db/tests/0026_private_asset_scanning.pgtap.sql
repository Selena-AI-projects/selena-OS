-- Run only against a disposable database after migrations 0025 and 0026.
BEGIN;
SELECT plan(13);

SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'selena_registry' AND t.typname = 'asset_scan_status' AND e.enumlabel = 'SCANNING'
  )
  AND EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'selena_registry' AND t.typname = 'asset_scan_status' AND e.enumlabel = 'CLEAN'
  ),
  'private assets have quarantined, scanning, clean, and rejected states'
);

CREATE ROLE selena_pgtap_scanner LOGIN IN ROLE selena_scanner_runtime;
CREATE ROLE selena_pgtap_asset_web LOGIN IN ROLE selena_web_runtime;

INSERT INTO public."user" (id, name, email, email_verified, created_at, updated_at)
VALUES ('selena-asset-user', 'Selena asset user', 'selena-asset-user@example.invalid', true, now(), now());
INSERT INTO public.organization (id, name, slug, created_at)
VALUES
  ('selena-asset-org-a', 'Selena asset org A', 'selena-asset-org-a', now()),
  ('selena-asset-org-b', 'Selena asset org B', 'selena-asset-org-b', now());
INSERT INTO public.member (id, organization_id, user_id, role, created_at)
VALUES ('selena-asset-member-a', 'selena-asset-org-a', 'selena-asset-user', 'owner', now());
INSERT INTO public.brands (id, name, website, organization_id)
VALUES
  ('selena-asset-brand-a', 'Selena asset brand A', 'https://asset-a.example.invalid', 'selena-asset-org-a'),
  ('selena-asset-brand-b', 'Selena asset brand B', 'https://asset-b.example.invalid', 'selena-asset-org-b');

SET ROLE selena_backup_restore;
INSERT INTO selena_registry.content_items (id, organization_id, brand_id, title, created_by)
VALUES
  ('30000000-0000-0000-0000-000000000001', 'selena-asset-org-a', 'selena-asset-brand-a', 'Asset A', 'seed'),
  ('40000000-0000-0000-0000-000000000001', 'selena-asset-org-b', 'selena-asset-brand-b', 'Asset B', 'seed');
INSERT INTO selena_registry.content_versions (
  id, organization_id, brand_id, content_id, version, body, cta_url, evidence, policy_version, content_hash, created_by
) VALUES
  ('30000000-0000-0000-0000-000000000002', 'selena-asset-org-a', 'selena-asset-brand-a',
   '30000000-0000-0000-0000-000000000001', 1, 'asset a', 'https://asset-a.example.invalid', '[]'::jsonb, 'asset-v1', repeat('a', 64), 'seed'),
  ('40000000-0000-0000-0000-000000000002', 'selena-asset-org-b', 'selena-asset-brand-b',
   '40000000-0000-0000-0000-000000000001', 1, 'asset b', 'https://asset-b.example.invalid', '[]'::jsonb, 'asset-v1', repeat('b', 64), 'seed');
RESET ROLE;

SELECT ok(
  NOT has_table_privilege('selena_web_runtime', 'selena_registry.content_assets', 'INSERT')
  AND NOT has_table_privilege('selena_web_runtime', 'selena_registry.content_assets', 'UPDATE'),
  'web runtime cannot create asset records or set safety results'
);
SELECT ok(
  NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'storage')
  OR NOT has_schema_privilege('selena_web_runtime', 'storage', 'USAGE'),
  'web runtime has no Supabase Storage schema access'
);

SET SESSION AUTHORIZATION selena_pgtap_asset_web;
SELECT throws_ok(
  $$INSERT INTO selena_registry.content_assets (
      organization_id, brand_id, content_version_id, storage_bucket, storage_key, original_filename,
      sha256, mime_type, size_bytes, scan_status, created_by
    ) VALUES (
      'selena-asset-org-a', 'selena-asset-brand-a', '30000000-0000-0000-0000-000000000002',
      'selena-quarantine', 'originals/forged.png', 'forged.png', repeat('c', 64), 'image/png', 16, 'CLEAN', 'user'
    )$$,
  '42501',
  'permission denied for table content_assets',
  'web cannot forge a clean asset'
);
RESET SESSION AUTHORIZATION;

SET SESSION AUTHORIZATION selena_pgtap_scanner;
SELECT is_empty(
  $$SELECT id FROM selena_registry.content_assets$$,
  'scanner cannot read assets without a server-owned tenant context'
);
SELECT throws_ok(
  $$SELECT selena_registry.set_request_context(
      'selena-asset-user', 'selena-asset-org-a', 'selena-asset-brand-a', 'owner',
      '30000000-0000-0000-0000-000000000010', 'web', 'session'
    )$$,
  'P0001',
  'Scanner context is invalid',
  'scanner identity cannot perform human approval context'
);
SELECT selena_registry.set_request_context(
  'service:scanner', 'selena-asset-org-a', 'selena-asset-brand-a', 'service',
  '30000000-0000-0000-0000-000000000011', 'scanner', 'service'
);
INSERT INTO selena_registry.content_assets (
  id, organization_id, brand_id, content_version_id, storage_bucket, storage_key, object_version_id,
  original_filename, sha256, mime_type, detected_mime_type, size_bytes, scan_status,
  rights_expires_at, consent_expires_at, created_by
) VALUES (
  '30000000-0000-0000-0000-000000000003', 'selena-asset-org-a', 'selena-asset-brand-a',
  '30000000-0000-0000-0000-000000000002', 'selena-quarantine', 'originals/a.png', 'a-v1',
  'a.png', repeat('c', 64), 'image/png', 'image/png', 16, 'QUARANTINED',
  now() + interval '1 hour', now() + interval '1 hour', 'selena-asset-user'
);
SELECT is_empty(
  $$UPDATE selena_registry.content_assets
      SET scan_status = 'CLEAN'
    WHERE organization_id = 'selena-asset-org-b'
    RETURNING id$$,
  'scanner context for brand A cannot mutate brand B'
);

SELECT selena_registry.set_request_context(
  'service:scanner', '__scanner_queue__', '__scanner_queue__', 'service',
  '30000000-0000-0000-0000-000000000012', 'scanner', 'service'
);
CREATE TEMP TABLE claimed_asset AS
SELECT * FROM selena_registry.claim_next_quarantined_asset(300);
SELECT is((SELECT count(*) FROM claimed_asset)::integer, 1, 'scanner claims exactly one quarantined asset');
RESET SESSION AUTHORIZATION;
SELECT is(
  (SELECT scan_status::text FROM selena_registry.content_assets WHERE id = (SELECT id FROM claimed_asset)),
  'SCANNING',
  'claim moves the asset into scanning state'
);
SET SESSION AUTHORIZATION selena_pgtap_scanner;
SELECT selena_registry.set_request_context(
  'service:scanner', organization_id, brand_id, 'service',
  '30000000-0000-0000-0000-000000000013', 'scanner', 'service'
) FROM claimed_asset;
SELECT is_empty(
  $$UPDATE selena_registry.content_assets
      SET scan_status = 'CLEAN', verified_at = now()
    WHERE id = (SELECT id FROM claimed_asset)
      AND scan_lease_token = '30000000-0000-0000-0000-000000000014'::uuid
    RETURNING id$$,
  'replayed or stale lease token cannot complete a scan'
);
UPDATE selena_registry.content_assets
SET scan_status = 'CLEAN', scan_completed_at = now(), scan_lease_expires_at = NULL,
    verified_at = now(), scan_provider_event_ref = 'pgtap-clamav', scan_lease_token = NULL
WHERE id = (SELECT id FROM claimed_asset)
  AND scan_lease_token = (SELECT scan_lease_token FROM claimed_asset);
RESET SESSION AUTHORIZATION;
SELECT is(
  (SELECT scan_status::text FROM selena_registry.content_assets WHERE id = (SELECT id FROM claimed_asset)),
  'CLEAN',
  'only the active lease token can complete a clean scan'
);

SELECT ok(
  NOT pg_has_role('selena_web_runtime', 'selena_scanner_runtime', 'member')
  AND NOT pg_has_role('selena_registry_worker_runtime', 'selena_scanner_runtime', 'member')
  AND NOT pg_has_role('selena_scanner_runtime', 'selena_schema_owner', 'member'),
  'web, worker, and scanner cannot become each other or the schema owner'
);
SELECT ok(
  NOT has_table_privilege('selena_scanner_runtime', 'public.secrets', 'SELECT')
  AND NOT has_table_privilege('selena_scanner_runtime', 'selena_registry.approvals', 'INSERT'),
  'scanner cannot read credentials or approve content'
);

SELECT * FROM finish();
ROLLBACK;

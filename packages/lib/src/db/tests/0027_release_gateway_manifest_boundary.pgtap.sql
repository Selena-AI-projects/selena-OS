-- Run only against a disposable database after migration 0027 is installed.
-- This file must never be executed against staging or production.
BEGIN;
SELECT plan(18);

INSERT INTO public."user" (id, name, email, email_verified, created_at, updated_at)
VALUES ('selena-gateway-user', 'Selena Gateway owner', 'selena-gateway-owner@example.invalid', true, now(), now());
INSERT INTO public.organization (id, name, slug, created_at)
VALUES ('selena-gateway-org', 'Selena Gateway org', 'selena-gateway-org', now());
INSERT INTO public.member (id, organization_id, user_id, role, created_at)
VALUES ('selena-gateway-member', 'selena-gateway-org', 'selena-gateway-user', 'owner', now());
INSERT INTO public.brands (id, name, website, organization_id)
VALUES ('selena-gateway-brand', 'Selena Gateway brand', 'https://gateway.example.invalid', 'selena-gateway-org');

CREATE ROLE selena_pgtap_gateway_0027 LOGIN IN ROLE selena_gateway_runtime;

INSERT INTO selena_registry.content_items (id, organization_id, brand_id, title, created_by)
VALUES ('71000000-0000-0000-0000-000000000001', 'selena-gateway-org', 'selena-gateway-brand', 'Gateway material', 'seed');
INSERT INTO selena_registry.content_versions (
  id, organization_id, brand_id, content_id, version, body, cta_url, evidence, disclosure,
  policy_version, content_hash, created_by
) VALUES (
  '71000000-0000-0000-0000-000000000002',
  'selena-gateway-org', 'selena-gateway-brand', '71000000-0000-0000-0000-000000000001', 1,
  'A reviewed Selena Systems material', 'https://gateway.example.invalid/material', '[]'::jsonb,
  '{"disclosure":"reviewed"}'::jsonb, 'gateway-v1', repeat('a', 64), 'seed'
);
INSERT INTO selena_registry.channel_accounts (
  id, organization_id, brand_id, platform, provider_account_ref, provider_integration_id,
  status, allowlisted, created_by
) VALUES (
  '71000000-0000-0000-0000-000000000003',
  'selena-gateway-org', 'selena-gateway-brand', 'linkedin_page', 'Selena Systems Page',
  'selena-linkedin-integration', 'ACTIVE', true, 'seed'
);
INSERT INTO selena_registry.approvals (
  id, organization_id, brand_id, content_version_id, channel_account_id, decision,
  binding_hash, content_hash, asset_bundle_hash, policy_version, disclosure_hash, approver_id, expires_at
) VALUES (
  '71000000-0000-0000-0000-000000000004',
  'selena-gateway-org', 'selena-gateway-brand', '71000000-0000-0000-0000-000000000002',
  '71000000-0000-0000-0000-000000000003', 'APPROVED', repeat('b', 64), repeat('a', 64),
  repeat('c', 64), 'gateway-v1', repeat('d', 64), 'selena-gateway-user', now() + interval '1 hour'
);
INSERT INTO selena_release.release_intents (
  id, organization_id, brand_id, content_version_id, approval_id, channel_account_id,
  platform, idempotency_key, correlation_id, created_by
) VALUES (
  '71000000-0000-0000-0000-000000000005',
  'selena-gateway-org', 'selena-gateway-brand', '71000000-0000-0000-0000-000000000002',
  '71000000-0000-0000-0000-000000000004', '71000000-0000-0000-0000-000000000003',
  'linkedin_page', 'gateway-pgtap-idempotency', '71000000-0000-0000-0000-000000000006', 'seed'
);
INSERT INTO selena_registry.content_items (id, organization_id, brand_id, title, created_by)
VALUES
  ('71000000-0000-0000-0000-000000000020', 'selena-gateway-org', 'selena-gateway-brand', 'Expired approval material', 'seed'),
  ('71000000-0000-0000-0000-000000000030', 'selena-gateway-org', 'selena-gateway-brand', 'Revoked approval material', 'seed'),
  ('71000000-0000-0000-0000-000000000040', 'selena-gateway-org', 'selena-gateway-brand', 'Superseded material', 'seed');
INSERT INTO selena_registry.content_versions (
  id, organization_id, brand_id, content_id, version, body, cta_url, evidence, disclosure,
  policy_version, content_hash, created_by
) VALUES
  ('71000000-0000-0000-0000-000000000021', 'selena-gateway-org', 'selena-gateway-brand',
   '71000000-0000-0000-0000-000000000020', 1, 'Expired approval material', 'https://gateway.example.invalid/expired',
   '[]'::jsonb, '{}'::jsonb, 'gateway-v1', repeat('1', 64), 'seed'),
  ('71000000-0000-0000-0000-000000000031', 'selena-gateway-org', 'selena-gateway-brand',
   '71000000-0000-0000-0000-000000000030', 1, 'Revoked approval material', 'https://gateway.example.invalid/revoked',
   '[]'::jsonb, '{}'::jsonb, 'gateway-v1', repeat('2', 64), 'seed'),
  ('71000000-0000-0000-0000-000000000041', 'selena-gateway-org', 'selena-gateway-brand',
   '71000000-0000-0000-0000-000000000040', 1, 'Version one', 'https://gateway.example.invalid/versioned',
   '[]'::jsonb, '{}'::jsonb, 'gateway-v1', repeat('3', 64), 'seed'),
  ('71000000-0000-0000-0000-000000000042', 'selena-gateway-org', 'selena-gateway-brand',
   '71000000-0000-0000-0000-000000000040', 2, 'Version two', 'https://gateway.example.invalid/versioned',
   '[]'::jsonb, '{}'::jsonb, 'gateway-v1', repeat('4', 64), 'seed');
INSERT INTO selena_registry.channel_accounts (
  id, organization_id, brand_id, platform, provider_account_ref, provider_integration_id, status, allowlisted, created_by
) VALUES
  ('71000000-0000-0000-0000-000000000022', 'selena-gateway-org', 'selena-gateway-brand', 'linkedin_page', 'Expired Page', 'expired-integration', 'ACTIVE', true, 'seed'),
  ('71000000-0000-0000-0000-000000000032', 'selena-gateway-org', 'selena-gateway-brand', 'linkedin_page', 'Revoked Page', 'revoked-integration', 'ACTIVE', true, 'seed'),
  ('71000000-0000-0000-0000-000000000043', 'selena-gateway-org', 'selena-gateway-brand', 'linkedin_page', 'Versioned Page', 'versioned-integration', 'ACTIVE', true, 'seed');
INSERT INTO selena_registry.approvals (
  id, organization_id, brand_id, content_version_id, channel_account_id, decision,
  binding_hash, content_hash, asset_bundle_hash, policy_version, disclosure_hash, approver_id, expires_at, created_at
) VALUES
  ('71000000-0000-0000-0000-000000000023', 'selena-gateway-org', 'selena-gateway-brand',
   '71000000-0000-0000-0000-000000000021', '71000000-0000-0000-0000-000000000022', 'APPROVED',
   repeat('b', 64), repeat('1', 64), repeat('c', 64), 'gateway-v1', repeat('d', 64), 'selena-gateway-user', now() - interval '1 minute', now()),
  ('71000000-0000-0000-0000-000000000033', 'selena-gateway-org', 'selena-gateway-brand',
   '71000000-0000-0000-0000-000000000031', '71000000-0000-0000-0000-000000000032', 'APPROVED',
   repeat('b', 64), repeat('2', 64), repeat('c', 64), 'gateway-v1', repeat('d', 64), 'selena-gateway-user', now() + interval '1 hour', now()),
  ('71000000-0000-0000-0000-000000000034', 'selena-gateway-org', 'selena-gateway-brand',
   '71000000-0000-0000-0000-000000000031', '71000000-0000-0000-0000-000000000032', 'REVOKED',
   repeat('b', 64), repeat('2', 64), repeat('c', 64), 'gateway-v1', repeat('d', 64), 'selena-gateway-user', NULL, now() + interval '1 second'),
  ('71000000-0000-0000-0000-000000000044', 'selena-gateway-org', 'selena-gateway-brand',
   '71000000-0000-0000-0000-000000000041', '71000000-0000-0000-0000-000000000043', 'APPROVED',
   repeat('b', 64), repeat('3', 64), repeat('c', 64), 'gateway-v1', repeat('d', 64), 'selena-gateway-user', now() + interval '1 hour', now());
INSERT INTO selena_release.release_intents (
  id, organization_id, brand_id, content_version_id, approval_id, channel_account_id,
  platform, idempotency_key, correlation_id, created_by
) VALUES
  ('71000000-0000-0000-0000-000000000024', 'selena-gateway-org', 'selena-gateway-brand',
   '71000000-0000-0000-0000-000000000021', '71000000-0000-0000-0000-000000000023', '71000000-0000-0000-0000-000000000022',
   'linkedin_page', 'gateway-pgtap-expired', '71000000-0000-0000-0000-000000000025', 'seed'),
  ('71000000-0000-0000-0000-000000000035', 'selena-gateway-org', 'selena-gateway-brand',
   '71000000-0000-0000-0000-000000000031', '71000000-0000-0000-0000-000000000033', '71000000-0000-0000-0000-000000000032',
   'linkedin_page', 'gateway-pgtap-revoked', '71000000-0000-0000-0000-000000000036', 'seed'),
  ('71000000-0000-0000-0000-000000000045', 'selena-gateway-org', 'selena-gateway-brand',
   '71000000-0000-0000-0000-000000000041', '71000000-0000-0000-0000-000000000044', '71000000-0000-0000-0000-000000000043',
   'linkedin_page', 'gateway-pgtap-versioned', '71000000-0000-0000-0000-000000000046', 'seed');

SELECT ok(
  NOT has_table_privilege('selena_gateway_runtime', 'selena_release.release_manifests', 'INSERT'),
  'Gateway cannot insert manifests outside the immutable recording function'
);

SET SESSION AUTHORIZATION selena_pgtap_gateway_0027;
SELECT throws_ok(
  $$SELECT selena_release.build_gateway_release_package('71000000-0000-0000-0000-000000000005')$$,
  'P0001',
  'Only the Release Gateway runtime may create a publication package',
  'Gateway request context is mandatory'
);
SELECT selena_registry.set_request_context(
  'service:gateway', '__gateway__', '__gateway__', 'service',
  '71000000-0000-0000-0000-000000000007', 'gateway', 'service'
);
SELECT lives_ok(
  $$SELECT selena_release.build_gateway_release_package('71000000-0000-0000-0000-000000000005')$$,
  'Gateway builds a package for an exact active approval and destination'
);
SELECT is(
  (SELECT (selena_release.build_gateway_release_package('71000000-0000-0000-0000-000000000005')->'destination'->>'integrationId')),
  'selena-linkedin-integration',
  'package contains only the allowlisted destination integration'
);
SELECT is(
  (SELECT (selena_release.build_gateway_release_package('71000000-0000-0000-0000-000000000005')->'schedule'->>'timezone')),
  'UTC',
  'package binds the release schedule timezone before it can be signed'
);

RESET SESSION AUTHORIZATION;
INSERT INTO selena_registry.content_policies (
  organization_id, brand_id, policy_version, require_evidence, created_by
) VALUES ('selena-gateway-org', 'selena-gateway-brand', 'gateway-v1', true, 'seed');
SET SESSION AUTHORIZATION selena_pgtap_gateway_0027;
SELECT throws_ok(
  $$SELECT selena_release.build_gateway_release_package('71000000-0000-0000-0000-000000000005')$$,
  'P0001',
  'Required evidence is missing or expired',
  'evidence is required only when the selected policy requires it'
);
RESET SESSION AUTHORIZATION;
DELETE FROM selena_registry.content_policies WHERE organization_id = 'selena-gateway-org';
INSERT INTO selena_registry.kill_switches (organization_id, scope, active, reason, changed_by)
VALUES ('selena-gateway-org', 'GLOBAL', true, 'pgtap stop', 'seed');
SET SESSION AUTHORIZATION selena_pgtap_gateway_0027;
SELECT throws_ok(
  $$SELECT selena_release.build_gateway_release_package('71000000-0000-0000-0000-000000000005')$$,
  'P0001',
  'Kill switch is active',
  'active kill switch blocks package creation'
);
RESET SESSION AUTHORIZATION;
DELETE FROM selena_registry.kill_switches WHERE organization_id = 'selena-gateway-org';
UPDATE selena_registry.channel_accounts SET allowlisted = false WHERE id = '71000000-0000-0000-0000-000000000003';
SET SESSION AUTHORIZATION selena_pgtap_gateway_0027;
SELECT throws_ok(
  $$SELECT selena_release.build_gateway_release_package('71000000-0000-0000-0000-000000000005')$$,
  'P0001',
  'Destination is not an active allowlisted integration',
  'non-allowlisted destination is denied'
);
RESET SESSION AUTHORIZATION;
UPDATE selena_registry.channel_accounts SET allowlisted = true WHERE id = '71000000-0000-0000-0000-000000000003';
SET SESSION AUTHORIZATION selena_pgtap_gateway_0027;
SELECT throws_ok(
  $$SELECT selena_release.build_gateway_release_package('71000000-0000-0000-0000-000000000024')$$,
  'P0001',
  'Human approval has expired',
  'expired human approval is denied'
);
RESET SESSION AUTHORIZATION;
SET SESSION AUTHORIZATION selena_pgtap_gateway_0027;
SELECT throws_ok(
  $$SELECT selena_release.build_gateway_release_package('71000000-0000-0000-0000-000000000035')$$,
  'P0001',
  'Approval was revoked or superseded',
  'revoked approval is denied'
);
RESET SESSION AUTHORIZATION;
INSERT INTO selena_registry.content_assets (
  id, organization_id, brand_id, content_version_id, storage_bucket, storage_key, object_version_id,
  original_filename, sha256, mime_type, detected_mime_type, size_bytes, scan_status,
  rights_expires_at, consent_expires_at, verified_at, scan_provider_event_ref, created_by
) VALUES (
  '71000000-0000-0000-0000-000000000010',
  'selena-gateway-org', 'selena-gateway-brand', '71000000-0000-0000-0000-000000000002',
  'selena-quarantine', 'originals/rejected.png', 'rejected-v1', 'rejected.png', repeat('f', 64),
  'image/png', 'image/png', 1, 'REJECTED', now() + interval '1 hour', now() + interval '1 hour',
  now(), 'clamav:found', 'seed'
);
SET SESSION AUTHORIZATION selena_pgtap_gateway_0027;
SELECT throws_ok(
  $$SELECT selena_release.build_gateway_release_package('71000000-0000-0000-0000-000000000005')$$,
  'P0001',
  'Asset safety, rights, or consent gate failed',
  'malware-rejected asset is denied'
);
RESET SESSION AUTHORIZATION;
DELETE FROM selena_registry.content_assets WHERE id = '71000000-0000-0000-0000-000000000010';
INSERT INTO selena_registry.content_assets (
  id, organization_id, brand_id, content_version_id, storage_bucket, storage_key, object_version_id,
  original_filename, sha256, mime_type, detected_mime_type, size_bytes, scan_status,
  rights_expires_at, consent_expires_at, verified_at, scan_provider_event_ref, created_by
) VALUES (
  '71000000-0000-0000-0000-000000000011',
  'selena-gateway-org', 'selena-gateway-brand', '71000000-0000-0000-0000-000000000002',
  'selena-quarantine', 'originals/expired.png', 'expired-v1', 'expired.png', repeat('9', 64),
  'image/png', 'image/png', 1, 'CLEAN', now() - interval '1 minute', now() + interval '1 hour',
  now(), 'clamav:ok', 'seed'
);
SET SESSION AUTHORIZATION selena_pgtap_gateway_0027;
SELECT throws_ok(
  $$SELECT selena_release.build_gateway_release_package('71000000-0000-0000-0000-000000000005')$$,
  'P0001',
  'Asset safety, rights, or consent gate failed',
  'expired asset rights are denied even after a clean scan'
);
RESET SESSION AUTHORIZATION;
DELETE FROM selena_registry.content_assets WHERE id = '71000000-0000-0000-0000-000000000011';

SET SESSION AUTHORIZATION selena_pgtap_gateway_0027;
CREATE TEMP TABLE gateway_package AS
SELECT selena_release.build_gateway_release_package('71000000-0000-0000-0000-000000000005') AS package;
RESET SESSION AUTHORIZATION;
CREATE TEMP TABLE gateway_signed_package AS
SELECT package, package::text AS canonical_package, encode(pg_catalog.sha256(convert_to(package::text, 'utf8')), 'hex') AS manifest_hash
FROM gateway_package;
GRANT SELECT ON gateway_signed_package TO selena_pgtap_gateway_0027;
SET SESSION AUTHORIZATION selena_pgtap_gateway_0027;
SELECT lives_ok(
  $$SELECT * FROM selena_release.record_gateway_release_manifest(
      '71000000-0000-0000-0000-000000000005',
      (SELECT package FROM gateway_signed_package),
      (SELECT canonical_package FROM gateway_signed_package),
      (SELECT manifest_hash FROM gateway_signed_package),
      'Ed25519', 'pgtap-key-v1', 'pgtap-signature', now() + interval '1 hour'
    )$$,
  'Gateway records an immutable, canonical manifest'
);
RESET SESSION AUTHORIZATION;
SELECT is(
  (SELECT count(*) FROM selena_release.release_manifests WHERE approval_id = '71000000-0000-0000-0000-000000000004')::integer,
  1,
  'exactly one manifest is stored for an approval and destination'
);
SET SESSION AUTHORIZATION selena_pgtap_gateway_0027;
SELECT lives_ok(
  $$SELECT * FROM selena_release.record_gateway_release_manifest(
      '71000000-0000-0000-0000-000000000005',
      (SELECT package FROM gateway_signed_package),
      (SELECT canonical_package FROM gateway_signed_package),
      (SELECT manifest_hash FROM gateway_signed_package),
      'Ed25519', 'pgtap-key-v1', 'pgtap-signature', now() + interval '1 hour'
    )$$,
  'replaying an identical Gateway request is idempotent'
);
SELECT throws_ok(
  $$SELECT * FROM selena_release.record_gateway_release_manifest(
      '71000000-0000-0000-0000-000000000005',
      (SELECT package FROM gateway_signed_package),
      '{"changed":true}', repeat('a', 64),
      'Ed25519', 'pgtap-key-v1', 'pgtap-signature', now() + interval '1 hour'
    )$$,
  'P0001',
  'Canonical manifest does not match the immutable release package',
  'a changed canonical package cannot reuse the release intent'
);
SELECT throws_ok(
  $$INSERT INTO selena_release.release_manifests (
      organization_id, brand_id, content_version_id, approval_id, channel_account_id, platform,
      manifest, manifest_hash, signature_algorithm, signing_key_version, signature, expires_at, created_by
    ) VALUES (
      'selena-gateway-org', 'selena-gateway-brand', '71000000-0000-0000-0000-000000000002',
      '71000000-0000-0000-0000-000000000004', '71000000-0000-0000-0000-000000000003', 'linkedin_page',
      '{}'::jsonb, repeat('0', 64), 'Ed25519', 'forged', 'forged', now() + interval '1 hour', 'service:gateway'
    )$$,
  '42501',
  'permission denied for table release_manifests',
  'Gateway cannot bypass the manifest recording function'
);
RESET SESSION AUTHORIZATION;
SET SESSION AUTHORIZATION selena_pgtap_gateway_0027;
SELECT throws_ok(
  $$SELECT selena_release.build_gateway_release_package('71000000-0000-0000-0000-000000000045')$$,
  'P0001',
  'A newer content version invalidates this release',
  'a newer version blocks the old approval and release intent'
);
RESET SESSION AUTHORIZATION;

SELECT * FROM finish();
ROLLBACK;

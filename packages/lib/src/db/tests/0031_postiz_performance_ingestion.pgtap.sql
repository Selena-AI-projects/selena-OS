-- Run only against a disposable database after migration 0031 is installed.
-- This file must never be executed against staging or production.
BEGIN;
SELECT plan(9);

INSERT INTO public."user" (id, name, email, email_verified, created_at, updated_at)
VALUES ('selena-ingest-owner', 'Selena ingestion owner', 'selena-ingest-owner@example.invalid', true, now(), now());
INSERT INTO public.organization (id, name, slug, created_at)
VALUES ('selena-ingest-org', 'Selena ingestion org', 'selena-ingest-org', now());
INSERT INTO public.member (id, organization_id, user_id, role, created_at)
VALUES ('selena-ingest-member', 'selena-ingest-org', 'selena-ingest-owner', 'owner', now());
INSERT INTO public.brands (id, name, website, organization_id)
VALUES ('selena-ingest-brand', 'Selena ingestion brand', 'https://ingest.example.invalid', 'selena-ingest-org');
CREATE ROLE selena_pgtap_postiz_ingestion LOGIN IN ROLE selena_ingestion_runtime;
CREATE ROLE selena_pgtap_postiz_ingestion_web LOGIN IN ROLE selena_web_runtime;

SET ROLE selena_backup_restore;
INSERT INTO selena_registry.content_items (id, organization_id, brand_id, title, created_by)
VALUES ('75000000-0000-0000-0000-000000000001', 'selena-ingest-org', 'selena-ingest-brand', 'Measured material', 'seed');
INSERT INTO selena_registry.content_versions (
  id, organization_id, brand_id, content_id, version, body, cta_url, evidence, disclosure, policy_version, content_hash, created_by
) VALUES (
  '75000000-0000-0000-0000-000000000002', 'selena-ingest-org', 'selena-ingest-brand', '75000000-0000-0000-0000-000000000001',
  1, 'Measured material', 'https://ingest.example.invalid', '[]', '{}', 'ingest-v1', repeat('a', 64), 'seed'
);
INSERT INTO selena_registry.channel_accounts (id, organization_id, brand_id, platform, provider_account_ref, provider_integration_id, status, allowlisted, created_by)
VALUES ('75000000-0000-0000-0000-000000000003', 'selena-ingest-org', 'selena-ingest-brand', 'linkedin_page', 'Selena Systems', 'ingest-page', 'ACTIVE', true, 'seed');
INSERT INTO selena_registry.approvals (
  id, organization_id, brand_id, content_version_id, channel_account_id, decision, binding_hash, content_hash, asset_bundle_hash, policy_version, disclosure_hash, approver_id, expires_at
) VALUES (
  '75000000-0000-0000-0000-000000000004', 'selena-ingest-org', 'selena-ingest-brand', '75000000-0000-0000-0000-000000000002', '75000000-0000-0000-0000-000000000003',
  'APPROVED', repeat('b', 64), repeat('a', 64), repeat('c', 64), 'ingest-v1', repeat('d', 64), 'selena-ingest-owner', now() + interval '1 hour'
);
INSERT INTO selena_release.release_intents (
  id, organization_id, brand_id, content_version_id, approval_id, channel_account_id, platform, idempotency_key, correlation_id, status, created_by
) VALUES (
  '75000000-0000-0000-0000-000000000005', 'selena-ingest-org', 'selena-ingest-brand', '75000000-0000-0000-0000-000000000002', '75000000-0000-0000-0000-000000000004', '75000000-0000-0000-0000-000000000003',
  'linkedin_page', 'ingest-intent', '75000000-0000-0000-0000-000000000006', 'SUCCEEDED', 'seed'
);
INSERT INTO selena_release.release_manifests (
  id, organization_id, brand_id, content_version_id, approval_id, channel_account_id, platform, manifest, manifest_hash, signature_algorithm, signing_key_version, signature, expires_at, created_by
) VALUES (
  '75000000-0000-0000-0000-000000000007', 'selena-ingest-org', 'selena-ingest-brand', '75000000-0000-0000-0000-000000000002', '75000000-0000-0000-0000-000000000004', '75000000-0000-0000-0000-000000000003',
  'linkedin_page', '{"releaseIntentId":"75000000-0000-0000-0000-000000000005"}', repeat('e', 64), 'ed25519', 'test', 'signature', now() + interval '1 hour', 'seed'
);
INSERT INTO selena_release.dispatch_reservations (
  id, organization_id, brand_id, release_manifest_id, channel_account_id, platform, integration_id, allowlist_reference, idempotency_key, nonce
) VALUES (
  '75000000-0000-0000-0000-000000000008', 'selena-ingest-org', 'selena-ingest-brand', '75000000-0000-0000-0000-000000000007', '75000000-0000-0000-0000-000000000003',
  'linkedin_page', 'ingest-page', 'postiz:exact-integration', 'ingest-reservation', 'ingest-nonce'
);
INSERT INTO selena_release.publication_attempts (
  id, organization_id, brand_id, reservation_id, release_manifest_id, channel_account_id, platform, integration_id, allowlist_reference, manifest_hash, attempt_number, transition_number, status, provider_reference_id
) VALUES (
  '75000000-0000-0000-0000-000000000009', 'selena-ingest-org', 'selena-ingest-brand', '75000000-0000-0000-0000-000000000008', '75000000-0000-0000-0000-000000000007', '75000000-0000-0000-0000-000000000003',
  'linkedin_page', 'ingest-page', 'postiz:exact-integration', repeat('e', 64), 1, 2, 'CONFIRMED', 'postiz-post-1'
);
RESET ROLE;

SELECT ok(
  NOT has_table_privilege('selena_ingestion_runtime', 'selena_ingest_raw.raw_platform_snapshots', 'INSERT')
  AND NOT has_table_privilege('selena_ingestion_runtime', 'selena_performance.metric_snapshots', 'INSERT'),
  'ingestion cannot bypass the raw-evidence persistence boundary'
);

SET SESSION AUTHORIZATION selena_pgtap_postiz_ingestion_web;
SELECT throws_ok(
  $$SELECT selena_registry.set_request_context(
    'selena-ingest-owner', 'selena-ingest-org', 'selena-ingest-brand', 'owner',
    '75000000-0000-0000-0000-000000000010', 'ingestion', 'service', NULL
  )$$,
  'P0001',
  'Web runtime context must represent an interactive session',
  'web cannot forge an ingestion context'
);
RESET SESSION AUTHORIZATION;

SET SESSION AUTHORIZATION selena_pgtap_postiz_ingestion;
SELECT selena_registry.set_request_context(
  'service:ingestion', 'selena-ingest-org', 'selena-ingest-brand', 'service',
  '75000000-0000-0000-0000-000000000011', 'ingestion', 'service', NULL
);
CREATE TEMP TABLE recorded_snapshot AS
SELECT * FROM selena_ingest_raw.record_postiz_performance_snapshot(
  '75000000-0000-0000-0000-000000000009', repeat('f', 64),
  now() - interval '2 hours', now() - interval '1 hour', now(),
  '[{"label":"Impressions","data":[{"date":"2030-01-01","total":42}]}]'::jsonb,
  repeat('a', 64), 'postiz.analytics/v1', 'COMPLETE',
  '{"provider":"postiz","metrics":{"impressions":{"points":[{"observedOn":"2030-01-01T00:00:00.000Z","total":42}],"percentageChange":null}}}'::jsonb
);
SELECT is((SELECT count(*) FROM recorded_snapshot)::integer, 1, 'ingestion returns one attributed raw and metric snapshot');
RESET SESSION AUTHORIZATION;
SELECT is(
  (SELECT provider FROM selena_ingest_raw.raw_platform_snapshots WHERE id = (SELECT raw_snapshot_id FROM recorded_snapshot)),
  'postiz',
  'raw snapshot records Postiz provenance'
);
SELECT is(
  (SELECT publication_attempt_id FROM selena_performance.metric_snapshots WHERE id = (SELECT metric_snapshot_id FROM recorded_snapshot)),
  '75000000-0000-0000-0000-000000000009'::uuid,
  'normalized metrics remain attributed to the exact publication attempt'
);
SELECT is(
  (SELECT raw_snapshot_id FROM selena_performance.metric_snapshots WHERE id = (SELECT metric_snapshot_id FROM recorded_snapshot)),
  (SELECT raw_snapshot_id FROM recorded_snapshot),
  'normalized metrics retain their immutable raw evidence link'
);
SET SESSION AUTHORIZATION selena_pgtap_postiz_ingestion;
SELECT selena_registry.set_request_context(
  'service:ingestion', 'selena-ingest-org', 'selena-ingest-brand', 'service',
  '75000000-0000-0000-0000-000000000012', 'ingestion', 'service', NULL
);
SELECT is(
  (SELECT count(*) FROM selena_ingest_raw.record_postiz_performance_snapshot(
    '75000000-0000-0000-0000-000000000009', repeat('f', 64),
    now() - interval '2 hours', now() - interval '1 hour', now(),
    '[{"label":"Impressions","data":[{"date":"2030-01-01","total":42}]}]'::jsonb,
    repeat('a', 64), 'postiz.analytics/v1', 'COMPLETE',
    '{"provider":"postiz","metrics":{"impressions":{"points":[{"observedOn":"2030-01-01T00:00:00.000Z","total":42}],"percentageChange":null}}}'::jsonb
  ))::integer,
  1,
  'replayed Postiz collection is idempotent'
);
RESET SESSION AUTHORIZATION;
SELECT is(
  (SELECT count(*)::integer FROM selena_ingest_raw.raw_platform_snapshots WHERE channel_account_id = '75000000-0000-0000-0000-000000000003'),
  1,
  'replayed collection does not create another raw snapshot'
);
SELECT is(
  (SELECT count(*)::integer FROM selena_performance.metric_snapshots WHERE publication_attempt_id = '75000000-0000-0000-0000-000000000009'),
  1,
  'replayed collection does not create another normalized metric snapshot'
);

SELECT * FROM finish();
ROLLBACK;

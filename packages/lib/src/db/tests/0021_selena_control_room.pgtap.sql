-- Run only against a disposable database after 0021 is installed.
-- This file must never be executed against staging or production.
BEGIN;

SELECT plan(34);

SELECT has_schema('selena_registry', 'registry schema is installed');
SELECT has_schema('selena_release', 'release schema is installed');
SELECT has_schema('selena_audit', 'audit schema is installed');
SELECT has_schema('selena_ingest_raw', 'raw-ingestion schema is installed');
SELECT has_schema('selena_performance', 'performance schema is installed');
SELECT has_table('selena_release', 'release_intents', 'release-intent table is installed');
SELECT has_table('selena_release', 'outbox_events', 'transactional outbox table is installed');

INSERT INTO public."user" (id, name, email, email_verified, created_at, updated_at)
VALUES
  ('selena-pgtap-user-a', 'Selena pgTAP user A', 'selena-pgtap-a@example.invalid', true, now(), now()),
  ('selena-pgtap-user-b', 'Selena pgTAP user B', 'selena-pgtap-b@example.invalid', true, now(), now());
INSERT INTO public.organization (id, name, slug, created_at)
VALUES
  ('selena-pgtap-org-a', 'Selena pgTAP org A', 'selena-pgtap-org-a', now()),
  ('selena-pgtap-org-b', 'Selena pgTAP org B', 'selena-pgtap-org-b', now());
INSERT INTO public.member (id, organization_id, user_id, role, created_at)
VALUES
  ('selena-pgtap-member-a', 'selena-pgtap-org-a', 'selena-pgtap-user-a', 'owner', now()),
  ('selena-pgtap-member-b', 'selena-pgtap-org-b', 'selena-pgtap-user-b', 'owner', now());
INSERT INTO public.brands (id, name, website, organization_id)
VALUES
  ('selena-pgtap-brand-a', 'Selena pgTAP brand A', 'https://brand-a.example.invalid', 'selena-pgtap-org-a'),
  ('selena-pgtap-brand-b', 'Selena pgTAP brand B', 'https://brand-b.example.invalid', 'selena-pgtap-org-b');

CREATE ROLE selena_pgtap_web LOGIN IN ROLE selena_web_runtime;
CREATE ROLE selena_pgtap_gateway LOGIN IN ROLE selena_gateway_runtime;
CREATE ROLE selena_pgtap_trigger LOGIN IN ROLE selena_trigger_runtime;
CREATE ROLE selena_pgtap_ingestion LOGIN IN ROLE selena_ingestion_runtime;
CREATE ROLE selena_pgtap_analytics LOGIN IN ROLE selena_analytics_runtime;

SET ROLE selena_backup_restore;
INSERT INTO selena_registry.content_items (id, organization_id, brand_id, title, created_by)
VALUES
  ('10000000-0000-0000-0000-000000000001', 'selena-pgtap-org-a', 'selena-pgtap-brand-a', 'Brand A content', 'seed'),
  ('20000000-0000-0000-0000-000000000001', 'selena-pgtap-org-b', 'selena-pgtap-brand-b', 'Brand B content', 'seed');
INSERT INTO selena_registry.content_versions (
  id, organization_id, brand_id, content_id, version, body, cta_url, evidence, policy_version,
  content_hash, evidence_expires_at, created_by
) VALUES (
  '10000000-0000-0000-0000-000000000002',
  'selena-pgtap-org-a',
  'selena-pgtap-brand-a',
  '10000000-0000-0000-0000-000000000001',
  1,
  'Approved source body',
  'https://brand-a.example.invalid/cta',
  '[{"source":"https://brand-a.example.invalid/evidence"}]'::jsonb,
  'pgtap-v1',
  repeat('a', 64),
  now() + interval '1 hour',
  'seed'
);
INSERT INTO selena_registry.channel_accounts (
  id, organization_id, brand_id, platform, provider_account_ref, provider_integration_id, created_by
) VALUES (
  '10000000-0000-0000-0000-000000000003',
  'selena-pgtap-org-a',
  'selena-pgtap-brand-a',
  'LINKEDIN',
  'pgtap-page-a',
  'pgtap-integration-a',
  'seed'
);
INSERT INTO selena_registry.channel_accounts (
  id, organization_id, brand_id, platform, provider_account_ref, provider_integration_id, created_by
) VALUES (
  '10000000-0000-0000-0000-000000000009',
  'selena-pgtap-org-a',
  'selena-pgtap-brand-a',
  'LINKEDIN',
  'pgtap-page-other',
  'pgtap-integration-other',
  'seed'
);
INSERT INTO selena_registry.content_assets (
  id, organization_id, brand_id, content_version_id, storage_key, object_version_id,
  sha256, mime_type, size_bytes, scan_status, created_by
) VALUES (
  '10000000-0000-0000-0000-000000000006',
  'selena-pgtap-org-a',
  'selena-pgtap-brand-a',
  '10000000-0000-0000-0000-000000000002',
  'selena-originals/10000000-0000-0000-0000-000000000006',
  'pgtap-object-version-1',
  repeat('f', 64),
  'image/png',
  1024,
  'QUARANTINED',
  'seed'
);
INSERT INTO selena_registry.approvals (
  id, organization_id, brand_id, content_version_id, channel_account_id, decision,
  binding_hash, content_hash, asset_bundle_hash, policy_version, disclosure_hash, approver_id
) VALUES (
  '10000000-0000-0000-0000-000000000004',
  'selena-pgtap-org-a',
  'selena-pgtap-brand-a',
  '10000000-0000-0000-0000-000000000002',
  '10000000-0000-0000-0000-000000000003',
  'APPROVED',
  repeat('b', 64),
  repeat('a', 64),
  repeat('c', 64),
  'pgtap-v1',
  repeat('d', 64),
  'seed'
);
INSERT INTO selena_release.release_manifests (
  id, organization_id, brand_id, content_version_id, approval_id, channel_account_id,
  platform, manifest, manifest_hash, signature_algorithm, signing_key_version, signature, expires_at, created_by
) VALUES (
  '10000000-0000-0000-0000-000000000005',
  'selena-pgtap-org-a',
  'selena-pgtap-brand-a',
  '10000000-0000-0000-0000-000000000002',
  '10000000-0000-0000-0000-000000000004',
  '10000000-0000-0000-0000-000000000003',
  'LINKEDIN',
  '{}'::jsonb,
  repeat('e', 64),
  'Ed25519',
  'pgtap-key-v1',
  'pgtap-signature',
  now() + interval '1 hour',
  'service:gateway'
);
INSERT INTO selena_release.release_manifests (
  id, organization_id, brand_id, content_version_id, approval_id, channel_account_id,
  platform, manifest, manifest_hash, signature_algorithm, signing_key_version, signature, expires_at, created_by
) VALUES (
  '10000000-0000-0000-0000-000000000010',
  'selena-pgtap-org-a',
  'selena-pgtap-brand-a',
  '10000000-0000-0000-0000-000000000002',
  '10000000-0000-0000-0000-000000000004',
  '10000000-0000-0000-0000-000000000009',
  'LINKEDIN',
  '{}'::jsonb,
  repeat('0', 64),
  'Ed25519',
  'pgtap-key-v1',
  'pgtap-signature-other',
  now() + interval '1 hour',
  'service:gateway'
);
INSERT INTO selena_release.release_intents (
  id, organization_id, brand_id, content_version_id, approval_id, channel_account_id,
  platform, idempotency_key, correlation_id, created_by
) VALUES (
  '10000000-0000-0000-0000-000000000015',
  'selena-pgtap-org-a',
  'selena-pgtap-brand-a',
  '10000000-0000-0000-0000-000000000002',
  '10000000-0000-0000-0000-000000000004',
  '10000000-0000-0000-0000-000000000003',
  'LINKEDIN',
  'pgtap-release-intent-a',
  '10000000-0000-0000-0000-000000000016',
  'seed'
);
INSERT INTO selena_release.outbox_events (
  id, organization_id, brand_id, release_intent_id, event_type, event_version, idempotency_key
) VALUES (
  '10000000-0000-0000-0000-000000000017',
  'selena-pgtap-org-a',
  'selena-pgtap-brand-a',
  '10000000-0000-0000-0000-000000000015',
  'release.intent_queued',
  1,
  'pgtap-outbox-a'
);
SELECT throws_ok(
  $$INSERT INTO selena_release.release_intents (
      id, organization_id, brand_id, content_version_id, approval_id, channel_account_id,
      platform, idempotency_key, correlation_id, created_by
    ) VALUES (
      '10000000-0000-0000-0000-000000000018',
      'selena-pgtap-org-a', 'selena-pgtap-brand-a',
      '10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000004',
      '10000000-0000-0000-0000-000000000003', 'LINKEDIN', 'pgtap-release-intent-b',
      '10000000-0000-0000-0000-000000000019', 'seed'
    )$$,
  '23505',
  'duplicate key value violates unique constraint "release_intents_approval_account_unique"',
  'the same approved release queues one release intent'
);
SELECT throws_ok(
  $$INSERT INTO selena_release.outbox_events (
      id, organization_id, brand_id, release_intent_id, event_type, event_version, idempotency_key
    ) VALUES (
      '10000000-0000-0000-0000-000000000020',
      'selena-pgtap-org-a', 'selena-pgtap-brand-a', '10000000-0000-0000-0000-000000000015',
      'release.intent_queued', 1, 'pgtap-outbox-b'
    )$$,
  '23505',
  'duplicate key value violates unique constraint "release_outbox_events_intent_event_unique"',
  'one release intent creates one versioned outbox event'
);
INSERT INTO selena_release.dispatch_reservations (
  id, organization_id, brand_id, release_manifest_id, channel_account_id,
  platform, integration_id, allowlist_reference, idempotency_key, nonce
) VALUES (
  '10000000-0000-0000-0000-000000000007',
  'selena-pgtap-org-a',
  'selena-pgtap-brand-a',
  '10000000-0000-0000-0000-000000000005',
  '10000000-0000-0000-0000-000000000003',
  'LINKEDIN',
  'pgtap-integration-a',
  'pgtap-allowlist-a',
  'pgtap-idempotency-a',
  'pgtap-nonce-a'
);
SELECT throws_ok(
  $$INSERT INTO selena_release.dispatch_reservations (
      id, organization_id, brand_id, release_manifest_id, channel_account_id,
      platform, integration_id, allowlist_reference, idempotency_key, nonce
    ) VALUES (
      '10000000-0000-0000-0000-000000000008',
      'selena-pgtap-org-a',
      'selena-pgtap-brand-a',
      '10000000-0000-0000-0000-000000000005',
      '10000000-0000-0000-0000-000000000003',
      'LINKEDIN', 'pgtap-integration-a', 'pgtap-allowlist-a',
      'pgtap-idempotency-b', 'pgtap-nonce-a'
    )$$,
  '23505',
  'duplicate key value violates unique constraint "dispatch_reservations_nonce_unique"',
  'replayed nonce is rejected by the immutable dispatch reservation'
);
DO $$
DECLARE
  i integer;
BEGIN
  FOR i IN 1..10 LOOP
    BEGIN
      INSERT INTO selena_release.dispatch_reservations (
        organization_id, brand_id, release_manifest_id, channel_account_id,
        platform, integration_id, allowlist_reference, idempotency_key, nonce
      ) VALUES (
        'selena-pgtap-org-a', 'selena-pgtap-brand-a',
        '10000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000003',
        'LINKEDIN', 'pgtap-integration-a', 'pgtap-allowlist-a', 'pgtap-idempotency-a',
        'pgtap-repeated-nonce-' || i
      );
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
  END LOOP;
END;
$$;
SELECT is(
  (SELECT count(*) FROM selena_release.dispatch_reservations WHERE idempotency_key = 'pgtap-idempotency-a')::integer,
  1,
  'ten repeated release reservations preserve one idempotency record'
);
RESET ROLE;

SET SESSION AUTHORIZATION selena_pgtap_web;
SELECT is_empty(
  $$SELECT 1 FROM selena_registry.content_items$$,
  'missing transaction context denies web reads'
);
SELECT ok(
  NOT selena_registry.can_human_approve('selena-pgtap-org-a', 'selena-pgtap-brand-a'),
  'web role cannot approve without a verified transaction context'
);
SELECT throws_ok(
  $$SELECT selena_registry.set_request_context(
      'service:gateway',
      'selena-pgtap-org-a',
      'selena-pgtap-brand-a',
      'service',
      '10000000-0000-0000-0000-000000000009',
      'gateway',
      'service'
    )$$,
  'P0001',
  'Web runtime context must represent an interactive session',
  'service identity cannot impersonate a human approver'
);
SELECT throws_ok(
  $$SELECT selena_registry.set_request_context(
      'selena-pgtap-user-a',
      'selena-pgtap-org-a',
      'selena-pgtap-brand-b',
      'owner',
      '10000000-0000-0000-0000-000000000010',
      'web',
      'session'
    )$$,
  'P0001',
  'Selena membership or role context is invalid',
  'forged brand context is rejected'
);
SELECT throws_ok(
  $$SELECT selena_registry.set_request_context(
      'selena-pgtap-user-b',
      'selena-pgtap-org-a',
      'selena-pgtap-brand-a',
      'owner',
      '10000000-0000-0000-0000-000000000011',
      'web',
      'session'
    )$$,
  'P0001',
  'Selena membership or role context is invalid',
  'user without membership is rejected'
);
SELECT selena_registry.set_request_context(
  'selena-pgtap-user-a',
  'selena-pgtap-org-a',
  'selena-pgtap-brand-a',
  'owner',
  '10000000-0000-0000-0000-000000000012',
  'web',
  'session'
);
SELECT is(
  (SELECT count(*) FROM selena_registry.content_items)::integer,
  1,
  'user A cannot read brand B'
);
SELECT is_empty(
  $$UPDATE selena_registry.content_items
      SET title = 'forged brand B change'
    WHERE id = '20000000-0000-0000-0000-000000000001'
    RETURNING id$$,
  'user A cannot update brand B'
);
SELECT throws_ok(
  $$INSERT INTO selena_registry.content_items (
      organization_id, brand_id, title, created_by
    ) VALUES (
      'selena-pgtap-org-b', 'selena-pgtap-brand-b', 'forged brand B insert', 'selena-pgtap-user-a'
    )$$,
  '42501',
  'new row violates row-level security policy for table "content_items"',
  'user A cannot insert brand B'
);
SELECT throws_ok(
  $$DELETE FROM selena_registry.content_items
    WHERE id = '20000000-0000-0000-0000-000000000001'$$,
  '42501',
  'permission denied for table content_items',
  'user A cannot delete brand B'
);
SELECT throws_ok(
  $$INSERT INTO selena_registry.approvals (
      organization_id, brand_id, content_version_id, channel_account_id, decision,
      binding_hash, content_hash, asset_bundle_hash, policy_version, disclosure_hash, approver_id
    ) VALUES (
      'selena-pgtap-org-a', 'selena-pgtap-brand-a',
      '10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000003',
      'APPROVED', repeat('1', 64), repeat('a', 64), repeat('2', 64), 'pgtap-v1', repeat('3', 64),
      'selena-pgtap-user-a'
    )$$,
  '42501',
  'new row violates row-level security policy for table "approvals"',
  'quarantined malware scan blocks a direct approval insert'
);
RESET SESSION AUTHORIZATION;
SET ROLE selena_backup_restore;
SELECT throws_ok(
  $$UPDATE selena_registry.content_versions
      SET body = 'mutated'
    WHERE id = '10000000-0000-0000-0000-000000000002'$$,
  'P0001',
  'Selena record content_versions is append-only; create a compensating record instead',
  'append-only content version rejects update'
);
SELECT throws_ok(
  $$DELETE FROM selena_registry.content_versions
    WHERE id = '10000000-0000-0000-0000-000000000002'$$,
  'P0001',
  'Selena record content_versions is append-only; create a compensating record instead',
  'append-only content version rejects delete'
);
RESET ROLE;
SET SESSION AUTHORIZATION selena_pgtap_web;
COMMIT;
SELECT is(
  NULLIF(current_setting('app.selena_brand_id', true), ''),
  NULL,
  'SET LOCAL context does not leak after commit'
);
RESET SESSION AUTHORIZATION;

BEGIN;
SET ROLE selena_backup_restore;
UPDATE selena_registry.content_assets
  SET scan_status = 'CLEAN',
      scan_provider_event_ref = 'pgtap-scan-pass',
      verified_at = now(),
      rights_expires_at = now() - interval '1 minute',
      consent_expires_at = now() + interval '1 hour'
  WHERE id = '10000000-0000-0000-0000-000000000006';
RESET ROLE;
SET SESSION AUTHORIZATION selena_pgtap_web;
SELECT selena_registry.set_request_context(
  'selena-pgtap-user-a',
  'selena-pgtap-org-a',
  'selena-pgtap-brand-a',
  'owner',
  '10000000-0000-0000-0000-000000000014',
  'web',
  'session'
);
SELECT throws_ok(
  $$INSERT INTO selena_registry.approvals (
      organization_id, brand_id, content_version_id, channel_account_id, decision,
      binding_hash, content_hash, asset_bundle_hash, policy_version, disclosure_hash, approver_id
    ) VALUES (
      'selena-pgtap-org-a', 'selena-pgtap-brand-a',
      '10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000003',
      'APPROVED', repeat('4', 64), repeat('a', 64), repeat('5', 64), 'pgtap-v1', repeat('6', 64),
      'selena-pgtap-user-a'
    )$$,
  '42501',
  'new row violates row-level security policy for table "approvals"',
  'expired rights block a direct approval insert'
);
RESET SESSION AUTHORIZATION;

SET SESSION AUTHORIZATION selena_pgtap_gateway;
SELECT selena_registry.set_request_context(
  'service:gateway',
  'selena-pgtap-org-a',
  'selena-pgtap-brand-a',
  'service',
  '10000000-0000-0000-0000-000000000013',
  'gateway',
  'service',
  '10000000-0000-0000-0000-000000000005'
);
SELECT is(
  (SELECT count(*) FROM selena_release.release_manifests)::integer,
  1,
  'Gateway can read only the exact approved manifest in its context'
);
RESET SESSION AUTHORIZATION;

SELECT ok(
  NOT has_table_privilege('selena_gateway_runtime', 'selena_registry.approvals', 'INSERT')
  AND NOT has_table_privilege('selena_registry_worker_runtime', 'selena_registry.approvals', 'INSERT')
  AND NOT has_table_privilege('selena_trigger_runtime', 'selena_registry.approvals', 'INSERT')
  AND NOT has_table_privilege('selena_ingestion_runtime', 'selena_registry.approvals', 'INSERT')
  AND NOT has_table_privilege('selena_scanner_runtime', 'selena_registry.approvals', 'INSERT'),
  'service identities cannot insert human approvals'
);
SELECT ok(
  NOT has_table_privilege('selena_trigger_runtime', 'selena_registry.content_versions', 'SELECT')
  AND NOT has_table_privilege('selena_trigger_runtime', 'selena_release.outbox_events', 'SELECT')
  AND NOT has_table_privilege('selena_trigger_runtime', 'public.secrets', 'SELECT'),
  'Trigger cannot read content body or credentials'
);
SELECT ok(
  NOT has_table_privilege('selena_web_runtime', 'selena_registry.channel_accounts', 'INSERT'),
  'web runtime cannot allowlist a provider account'
);
SELECT ok(
  NOT has_table_privilege('selena_ingestion_runtime', 'selena_registry.content_items', 'UPDATE'),
  'ingestion cannot mutate the Content Registry'
);
SELECT ok(
  has_table_privilege('selena_analytics_runtime', 'selena_performance.metric_snapshots', 'SELECT')
  AND NOT has_table_privilege('selena_analytics_runtime', 'selena_performance.metric_snapshots', 'INSERT'),
  'analytics role is read-only'
);
SELECT ok(
  NOT has_schema_privilege('selena_web_runtime', 'selena_registry', 'CREATE')
  AND NOT has_schema_privilege('selena_gateway_runtime', 'selena_release', 'CREATE'),
  'runtime roles cannot perform DDL'
);
SELECT ok(
  (SELECT NOT rolcanlogin FROM pg_roles WHERE rolname = 'selena_migrator')
  AND NOT pg_has_role('selena_web_runtime', 'selena_migrator', 'member')
  AND NOT pg_has_role('selena_gateway_runtime', 'selena_migrator', 'member'),
  'migration role has no login and no runtime membership'
);
SELECT ok(
  NOT has_schema_privilege('anon', 'selena_registry', 'USAGE')
  AND NOT has_schema_privilege('authenticated', 'selena_release', 'USAGE'),
  'anon and authenticated lack private-schema access'
);

SELECT * FROM finish();
ROLLBACK;

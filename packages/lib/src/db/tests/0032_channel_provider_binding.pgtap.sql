-- Run only against a disposable database after migration 0032 is installed.
-- This file must never be executed against staging or production.
BEGIN;
SELECT plan(13);

INSERT INTO public."user" (id, name, email, email_verified, created_at, updated_at)
VALUES ('selena-binding-owner', 'Selena binding owner', 'selena-binding-owner@example.invalid', true, now(), now());
INSERT INTO public.organization (id, name, slug, created_at)
VALUES ('selena-binding-org', 'Selena binding org', 'selena-binding-org', now());
INSERT INTO public.member (id, organization_id, user_id, role, created_at)
VALUES ('selena-binding-member', 'selena-binding-org', 'selena-binding-owner', 'owner', now());
INSERT INTO public.brands (id, name, website, organization_id)
VALUES
  ('selena-binding-brand', 'Selena binding brand', 'https://binding.example.invalid', 'selena-binding-org'),
  ('selena-binding-other', 'Selena other brand', 'https://other.example.invalid', 'selena-binding-org');
CREATE ROLE selena_pgtap_gateway_0032 LOGIN IN ROLE selena_gateway_runtime;

SET ROLE selena_backup_restore;
INSERT INTO selena_registry.content_items (id, organization_id, brand_id, title, created_by)
VALUES ('74000000-0000-0000-0000-000000000001', 'selena-binding-org', 'selena-binding-brand', 'Binding material', 'seed');
INSERT INTO selena_registry.content_versions (
  id, organization_id, brand_id, content_id, version, body, cta_url, evidence, disclosure, policy_version, content_hash, created_by
) VALUES (
  '74000000-0000-0000-0000-000000000002', 'selena-binding-org', 'selena-binding-brand', '74000000-0000-0000-0000-000000000001',
  1, 'A reviewed binding material', 'https://binding.example.invalid/material', '[]'::jsonb, '{}', 'binding-v1', repeat('a', 64), 'seed'
);
INSERT INTO selena_registry.channel_accounts (
  id, organization_id, brand_id, platform, provider_account_ref, provider_integration_id, status, allowlisted, created_by
) VALUES (
  '74000000-0000-0000-0000-000000000003', 'selena-binding-org', 'selena-binding-brand', 'linkedin_page',
  'Selena Systems LinkedIn Page', 'postiz-linkedin-page-only', 'ACTIVE', true, 'seed'
);
INSERT INTO selena_registry.approvals (
  id, organization_id, brand_id, content_version_id, channel_account_id, decision,
  binding_hash, content_hash, asset_bundle_hash, policy_version, disclosure_hash, approver_id, expires_at, created_at
) VALUES
  (
    '74000000-0000-0000-0000-000000000004', 'selena-binding-org', 'selena-binding-brand', '74000000-0000-0000-0000-000000000002',
    '74000000-0000-0000-0000-000000000003', 'APPROVED', repeat('b', 64), repeat('a', 64), repeat('c', 64), 'binding-v1', repeat('d', 64),
    'selena-binding-owner', now() + interval '1 hour', now()
  ),
  (
    '74000000-0000-0000-0000-000000000005', 'selena-binding-org', 'selena-binding-brand', '74000000-0000-0000-0000-000000000002',
    '74000000-0000-0000-0000-000000000003', 'APPROVED', repeat('b', 64), repeat('a', 64), repeat('c', 64), 'binding-v1', repeat('d', 64),
    'selena-binding-owner', now() + interval '1 hour', now() - interval '1 minute'
  );
INSERT INTO selena_release.release_intents (
  id, organization_id, brand_id, content_version_id, approval_id, channel_account_id, platform, idempotency_key, correlation_id, created_by
) VALUES (
  '74000000-0000-0000-0000-000000000006', 'selena-binding-org', 'selena-binding-brand', '74000000-0000-0000-0000-000000000002',
  '74000000-0000-0000-0000-000000000004', '74000000-0000-0000-0000-000000000003', 'linkedin_page', 'binding-intent',
  '74000000-0000-0000-0000-000000000007', 'seed'
);
INSERT INTO selena_registry.channel_provider_bindings (
  id, organization_id, brand_id, channel_account_id, provider, environment, active, created_by
) VALUES (
  '74000000-0000-0000-0000-000000000008', 'selena-binding-org', 'selena-binding-brand',
  '74000000-0000-0000-0000-000000000003', 'postiz', 'STAGING', true, 'seed'
);
RESET ROLE;

SELECT throws_ok(
  $$INSERT INTO selena_registry.channel_provider_bindings
    (organization_id, brand_id, channel_account_id, provider, environment, active, created_by)
    VALUES ('selena-binding-org', 'selena-binding-brand', '74000000-0000-0000-0000-000000000003',
      'blotato', 'STAGING', true, 'seed')$$,
  '23505',
  NULL,
  'one channel and environment accepts exactly one active provider'
);
SELECT lives_ok(
  $$INSERT INTO selena_registry.channel_provider_bindings
    (organization_id, brand_id, channel_account_id, provider, environment, active, created_by)
    VALUES ('selena-binding-org', 'selena-binding-brand', '74000000-0000-0000-0000-000000000003',
      'blotato', 'PRODUCTION', true, 'seed')$$,
  'the same channel may use a different provider in another environment'
);
SELECT lives_ok(
  $$INSERT INTO selena_registry.channel_provider_bindings
    (organization_id, brand_id, channel_account_id, provider, environment, active, created_by)
    VALUES ('selena-binding-org', 'selena-binding-brand', '74000000-0000-0000-0000-000000000003',
      'blotato', 'STAGING', false, 'seed')$$,
  'an inactive replacement provider may be staged next to the active one'
);
SELECT throws_ok(
  $$INSERT INTO selena_registry.channel_provider_bindings
    (organization_id, brand_id, channel_account_id, provider, environment, active, created_by)
    VALUES ('selena-binding-org', 'selena-binding-other', '74000000-0000-0000-0000-000000000003',
      'blotato', 'DRY_RUN', true, 'seed')$$,
  '23503',
  NULL,
  'a binding cannot claim a channel account from another brand'
);

SELECT ok(
  NOT has_table_privilege('selena_gateway_runtime', 'selena_audit.audit_events', 'INSERT'),
  'Gateway cannot append an audit entry outside the dispatch authorization boundary'
);
SELECT ok(
  NOT has_table_privilege('selena_web_runtime', 'selena_registry.channel_provider_bindings', 'INSERT')
  AND NOT has_table_privilege('selena_gateway_runtime', 'selena_registry.channel_provider_bindings', 'UPDATE'),
  'provider bindings are not writable by a runtime login'
);

SET SESSION AUTHORIZATION selena_pgtap_gateway_0032;
SELECT selena_registry.set_request_context(
  'service:gateway', 'selena-binding-org', 'selena-binding-brand', 'service',
  '74000000-0000-0000-0000-000000000009', 'gateway', 'service', NULL
);
CREATE TEMP TABLE binding_expected_package AS
SELECT selena_release.build_gateway_release_package('74000000-0000-0000-0000-000000000006') AS package;
GRANT SELECT ON binding_expected_package TO selena_backup_restore;
RESET SESSION AUTHORIZATION;

SET ROLE selena_backup_restore;
INSERT INTO selena_release.release_manifests (
  id, organization_id, brand_id, content_version_id, approval_id, channel_account_id, platform,
  manifest, manifest_hash, signature_algorithm, signing_key_version, signature, expires_at, created_by
) SELECT
  '74000000-0000-0000-0000-000000000010', 'selena-binding-org', 'selena-binding-brand',
  '74000000-0000-0000-0000-000000000002', '74000000-0000-0000-0000-000000000004', '74000000-0000-0000-0000-000000000003',
  'linkedin_page', package, repeat('e', 64), 'Ed25519', 'pgtap', 'pgtap-signature', now() + interval '1 hour', 'service:gateway'
FROM binding_expected_package;
INSERT INTO selena_release.release_manifests (
  id, organization_id, brand_id, content_version_id, approval_id, channel_account_id, platform,
  manifest, manifest_hash, signature_algorithm, signing_key_version, signature, expires_at, created_by
) SELECT
  '74000000-0000-0000-0000-000000000011', 'selena-binding-org', 'selena-binding-brand',
  '74000000-0000-0000-0000-000000000002', '74000000-0000-0000-0000-000000000005', '74000000-0000-0000-0000-000000000003',
  'linkedin_page', package, repeat('f', 64), 'Ed25519', 'pgtap', 'pgtap-signature', now() - interval '1 hour', 'service:gateway'
FROM binding_expected_package;
RESET ROLE;

SET SESSION AUTHORIZATION selena_pgtap_gateway_0032;
SELECT selena_registry.set_request_context(
  'service:gateway', 'selena-binding-org', 'selena-binding-brand', 'service',
  '74000000-0000-0000-0000-000000000012', 'gateway', 'service', '74000000-0000-0000-0000-000000000099'
);
SELECT throws_ok(
  $$SELECT * FROM selena_release.authorize_provider_dispatch(
    '74000000-0000-0000-0000-000000000010', 'STAGING', 'binding-dispatch'
  )$$,
  'P0001',
  'Only the Release Gateway may authorize a dispatch for its exact manifest',
  'a forged transaction context cannot authorize another manifest'
);

SELECT selena_registry.set_request_context(
  'service:gateway', 'selena-binding-org', 'selena-binding-brand', 'service',
  '74000000-0000-0000-0000-000000000013', 'gateway', 'service', '74000000-0000-0000-0000-000000000010'
);
CREATE TEMP TABLE binding_authorization AS
SELECT * FROM selena_release.authorize_provider_dispatch(
  '74000000-0000-0000-0000-000000000010', 'STAGING', 'binding-dispatch'
);
RESET SESSION AUTHORIZATION;

SELECT is(
  (SELECT provider FROM binding_authorization),
  'postiz',
  'authorization resolves the single active provider bound to this channel and environment'
);
SELECT is(
  (SELECT content_hash || ':' || manifest_hash || ':' || signature_algorithm FROM binding_authorization),
  repeat('a', 64) || ':' || repeat('e', 64) || ':Ed25519',
  'authorization returns the content hash, manifest hash and signature the release was bound to'
);
SELECT is(
  (
    SELECT count(*)::integer FROM selena_audit.audit_events AS event
    WHERE event.action = 'release.dispatch_authorized'
      AND event.aggregate_id = '74000000-0000-0000-0000-000000000010'
      AND event.id = (SELECT audit_event_id FROM binding_authorization)
      AND event.metadata ->> 'provider' = 'postiz'
      AND event.metadata ->> 'idempotencyKey' = 'binding-dispatch'
  ),
  1,
  'authorization appends the dispatch decision to the audit trail'
);

INSERT INTO selena_registry.kill_switches (organization_id, scope, active, reason, changed_by)
VALUES ('selena-binding-org', 'GLOBAL', true, 'pgtap release freeze', 'selena-binding-owner');
SET SESSION AUTHORIZATION selena_pgtap_gateway_0032;
SELECT selena_registry.set_request_context(
  'service:gateway', 'selena-binding-org', 'selena-binding-brand', 'service',
  '74000000-0000-0000-0000-000000000014', 'gateway', 'service', '74000000-0000-0000-0000-000000000010'
);
SELECT throws_ok(
  $$SELECT * FROM selena_release.authorize_provider_dispatch(
    '74000000-0000-0000-0000-000000000010', 'STAGING', 'binding-dispatch'
  )$$,
  'P0001',
  'Kill switch is active',
  'an active kill switch blocks the dispatch authorization'
);
RESET SESSION AUTHORIZATION;
DELETE FROM selena_registry.kill_switches WHERE organization_id = 'selena-binding-org';

SET SESSION AUTHORIZATION selena_pgtap_gateway_0032;
SELECT selena_registry.set_request_context(
  'service:gateway', 'selena-binding-org', 'selena-binding-brand', 'service',
  '74000000-0000-0000-0000-000000000015', 'gateway', 'service', '74000000-0000-0000-0000-000000000010'
);
SELECT throws_ok(
  $$SELECT * FROM selena_release.authorize_provider_dispatch(
    '74000000-0000-0000-0000-000000000010', 'DRY_RUN', 'binding-dispatch'
  )$$,
  'P0001',
  'No active provider is bound to this channel and environment',
  'an environment without an active binding cannot be dispatched to'
);
SELECT selena_registry.set_request_context(
  'service:gateway', 'selena-binding-org', 'selena-binding-brand', 'service',
  '74000000-0000-0000-0000-000000000016', 'gateway', 'service', '74000000-0000-0000-0000-000000000011'
);
SELECT throws_ok(
  $$SELECT * FROM selena_release.authorize_provider_dispatch(
    '74000000-0000-0000-0000-000000000011', 'STAGING', 'binding-dispatch'
  )$$,
  'P0001',
  'Release manifest is unavailable or expired',
  'an expired signed manifest cannot authorize a dispatch'
);
RESET SESSION AUTHORIZATION;

SELECT * FROM finish();
ROLLBACK;

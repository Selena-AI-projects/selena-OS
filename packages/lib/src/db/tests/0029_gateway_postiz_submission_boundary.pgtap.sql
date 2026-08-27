-- Run only against a disposable database after migration 0029 is installed.
-- This file must never be executed against staging or production.
BEGIN;
SELECT plan(10);

INSERT INTO public."user" (id, name, email, email_verified, created_at, updated_at)
VALUES ('selena-postiz-owner', 'Selena Postiz owner', 'selena-postiz-owner@example.invalid', true, now(), now());
INSERT INTO public.organization (id, name, slug, created_at)
VALUES ('selena-postiz-org', 'Selena Postiz org', 'selena-postiz-org', now());
INSERT INTO public.member (id, organization_id, user_id, role, created_at)
VALUES ('selena-postiz-member', 'selena-postiz-org', 'selena-postiz-owner', 'owner', now());
INSERT INTO public.brands (id, name, website, organization_id)
VALUES ('selena-postiz-brand', 'Selena Postiz brand', 'https://postiz.example.invalid', 'selena-postiz-org');
CREATE ROLE selena_pgtap_gateway_0029 LOGIN IN ROLE selena_gateway_runtime;

SET ROLE selena_backup_restore;
INSERT INTO selena_registry.content_items (id, organization_id, brand_id, title, created_by)
VALUES ('73000000-0000-0000-0000-000000000001', 'selena-postiz-org', 'selena-postiz-brand', 'Postiz material', 'seed');
INSERT INTO selena_registry.content_versions (
  id, organization_id, brand_id, content_id, version, body, cta_url, evidence, disclosure, policy_version, content_hash, created_by
) VALUES (
  '73000000-0000-0000-0000-000000000002', 'selena-postiz-org', 'selena-postiz-brand', '73000000-0000-0000-0000-000000000001',
  1, 'A reviewed Postiz material', 'https://postiz.example.invalid/material', '[]'::jsonb, '{}', 'postiz-v1', repeat('a', 64), 'seed'
);
INSERT INTO selena_registry.channel_accounts (
  id, organization_id, brand_id, platform, provider_account_ref, provider_integration_id, status, allowlisted, created_by
) VALUES (
  '73000000-0000-0000-0000-000000000003', 'selena-postiz-org', 'selena-postiz-brand', 'linkedin_page',
  'Selena Systems LinkedIn Page', 'postiz-linkedin-page-only', 'ACTIVE', true, 'seed'
);
INSERT INTO selena_registry.approvals (
  id, organization_id, brand_id, content_version_id, channel_account_id, decision,
  binding_hash, content_hash, asset_bundle_hash, policy_version, disclosure_hash, approver_id, expires_at
) VALUES (
  '73000000-0000-0000-0000-000000000004', 'selena-postiz-org', 'selena-postiz-brand', '73000000-0000-0000-0000-000000000002',
  '73000000-0000-0000-0000-000000000003', 'APPROVED', repeat('b', 64), repeat('a', 64), repeat('c', 64), 'postiz-v1', repeat('d', 64),
  'selena-postiz-owner', now() + interval '1 hour'
);
INSERT INTO selena_release.release_intents (
  id, organization_id, brand_id, content_version_id, approval_id, channel_account_id, platform, idempotency_key, correlation_id, created_by
) VALUES (
  '73000000-0000-0000-0000-000000000005', 'selena-postiz-org', 'selena-postiz-brand', '73000000-0000-0000-0000-000000000002',
  '73000000-0000-0000-0000-000000000004', '73000000-0000-0000-0000-000000000003', 'linkedin_page', 'postiz-intent',
  '73000000-0000-0000-0000-000000000006', 'seed'
);
RESET ROLE;

SELECT ok(
  NOT has_table_privilege('selena_gateway_runtime', 'selena_release.dispatch_reservations', 'INSERT')
  AND NOT has_table_privilege('selena_gateway_runtime', 'selena_release.publication_attempts', 'INSERT'),
  'Gateway has no direct path to forge a Postiz reservation or provider outcome'
);

SET SESSION AUTHORIZATION selena_pgtap_gateway_0029;
SELECT selena_registry.set_request_context(
  'service:gateway', 'selena-postiz-org', 'selena-postiz-brand', 'service',
  '73000000-0000-0000-0000-000000000007', 'gateway', 'service', NULL
);
CREATE TEMP TABLE postiz_expected_package AS
SELECT selena_release.build_gateway_release_package('73000000-0000-0000-0000-000000000005') AS package;
GRANT SELECT ON postiz_expected_package TO selena_backup_restore;
RESET SESSION AUTHORIZATION;

SET ROLE selena_backup_restore;
INSERT INTO selena_release.release_manifests (
  id, organization_id, brand_id, content_version_id, approval_id, channel_account_id, platform,
  manifest, manifest_hash, signature_algorithm, signing_key_version, signature, expires_at, created_by
) SELECT
  '73000000-0000-0000-0000-000000000008', 'selena-postiz-org', 'selena-postiz-brand',
  '73000000-0000-0000-0000-000000000002', '73000000-0000-0000-0000-000000000004', '73000000-0000-0000-0000-000000000003', 'linkedin_page',
  package, repeat('e', 64), 'Ed25519', 'pgtap', 'pgtap-signature', now() + interval '1 hour', 'service:gateway'
FROM postiz_expected_package;
RESET ROLE;

SET SESSION AUTHORIZATION selena_pgtap_gateway_0029;
SELECT selena_registry.set_request_context(
  'service:gateway', 'selena-postiz-org', 'selena-postiz-brand', 'service',
  '73000000-0000-0000-0000-000000000009', 'gateway', 'service', '73000000-0000-0000-0000-000000000099'
);
SELECT throws_ok(
  $$SELECT * FROM selena_release.prepare_postiz_submission('73000000-0000-0000-0000-000000000008', 'postiz-attempt', 'nonce-one')$$,
  'P0001',
  'Only the Release Gateway may prepare a Postiz submission for its exact manifest',
  'Gateway cannot prepare a different manifest through a forged transaction context'
);
SELECT selena_registry.set_request_context(
  'service:gateway', 'selena-postiz-org', 'selena-postiz-brand', 'service',
  '73000000-0000-0000-0000-000000000010', 'gateway', 'service', '73000000-0000-0000-0000-000000000008'
);
CREATE TEMP TABLE prepared_postiz_submission AS
SELECT * FROM selena_release.prepare_postiz_submission(
  '73000000-0000-0000-0000-000000000008', 'postiz-attempt', 'nonce-one'
);
SELECT is((SELECT count(*) FROM prepared_postiz_submission)::integer, 1, 'Gateway prepares one immutable Postiz reservation');
RESET SESSION AUTHORIZATION;
SELECT is(
  (SELECT status::text FROM selena_release.publication_attempts WHERE reservation_id = (SELECT reservation_id FROM prepared_postiz_submission)),
  'RESERVED',
  'reservation exists before any provider network call'
);

SET SESSION AUTHORIZATION selena_pgtap_gateway_0029;
SELECT selena_registry.set_request_context(
  'service:gateway', 'selena-postiz-org', 'selena-postiz-brand', 'service',
  '73000000-0000-0000-0000-000000000011', 'gateway', 'service', '73000000-0000-0000-0000-000000000008'
);
SELECT is(
  (SELECT should_submit FROM selena_release.prepare_postiz_submission(
    '73000000-0000-0000-0000-000000000008', 'postiz-attempt', 'different-nonce'
  )),
  false,
  'replay of one release never submits a second Postiz request'
);
RESET SESSION AUTHORIZATION;
SELECT is(
  (SELECT count(*) FROM selena_release.dispatch_reservations WHERE idempotency_key = 'postiz-attempt')::integer,
  1,
  'one idempotency key creates exactly one reservation'
);

SET SESSION AUTHORIZATION selena_pgtap_gateway_0029;
SELECT selena_registry.set_request_context(
  'service:gateway', 'selena-postiz-org', 'selena-postiz-brand', 'service',
  '73000000-0000-0000-0000-000000000012', 'gateway', 'service', '73000000-0000-0000-0000-000000000008'
);
SELECT lives_ok(
  $$SELECT selena_release.record_postiz_submission_outcome(
    (SELECT reservation_id FROM prepared_postiz_submission), 'AMBIGUOUS', NULL, 'Postiz timeout after request handoff'
  )$$,
  'Postiz timeout records an ambiguous result rather than retrying blindly'
);
RESET SESSION AUTHORIZATION;
SELECT is(
  (SELECT status::text FROM selena_release.release_intents WHERE id = '73000000-0000-0000-0000-000000000005'),
  'UNKNOWN',
  'ambiguous Postiz response requires reconciliation'
);
SELECT is(
  (SELECT count(*) FROM selena_audit.incidents WHERE code = 'POSTIZ_AMBIGUOUS_RESULT')::integer,
  1,
  'ambiguous provider outcome creates an incident'
);

SET SESSION AUTHORIZATION selena_pgtap_gateway_0029;
SELECT selena_registry.set_request_context(
  'service:gateway', 'selena-postiz-org', 'selena-postiz-brand', 'service',
  '73000000-0000-0000-0000-000000000013', 'gateway', 'service', '73000000-0000-0000-0000-000000000008'
);
SELECT throws_ok(
  $$SELECT selena_release.record_postiz_submission_outcome(
    (SELECT reservation_id FROM prepared_postiz_submission), 'ACCEPTED', 'post-forbidden-retry', NULL
  )$$,
  'P0001',
  'Postiz reservation already has a terminal or ambiguous outcome',
  'ambiguous result blocks a blind provider retry'
);

SELECT * FROM finish();
ROLLBACK;

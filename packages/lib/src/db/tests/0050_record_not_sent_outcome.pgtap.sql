-- Run only against a disposable database after migration 0050 is installed.
-- This file must never be executed against staging or production.
--
-- A provider refusal (publishing disabled, wrong environment, kill switch) is
-- reported as NOT_SENT. It must be recordable as a terminal outcome: the attempt
-- is NOT_SENT / PUBLISH_REFUSED, the intent is BLOCKED, and no incident is raised.
BEGIN;
SELECT plan(5);

INSERT INTO public."user" (id, name, email, email_verified, created_at, updated_at)
VALUES ('selena-ns-owner', 'Selena NotSent owner', 'selena-ns-owner@example.invalid', true, now(), now());
INSERT INTO public.organization (id, name, slug, created_at)
VALUES ('selena-ns-org', 'Selena NotSent org', 'selena-ns-org', now());
INSERT INTO public.member (id, organization_id, user_id, role, created_at)
VALUES ('selena-ns-member', 'selena-ns-org', 'selena-ns-owner', 'owner', now());
INSERT INTO public.brands (id, name, website, organization_id)
VALUES ('selena-ns-brand', 'Selena NotSent brand', 'https://ns.example.invalid', 'selena-ns-org');
CREATE ROLE selena_pgtap_gateway_0050 LOGIN IN ROLE selena_gateway_runtime;

SET ROLE selena_backup_restore;
INSERT INTO selena_registry.content_items (id, organization_id, brand_id, title, created_by)
VALUES ('75000000-0000-0000-0000-000000000001', 'selena-ns-org', 'selena-ns-brand', 'NotSent material', 'seed');
INSERT INTO selena_registry.content_versions (
  id, organization_id, brand_id, content_id, version, body, cta_url, evidence, disclosure, policy_version, content_hash, created_by
) VALUES (
  '75000000-0000-0000-0000-000000000002', 'selena-ns-org', 'selena-ns-brand', '75000000-0000-0000-0000-000000000001',
  1, 'A reviewed NotSent material', 'https://ns.example.invalid/material', '[]'::jsonb, '{}', 'ns-v1', repeat('a', 64), 'seed'
);
INSERT INTO selena_registry.channel_accounts (
  id, organization_id, brand_id, platform, provider_account_ref, provider_integration_id, status, allowlisted, created_by
) VALUES (
  '75000000-0000-0000-0000-000000000003', 'selena-ns-org', 'selena-ns-brand', 'linkedin_page',
  'Selena Systems LinkedIn Page', 'ns-linkedin-page-only', 'ACTIVE', true, 'seed'
);
INSERT INTO selena_registry.approvals (
  id, organization_id, brand_id, content_version_id, channel_account_id, decision,
  binding_hash, content_hash, asset_bundle_hash, policy_version, disclosure_hash, approver_id, expires_at
) VALUES (
  '75000000-0000-0000-0000-000000000004', 'selena-ns-org', 'selena-ns-brand', '75000000-0000-0000-0000-000000000002',
  '75000000-0000-0000-0000-000000000003', 'APPROVED', repeat('b', 64), repeat('a', 64), repeat('c', 64), 'ns-v1', repeat('d', 64),
  'selena-ns-owner', now() + interval '1 hour'
);
INSERT INTO selena_release.release_intents (
  id, organization_id, brand_id, content_version_id, approval_id, channel_account_id, platform, idempotency_key, correlation_id, created_by
) VALUES (
  '75000000-0000-0000-0000-000000000005', 'selena-ns-org', 'selena-ns-brand', '75000000-0000-0000-0000-000000000002',
  '75000000-0000-0000-0000-000000000004', '75000000-0000-0000-0000-000000000003', 'linkedin_page', 'ns-intent',
  '75000000-0000-0000-0000-000000000006', 'seed'
);
RESET ROLE;

SET SESSION AUTHORIZATION selena_pgtap_gateway_0050;
SELECT selena_registry.set_request_context(
  'service:gateway', 'selena-ns-org', 'selena-ns-brand', 'service',
  '75000000-0000-0000-0000-000000000007', 'gateway', 'service', NULL
);
CREATE TEMP TABLE ns_expected_package AS
SELECT selena_release.build_gateway_release_package('75000000-0000-0000-0000-000000000005') AS package;
GRANT SELECT ON ns_expected_package TO selena_backup_restore;
RESET SESSION AUTHORIZATION;

SET ROLE selena_backup_restore;
INSERT INTO selena_release.release_manifests (
  id, organization_id, brand_id, content_version_id, approval_id, channel_account_id, platform,
  manifest, manifest_hash, signature_algorithm, signing_key_version, signature, expires_at, created_by
) SELECT
  '75000000-0000-0000-0000-000000000008', 'selena-ns-org', 'selena-ns-brand',
  '75000000-0000-0000-0000-000000000002', '75000000-0000-0000-0000-000000000004', '75000000-0000-0000-0000-000000000003', 'linkedin_page',
  package, repeat('e', 64), 'Ed25519', 'pgtap', 'pgtap-signature', now() + interval '1 hour', 'service:gateway'
FROM ns_expected_package;
RESET ROLE;

SET SESSION AUTHORIZATION selena_pgtap_gateway_0050;
SELECT selena_registry.set_request_context(
  'service:gateway', 'selena-ns-org', 'selena-ns-brand', 'service',
  '75000000-0000-0000-0000-000000000010', 'gateway', 'service', '75000000-0000-0000-0000-000000000008'
);
CREATE TEMP TABLE ns_reservation AS
SELECT * FROM selena_release.prepare_postiz_submission(
  '75000000-0000-0000-0000-000000000008', 'ns-attempt', 'ns-nonce'
);

-- The provider refused to shape the release: record NOT_SENT.
SELECT lives_ok(
  $$SELECT selena_release.record_postiz_submission_outcome(
    (SELECT reservation_id FROM ns_reservation), 'NOT_SENT', NULL, 'Publishing refused: publish flag off'
  )$$,
  'a provider refusal records a terminal NOT_SENT outcome'
);
RESET SESSION AUTHORIZATION;

SELECT is(
  (SELECT status::text FROM selena_release.publication_attempts
   WHERE reservation_id = (SELECT reservation_id FROM ns_reservation)
   ORDER BY attempt_number DESC, transition_number DESC LIMIT 1),
  'NOT_SENT',
  'the latest attempt is recorded as NOT_SENT'
);
SELECT is(
  (SELECT error_classification FROM selena_release.publication_attempts
   WHERE reservation_id = (SELECT reservation_id FROM ns_reservation)
   ORDER BY attempt_number DESC, transition_number DESC LIMIT 1),
  'PUBLISH_REFUSED',
  'the NOT_SENT attempt is classified as a publish refusal'
);
SELECT is(
  (SELECT status::text FROM selena_release.release_intents WHERE id = '75000000-0000-0000-0000-000000000005'),
  'BLOCKED',
  'a release that was not sent leaves the intent blocked, not failed'
);
SELECT is(
  (SELECT count(*)::int FROM selena_audit.incidents
   WHERE brand_id = 'selena-ns-brand'),
  0,
  'an expected refusal raises no incident'
);

SELECT * FROM finish();
ROLLBACK;

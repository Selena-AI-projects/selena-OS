-- Run only against a disposable database after migration 0030 is installed.
-- This file must never be executed against staging or production.
BEGIN;
SELECT plan(9);

INSERT INTO public."user" (id, name, email, email_verified, created_at, updated_at)
VALUES ('selena-cancel-owner', 'Selena cancellation owner', 'selena-cancel-owner@example.invalid', true, now(), now());
INSERT INTO public.organization (id, name, slug, created_at)
VALUES ('selena-cancel-org', 'Selena cancellation org', 'selena-cancel-org', now());
INSERT INTO public.member (id, organization_id, user_id, role, created_at)
VALUES ('selena-cancel-member', 'selena-cancel-org', 'selena-cancel-owner', 'owner', now());
INSERT INTO public.brands (id, name, website, organization_id)
VALUES ('selena-cancel-brand', 'Selena cancellation brand', 'https://cancel.example.invalid', 'selena-cancel-org');
CREATE ROLE selena_pgtap_cancel_owner LOGIN IN ROLE selena_web_runtime;
CREATE ROLE selena_pgtap_cancel_worker LOGIN IN ROLE selena_registry_worker_runtime;

SET ROLE selena_backup_restore;
INSERT INTO selena_registry.content_items (id, organization_id, brand_id, title, created_by)
VALUES
  ('74000000-0000-0000-0000-000000000001', 'selena-cancel-org', 'selena-cancel-brand', 'Queued material', 'seed'),
  ('74000000-0000-0000-0000-000000000010', 'selena-cancel-org', 'selena-cancel-brand', 'Scheduled material', 'seed');
INSERT INTO selena_registry.content_versions (
  id, organization_id, brand_id, content_id, version, body, cta_url, evidence, disclosure, policy_version, content_hash, created_by
) VALUES
  ('74000000-0000-0000-0000-000000000002', 'selena-cancel-org', 'selena-cancel-brand', '74000000-0000-0000-0000-000000000001', 1, 'Queued', 'https://cancel.example.invalid', '[]', '{}', 'cancel-v1', repeat('a', 64), 'seed'),
  ('74000000-0000-0000-0000-000000000011', 'selena-cancel-org', 'selena-cancel-brand', '74000000-0000-0000-0000-000000000010', 1, 'Scheduled', 'https://cancel.example.invalid', '[]', '{}', 'cancel-v1', repeat('b', 64), 'seed');
INSERT INTO selena_registry.channel_accounts (id, organization_id, brand_id, platform, provider_account_ref, provider_integration_id, status, allowlisted, created_by)
VALUES
  ('74000000-0000-0000-0000-000000000003', 'selena-cancel-org', 'selena-cancel-brand', 'linkedin_page', 'Queued Page', 'cancel-page-one', 'ACTIVE', true, 'seed'),
  ('74000000-0000-0000-0000-000000000012', 'selena-cancel-org', 'selena-cancel-brand', 'linkedin_page', 'Scheduled Page', 'cancel-page-two', 'ACTIVE', true, 'seed');
INSERT INTO selena_registry.approvals (id, organization_id, brand_id, content_version_id, channel_account_id, decision, binding_hash, content_hash, asset_bundle_hash, policy_version, disclosure_hash, approver_id, expires_at)
VALUES
  ('74000000-0000-0000-0000-000000000004', 'selena-cancel-org', 'selena-cancel-brand', '74000000-0000-0000-0000-000000000002', '74000000-0000-0000-0000-000000000003', 'APPROVED', repeat('c', 64), repeat('a', 64), repeat('d', 64), 'cancel-v1', repeat('e', 64), 'selena-cancel-owner', now() + interval '1 hour'),
  ('74000000-0000-0000-0000-000000000013', 'selena-cancel-org', 'selena-cancel-brand', '74000000-0000-0000-0000-000000000011', '74000000-0000-0000-0000-000000000012', 'APPROVED', repeat('f', 64), repeat('b', 64), repeat('0', 64), 'cancel-v1', repeat('1', 64), 'selena-cancel-owner', now() + interval '1 hour');
INSERT INTO selena_release.release_intents (id, organization_id, brand_id, content_version_id, approval_id, channel_account_id, platform, idempotency_key, correlation_id, status, created_by)
VALUES
  ('74000000-0000-0000-0000-000000000005', 'selena-cancel-org', 'selena-cancel-brand', '74000000-0000-0000-0000-000000000002', '74000000-0000-0000-0000-000000000004', '74000000-0000-0000-0000-000000000003', 'linkedin_page', 'cancel-queued', '74000000-0000-0000-0000-000000000006', 'QUEUED', 'seed'),
  ('74000000-0000-0000-0000-000000000014', 'selena-cancel-org', 'selena-cancel-brand', '74000000-0000-0000-0000-000000000011', '74000000-0000-0000-0000-000000000013', '74000000-0000-0000-0000-000000000012', 'linkedin_page', 'cancel-scheduled', '74000000-0000-0000-0000-000000000015', 'SUCCEEDED', 'seed');
INSERT INTO selena_release.outbox_events (id, organization_id, brand_id, release_intent_id, event_type, event_version, idempotency_key)
VALUES
  ('74000000-0000-0000-0000-000000000007', 'selena-cancel-org', 'selena-cancel-brand', '74000000-0000-0000-0000-000000000005', 'release.intent_queued', 1, 'cancel-outbox'),
  ('74000000-0000-0000-0000-000000000020', 'selena-cancel-org', 'selena-cancel-brand', '74000000-0000-0000-0000-000000000014', 'release.intent_queued', 1, 'cancel-scheduled-outbox');
RESET ROLE;
SET ROLE selena_schema_owner;
INSERT INTO selena_release.workflow_dispatches (id, organization_id, brand_id, outbox_event_id, release_intent_id, correlation_id, idempotency_key, status)
VALUES
  ('74000000-0000-0000-0000-000000000008', 'selena-cancel-org', 'selena-cancel-brand', '74000000-0000-0000-0000-000000000007', '74000000-0000-0000-0000-000000000005', '74000000-0000-0000-0000-000000000006', 'cancel-outbox', 'RUNNING'),
  ('74000000-0000-0000-0000-000000000016', 'selena-cancel-org', 'selena-cancel-brand', '74000000-0000-0000-0000-000000000020', '74000000-0000-0000-0000-000000000014', '74000000-0000-0000-0000-000000000015', 'cancel-scheduled', 'RUNNING');
RESET ROLE;

SELECT ok(
  NOT has_table_privilege('selena_web_runtime', 'selena_release.release_intents', 'UPDATE'),
  'web cannot change a release state without the owner-only cancellation function'
);
SET SESSION AUTHORIZATION selena_pgtap_cancel_worker;
SELECT selena_registry.set_request_context(
  'service:registry-worker', 'selena-cancel-org', 'selena-cancel-brand', 'service',
  '74000000-0000-0000-0000-000000000017', 'registry_worker', 'service', NULL
);
SELECT throws_ok(
  $$SELECT selena_release.request_release_cancellation('74000000-0000-0000-0000-000000000005', 'forged service cancellation')$$,
  '42501',
  'permission denied for function request_release_cancellation',
  'service identity cannot perform human cancellation'
);
RESET SESSION AUTHORIZATION;

SET SESSION AUTHORIZATION selena_pgtap_cancel_owner;
SELECT selena_registry.set_request_context(
  'selena-cancel-owner', 'selena-cancel-org', 'selena-cancel-brand', 'owner',
  '74000000-0000-0000-0000-000000000018', 'web', 'session', NULL
);
SELECT is(
  selena_release.request_release_cancellation('74000000-0000-0000-0000-000000000005', 'Owner cancelled before dispatch'),
  'CANCELLED',
  'queued release is cancelled before any provider call'
);
RESET SESSION AUTHORIZATION;
SELECT is((SELECT status::text FROM selena_release.release_intents WHERE id = '74000000-0000-0000-0000-000000000005'), 'CANCELLED', 'queued release status is cancelled');
SELECT is((SELECT status::text FROM selena_release.outbox_events WHERE id = '74000000-0000-0000-0000-000000000007'), 'CANCELLED', 'queued outbox event is cancelled');
SELECT is((SELECT status FROM selena_release.workflow_dispatches WHERE id = '74000000-0000-0000-0000-000000000008'), 'CANCELLED', 'queued workflow is cancelled');

SET SESSION AUTHORIZATION selena_pgtap_cancel_owner;
SELECT selena_registry.set_request_context(
  'selena-cancel-owner', 'selena-cancel-org', 'selena-cancel-brand', 'owner',
  '74000000-0000-0000-0000-000000000019', 'web', 'session', NULL
);
SELECT is(
  selena_release.request_release_cancellation('74000000-0000-0000-0000-000000000014', 'Owner requested provider cancellation'),
  'CANCEL_REQUESTED',
  'provider-accepted release is held for reconciliation instead of falsely marked cancelled'
);
RESET SESSION AUTHORIZATION;
SELECT is((SELECT status::text FROM selena_release.release_intents WHERE id = '74000000-0000-0000-0000-000000000014'), 'CANCEL_REQUESTED', 'provider cancellation request remains explicit');
SELECT is((SELECT status FROM selena_release.workflow_dispatches WHERE id = '74000000-0000-0000-0000-000000000016'), 'RECONCILIATION_REQUIRED', 'provider cancellation requires a reconciliation workflow');

SELECT * FROM finish();
ROLLBACK;

-- Run only against a disposable database after migration 0028 is installed.
-- This file must never be executed against staging or production.
BEGIN;
SELECT plan(10);

INSERT INTO public."user" (id, name, email, email_verified, created_at, updated_at)
VALUES ('selena-trigger-owner', 'Selena Trigger owner', 'selena-trigger-owner@example.invalid', true, now(), now());
INSERT INTO public.organization (id, name, slug, created_at)
VALUES ('selena-trigger-org', 'Selena Trigger org', 'selena-trigger-org', now());
INSERT INTO public.member (id, organization_id, user_id, role, created_at)
VALUES ('selena-trigger-member', 'selena-trigger-org', 'selena-trigger-owner', 'owner', now());
INSERT INTO public.brands (id, name, website, organization_id)
VALUES ('selena-trigger-brand', 'Selena Trigger brand', 'https://trigger.example.invalid', 'selena-trigger-org');
CREATE ROLE selena_pgtap_registry_worker LOGIN IN ROLE selena_registry_worker_runtime;
CREATE ROLE selena_pgtap_trigger_0028 LOGIN IN ROLE selena_trigger_runtime;

SET ROLE selena_backup_restore;
INSERT INTO selena_registry.content_items (id, organization_id, brand_id, title, created_by)
VALUES
  ('72000000-0000-0000-0000-000000000001', 'selena-trigger-org', 'selena-trigger-brand', 'First Trigger material', 'seed'),
  ('72000000-0000-0000-0000-000000000010', 'selena-trigger-org', 'selena-trigger-brand', 'Second Trigger material', 'seed');
INSERT INTO selena_registry.content_versions (
  id, organization_id, brand_id, content_id, version, body, cta_url, evidence, disclosure, policy_version, content_hash, created_by
) VALUES
  ('72000000-0000-0000-0000-000000000002', 'selena-trigger-org', 'selena-trigger-brand', '72000000-0000-0000-0000-000000000001', 1, 'First', 'https://trigger.example.invalid/one', '[]'::jsonb, '{}'::jsonb, 'trigger-v1', repeat('a', 64), 'seed'),
  ('72000000-0000-0000-0000-000000000011', 'selena-trigger-org', 'selena-trigger-brand', '72000000-0000-0000-0000-000000000010', 1, 'Second', 'https://trigger.example.invalid/two', '[]'::jsonb, '{}'::jsonb, 'trigger-v1', repeat('b', 64), 'seed');
INSERT INTO selena_registry.channel_accounts (
  id, organization_id, brand_id, platform, provider_account_ref, provider_integration_id, status, allowlisted, created_by
) VALUES
  ('72000000-0000-0000-0000-000000000003', 'selena-trigger-org', 'selena-trigger-brand', 'linkedin_page', 'Trigger Page One', 'trigger-integration-one', 'ACTIVE', true, 'seed'),
  ('72000000-0000-0000-0000-000000000012', 'selena-trigger-org', 'selena-trigger-brand', 'linkedin_page', 'Trigger Page Two', 'trigger-integration-two', 'ACTIVE', true, 'seed');
INSERT INTO selena_registry.approvals (
  id, organization_id, brand_id, content_version_id, channel_account_id, decision,
  binding_hash, content_hash, asset_bundle_hash, policy_version, disclosure_hash, approver_id, expires_at
) VALUES
  ('72000000-0000-0000-0000-000000000004', 'selena-trigger-org', 'selena-trigger-brand', '72000000-0000-0000-0000-000000000002', '72000000-0000-0000-0000-000000000003', 'APPROVED', repeat('c', 64), repeat('a', 64), repeat('d', 64), 'trigger-v1', repeat('e', 64), 'selena-trigger-owner', now() + interval '1 hour'),
  ('72000000-0000-0000-0000-000000000013', 'selena-trigger-org', 'selena-trigger-brand', '72000000-0000-0000-0000-000000000011', '72000000-0000-0000-0000-000000000012', 'APPROVED', repeat('f', 64), repeat('b', 64), repeat('0', 64), 'trigger-v1', repeat('1', 64), 'selena-trigger-owner', now() + interval '1 hour');
INSERT INTO selena_release.release_intents (
  id, organization_id, brand_id, content_version_id, approval_id, channel_account_id, platform, idempotency_key, correlation_id, created_by
) VALUES
  ('72000000-0000-0000-0000-000000000005', 'selena-trigger-org', 'selena-trigger-brand', '72000000-0000-0000-0000-000000000002', '72000000-0000-0000-0000-000000000004', '72000000-0000-0000-0000-000000000003', 'linkedin_page', 'trigger-intent-one', '72000000-0000-0000-0000-000000000006', 'seed'),
  ('72000000-0000-0000-0000-000000000014', 'selena-trigger-org', 'selena-trigger-brand', '72000000-0000-0000-0000-000000000011', '72000000-0000-0000-0000-000000000013', '72000000-0000-0000-0000-000000000012', 'linkedin_page', 'trigger-intent-two', '72000000-0000-0000-0000-000000000015', 'seed');
INSERT INTO selena_release.outbox_events (
  id, organization_id, brand_id, release_intent_id, event_type, event_version, idempotency_key, max_attempts, available_at
) VALUES
  ('72000000-0000-0000-0000-000000000007', 'selena-trigger-org', 'selena-trigger-brand', '72000000-0000-0000-0000-000000000005', 'release.intent_queued', 1, 'trigger-outbox-one', 5, now() - interval '1 minute'),
  ('72000000-0000-0000-0000-000000000016', 'selena-trigger-org', 'selena-trigger-brand', '72000000-0000-0000-0000-000000000014', 'release.intent_queued', 1, 'trigger-outbox-two', 1, now() + interval '1 hour');

RESET ROLE;
SELECT ok(
  NOT has_table_privilege('selena_trigger_runtime', 'selena_release.outbox_events', 'SELECT')
  AND NOT has_table_privilege('selena_trigger_runtime', 'selena_release.workflow_dispatches', 'SELECT'),
  'Trigger has no direct private release database access'
);
SET SESSION AUTHORIZATION selena_pgtap_registry_worker;
SELECT throws_ok(
  $$SELECT * FROM selena_release.claim_next_trigger_outbox(300)$$,
  'P0001',
  'Only the registry worker may claim a Trigger workflow outbox event',
  'worker cannot claim without a server-owned request context'
);
SELECT selena_registry.set_request_context(
  'service:registry-worker', '__outbox_queue__', '__outbox_queue__', 'service',
  '72000000-0000-0000-0000-000000000008', 'registry_worker', 'service'
);
CREATE TEMP TABLE claimed_workflow AS SELECT * FROM selena_release.claim_next_trigger_outbox(300);
SELECT is((SELECT count(*) FROM claimed_workflow)::integer, 1, 'worker claims one due workflow event under a lease');
RESET SESSION AUTHORIZATION;
SELECT is(
  (SELECT status::text FROM selena_release.outbox_events WHERE id = (SELECT outbox_event_id FROM claimed_workflow)),
  'LEASED',
  'claim atomically leases the outbox event'
);
SET SESSION AUTHORIZATION selena_pgtap_registry_worker;
SELECT selena_registry.set_request_context(
  'service:registry-worker', '__outbox_queue__', '__outbox_queue__', 'service',
  '72000000-0000-0000-0000-000000000009', 'registry_worker', 'service'
);
SELECT lives_ok(
  $$SELECT * FROM selena_release.record_trigger_workflow_dispatch(
      (SELECT outbox_event_id FROM claimed_workflow), (SELECT lease_owner FROM claimed_workflow), 'run_trigger_test_one'
    )$$,
  'worker records one Trigger run and completes the outbox lease'
);
RESET SESSION AUTHORIZATION;
SELECT is(
  (SELECT status::text FROM selena_release.outbox_events WHERE id = (SELECT outbox_event_id FROM claimed_workflow)),
  'DELIVERED',
  'successful Trigger handoff marks the outbox event delivered'
);
SELECT is(
  (SELECT count(*) FROM selena_release.workflow_dispatches WHERE outbox_event_id = (SELECT outbox_event_id FROM claimed_workflow))::integer,
  1,
  'outbox idempotency creates exactly one workflow dispatch record'
);
SET ROLE selena_backup_restore;
UPDATE selena_release.outbox_events
SET available_at = now() - interval '30 minutes'
WHERE id = '72000000-0000-0000-0000-000000000016';
RESET ROLE;
SET SESSION AUTHORIZATION selena_pgtap_registry_worker;
SELECT selena_registry.set_request_context(
  'service:registry-worker', '__outbox_queue__', '__outbox_queue__', 'service',
  '72000000-0000-0000-0000-000000000017', 'registry_worker', 'service'
);
CREATE TEMP TABLE claimed_dead_letter AS SELECT * FROM selena_release.claim_next_trigger_outbox(300);
SELECT lives_ok(
  $$SELECT selena_release.retry_or_dead_letter_trigger_outbox(
      (SELECT outbox_event_id FROM claimed_dead_letter), (SELECT lease_owner FROM claimed_dead_letter), 'Trigger unavailable'
    )$$,
  'worker records failed handoff without blind external retry'
);
RESET SESSION AUTHORIZATION;
SELECT is(
  (SELECT status::text FROM selena_release.outbox_events WHERE id = (SELECT outbox_event_id FROM claimed_dead_letter)),
  'DEAD_LETTER',
  'max-attempt workflow event enters dead letter'
);
SELECT is(
  (SELECT count(*) FROM selena_audit.incidents WHERE code = 'TRIGGER_OUTBOX_DEAD_LETTER')::integer,
  1,
  'dead-letter workflow handoff creates an incident'
);

SELECT * FROM finish();
ROLLBACK;

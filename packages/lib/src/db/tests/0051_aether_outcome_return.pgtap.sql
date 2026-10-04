-- Run only against a disposable database after migration 0051 is installed.
-- This file must never be executed against staging or production.
BEGIN;
SELECT plan(14);

INSERT INTO public.organization (id, name, slug, created_at)
VALUES ('selena-pgtap-aor-org', 'Return org', 'selena-pgtap-aor-org', now());
INSERT INTO public.brands (id, name, website, organization_id)
VALUES ('selena-pgtap-aor-brand', 'Return brand', 'https://aor.example.invalid', 'selena-pgtap-aor-org');
INSERT INTO selena_registry.channel_accounts (id, organization_id, brand_id, platform, provider_account_ref, created_by)
VALUES ('aa000000-0000-4000-8000-000000000001', 'selena-pgtap-aor-org', 'selena-pgtap-aor-brand', 'x', 'aor-acct', 'seed');

-- Aether-origin material that will be PUBLISHED.
INSERT INTO selena_registry.content_items (id, organization_id, brand_id, title, created_by, kind, external_source, external_ref, brief_ref)
VALUES ('c1000000-0000-4000-8000-000000000001', 'selena-pgtap-aor-org', 'selena-pgtap-aor-brand', 'pub', 'seed', 'ARTICLE', 'aether',
  '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444');
INSERT INTO selena_registry.content_versions (id, organization_id, brand_id, content_id, version, body, cta_url, disclosure, policy_version, content_hash, created_by)
VALUES ('c2000000-0000-4000-8000-000000000001', 'selena-pgtap-aor-org', 'selena-pgtap-aor-brand', 'c1000000-0000-4000-8000-000000000001', 1, 'b', 'https://cta',
  '{"origin":{"system":"aether","project_id":"11111111-1111-4111-8111-111111111111","trace_id":"22222222-2222-4222-8222-222222222222"}}'::jsonb,
  'pol-1', 'h1', 'seed');

-- Aether-origin material the owner will REJECT.
INSERT INTO selena_registry.content_items (id, organization_id, brand_id, title, created_by, kind, external_source, external_ref, brief_ref)
VALUES ('c3000000-0000-4000-8000-000000000001', 'selena-pgtap-aor-org', 'selena-pgtap-aor-brand', 'rej', 'seed', 'SOCIAL_ADAPTATION', 'aether',
  '55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666');
INSERT INTO selena_registry.content_versions (id, organization_id, brand_id, content_id, version, body, cta_url, disclosure, policy_version, content_hash, created_by)
VALUES ('c4000000-0000-4000-8000-000000000001', 'selena-pgtap-aor-org', 'selena-pgtap-aor-brand', 'c3000000-0000-4000-8000-000000000001', 1, 'b', 'https://cta',
  '{"origin":{"system":"aether","project_id":"11111111-1111-4111-8111-111111111111","trace_id":"22222222-2222-4222-8222-222222222222"}}'::jsonb,
  'pol-1', 'h2', 'seed');

-- Control-Room-authored material (no Aether origin): must never be returned.
INSERT INTO selena_registry.content_items (id, organization_id, brand_id, title, created_by)
VALUES ('c5000000-0000-4000-8000-000000000001', 'selena-pgtap-aor-org', 'selena-pgtap-aor-brand', 'native', 'seed');
INSERT INTO selena_registry.content_versions (id, organization_id, brand_id, content_id, version, body, cta_url, policy_version, content_hash, created_by)
VALUES ('c6000000-0000-4000-8000-000000000001', 'selena-pgtap-aor-org', 'selena-pgtap-aor-brand', 'c5000000-0000-4000-8000-000000000001', 1, 'b', 'https://cta', 'pol-1', 'h3', 'seed');

INSERT INTO selena_registry.approvals (id, organization_id, brand_id, content_version_id, channel_account_id, decision, binding_hash, content_hash, asset_bundle_hash, policy_version, disclosure_hash, approver_id)
VALUES
  ('ab000000-0000-4000-8000-000000000001', 'selena-pgtap-aor-org', 'selena-pgtap-aor-brand', 'c2000000-0000-4000-8000-000000000001', 'aa000000-0000-4000-8000-000000000001', 'APPROVED', 'bh', 'ch', 'abh', 'pol-1', 'dh', 'owner'),
  ('ab000000-0000-4000-8000-000000000003', 'selena-pgtap-aor-org', 'selena-pgtap-aor-brand', 'c6000000-0000-4000-8000-000000000001', 'aa000000-0000-4000-8000-000000000001', 'APPROVED', 'bh', 'ch', 'abh', 'pol-1', 'dh', 'owner');

INSERT INTO selena_release.release_manifests (id, organization_id, brand_id, content_version_id, approval_id, channel_account_id, platform, manifest, manifest_hash, signature_algorithm, signing_key_version, signature, expires_at, created_by)
VALUES
  ('ba000000-0000-4000-8000-000000000001', 'selena-pgtap-aor-org', 'selena-pgtap-aor-brand', 'c2000000-0000-4000-8000-000000000001', 'ab000000-0000-4000-8000-000000000001', 'aa000000-0000-4000-8000-000000000001', 'x', '{}'::jsonb, 'mh', 'ed25519', 'v1', 'sig', now() + interval '1 day', 'seed'),
  ('ba000000-0000-4000-8000-000000000003', 'selena-pgtap-aor-org', 'selena-pgtap-aor-brand', 'c6000000-0000-4000-8000-000000000001', 'ab000000-0000-4000-8000-000000000003', 'aa000000-0000-4000-8000-000000000001', 'x', '{}'::jsonb, 'mh', 'ed25519', 'v1', 'sig', now() + interval '1 day', 'seed');

INSERT INTO selena_release.dispatch_reservations (id, organization_id, brand_id, release_manifest_id, channel_account_id, platform, integration_id, allowlist_reference, idempotency_key, nonce)
VALUES
  ('bb000000-0000-4000-8000-000000000001', 'selena-pgtap-aor-org', 'selena-pgtap-aor-brand', 'ba000000-0000-4000-8000-000000000001', 'aa000000-0000-4000-8000-000000000001', 'x', 'intg', 'allow', 'idem-1', 'nonce-1'),
  ('bb000000-0000-4000-8000-000000000003', 'selena-pgtap-aor-org', 'selena-pgtap-aor-brand', 'ba000000-0000-4000-8000-000000000003', 'aa000000-0000-4000-8000-000000000001', 'x', 'intg', 'allow', 'idem-3', 'nonce-3');

-- ACCEPTED on the Aether material → one PUBLISHED outcome, fully correlated.
INSERT INTO selena_release.publication_attempts (organization_id, brand_id, reservation_id, release_manifest_id, channel_account_id, platform, integration_id, allowlist_reference, manifest_hash, attempt_number, transition_number, status, provider_reference_id)
VALUES ('selena-pgtap-aor-org', 'selena-pgtap-aor-brand', 'bb000000-0000-4000-8000-000000000001', 'ba000000-0000-4000-8000-000000000001', 'aa000000-0000-4000-8000-000000000001', 'x', 'intg', 'allow', 'mh', 1, 1, 'ACCEPTED', 'https://x.example/post/1');

SELECT is(
  (SELECT count(*)::int FROM selena_registry.aether_outcome_outbox WHERE content_version_id = 'c2000000-0000-4000-8000-000000000001'),
  1, 'an accepted attempt enqueues exactly one outcome');
SELECT is(
  (SELECT outcome FROM selena_registry.aether_outcome_outbox WHERE content_version_id = 'c2000000-0000-4000-8000-000000000001'),
  'PUBLISHED', 'the outcome is PUBLISHED');
SELECT is(
  (SELECT aggregate_id::text FROM selena_registry.aether_outcome_outbox WHERE content_version_id = 'c2000000-0000-4000-8000-000000000001'),
  '33333333-3333-4333-8333-333333333333', 'correlated to the material aggregate');
SELECT is(
  (SELECT task_id::text FROM selena_registry.aether_outcome_outbox WHERE content_version_id = 'c2000000-0000-4000-8000-000000000001'),
  '44444444-4444-4444-8444-444444444444', 'correlated to the originating task');
SELECT is(
  (SELECT reference FROM selena_registry.aether_outcome_outbox WHERE content_version_id = 'c2000000-0000-4000-8000-000000000001'),
  'https://x.example/post/1', 'the provider reference is carried on PUBLISHED');
SELECT is(
  (SELECT material_version FROM selena_registry.aether_outcome_outbox WHERE content_version_id = 'c2000000-0000-4000-8000-000000000001'),
  1, 'the material version is carried');

-- CONFIRMED on the same version must not enqueue a second PUBLISHED.
INSERT INTO selena_release.publication_attempts (organization_id, brand_id, reservation_id, release_manifest_id, channel_account_id, platform, integration_id, allowlist_reference, manifest_hash, attempt_number, transition_number, status, provider_reference_id)
VALUES ('selena-pgtap-aor-org', 'selena-pgtap-aor-brand', 'bb000000-0000-4000-8000-000000000001', 'ba000000-0000-4000-8000-000000000001', 'aa000000-0000-4000-8000-000000000001', 'x', 'intg', 'allow', 'mh', 1, 2, 'CONFIRMED', 'https://x.example/post/1');
SELECT is(
  (SELECT count(*)::int FROM selena_registry.aether_outcome_outbox WHERE content_version_id = 'c2000000-0000-4000-8000-000000000001'),
  1, 'a confirmed transition deduplicates to one outcome');

-- AMBIGUOUS is not an author-terminal verdict.
INSERT INTO selena_release.publication_attempts (organization_id, brand_id, reservation_id, release_manifest_id, channel_account_id, platform, integration_id, allowlist_reference, manifest_hash, attempt_number, transition_number, status)
VALUES ('selena-pgtap-aor-org', 'selena-pgtap-aor-brand', 'bb000000-0000-4000-8000-000000000001', 'ba000000-0000-4000-8000-000000000001', 'aa000000-0000-4000-8000-000000000001', 'x', 'intg', 'allow', 'mh', 2, 1, 'AMBIGUOUS');
SELECT is(
  (SELECT count(*)::int FROM selena_registry.aether_outcome_outbox WHERE content_version_id = 'c2000000-0000-4000-8000-000000000001'),
  1, 'an ambiguous attempt enqueues nothing');

-- A native (Control Room) publication must never be returned.
INSERT INTO selena_release.publication_attempts (organization_id, brand_id, reservation_id, release_manifest_id, channel_account_id, platform, integration_id, allowlist_reference, manifest_hash, attempt_number, transition_number, status, provider_reference_id)
VALUES ('selena-pgtap-aor-org', 'selena-pgtap-aor-brand', 'bb000000-0000-4000-8000-000000000003', 'ba000000-0000-4000-8000-000000000003', 'aa000000-0000-4000-8000-000000000001', 'x', 'intg', 'allow', 'mh', 1, 1, 'ACCEPTED', 'https://x.example/native/1');
SELECT is(
  (SELECT count(*)::int FROM selena_registry.aether_outcome_outbox WHERE content_version_id = 'c6000000-0000-4000-8000-000000000001'),
  0, 'content without an Aether origin is never returned');

-- An owner rejection returns once, without leaking the reason.
INSERT INTO selena_registry.approvals (id, organization_id, brand_id, content_version_id, channel_account_id, decision, binding_hash, content_hash, asset_bundle_hash, policy_version, disclosure_hash, approver_id, reason)
VALUES ('ab000000-0000-4000-8000-000000000002', 'selena-pgtap-aor-org', 'selena-pgtap-aor-brand', 'c4000000-0000-4000-8000-000000000001', 'aa000000-0000-4000-8000-000000000001', 'REJECTED', 'bh', 'ch', 'abh', 'pol-1', 'dh', 'owner', 'off brand voice');
SELECT is(
  (SELECT count(*)::int FROM selena_registry.aether_outcome_outbox WHERE content_version_id = 'c4000000-0000-4000-8000-000000000001' AND outcome = 'REJECTED'),
  1, 'an owner rejection enqueues one REJECTED outcome');
SELECT ok(
  (SELECT detail FROM selena_registry.aether_outcome_outbox WHERE content_version_id = 'c4000000-0000-4000-8000-000000000001') IS NULL,
  'the rejection reason is not carried in the returned detail');

SELECT ok(
  NOT has_table_privilege('selena_registry_worker_runtime', 'selena_registry.aether_outcome_outbox', 'SELECT')
  AND NOT has_table_privilege('selena_registry_worker_runtime', 'selena_registry.aether_outcome_outbox', 'INSERT')
  AND NOT has_table_privilege('selena_registry_worker_runtime', 'selena_registry.aether_outcome_outbox', 'UPDATE')
  AND NOT has_table_privilege('selena_registry_worker_runtime', 'selena_registry.aether_outcome_outbox', 'DELETE'),
  'the registry worker reaches the outbox through functions only');

-- The worker drains through the functions under its own identity.
CREATE ROLE selena_pgtap_aor_worker LOGIN IN ROLE selena_registry_worker_runtime;
SET SESSION AUTHORIZATION selena_pgtap_aor_worker;

SELECT throws_ok(
  $$SELECT selena_registry.claim_next_aether_outcome(300)$$,
  'Only the registry worker may claim Aether outcome events',
  'claiming is refused without the worker service identity');

SELECT set_config('app.selena_service_identity', 'registry_worker', true);
SELECT set_config('app.selena_actor_id', 'service:registry-worker', true);
SELECT set_config('app.selena_auth_type', 'service', true);

DO $$
DECLARE v_id uuid; v_owner text;
BEGIN
  SELECT id, lease_owner INTO v_id, v_owner FROM selena_registry.claim_next_aether_outcome(300);
  PERFORM selena_registry.record_aether_outcome_delivered(v_id, v_owner);
END $$;

RESET SESSION AUTHORIZATION;
SELECT is(
  (SELECT status FROM selena_registry.aether_outcome_outbox WHERE content_version_id = 'c2000000-0000-4000-8000-000000000001'),
  'DELIVERED', 'the worker claims the oldest outcome and marks it delivered');

SELECT * FROM finish();
ROLLBACK;

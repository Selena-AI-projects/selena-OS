-- Run only against a disposable database after migration 0053 is installed.
-- This file must never be executed against staging or production.
--
-- An accepted site release waits on the owner's merge. The gateway settles it
-- as published (the author gets the page), closed (the author learns the owner
-- declined it) or superseded (silent: the newer version reports instead).
BEGIN;
SELECT plan(17);

INSERT INTO public."user" (id, name, email, email_verified, created_at, updated_at)
VALUES ('selena-sp-owner', 'Site publication owner', 'selena-sp-owner@example.invalid', true, now(), now());
INSERT INTO public.organization (id, name, slug, created_at)
VALUES ('selena-sp-org', 'Site publication org', 'selena-sp-org', now());
INSERT INTO public.member (id, organization_id, user_id, role, created_at)
VALUES ('selena-sp-member', 'selena-sp-org', 'selena-sp-owner', 'owner', now());
INSERT INTO public.brands (id, name, website, organization_id)
VALUES ('selena-sp-brand', 'Site publication brand', 'https://sp.example.invalid', 'selena-sp-org');
CREATE ROLE selena_pgtap_gateway_0053 LOGIN IN ROLE selena_gateway_runtime;
CREATE ROLE selena_pgtap_web_0053 LOGIN IN ROLE selena_web_runtime;

INSERT INTO selena_registry.channel_accounts (id, organization_id, brand_id, platform, provider_account_ref, provider_integration_id, status, allowlisted, created_by)
VALUES ('d3000000-0000-4000-8000-000000000053', 'selena-sp-org', 'selena-sp-brand', 'website_lab', 'Selena Lab',
  'Selena-AI-projects/SELENA-AI-COMPANY', 'ACTIVE', true, 'seed');
INSERT INTO selena_registry.content_items (id, organization_id, brand_id, title, created_by, kind, external_source, external_ref, brief_ref)
VALUES ('d1000000-0000-4000-8000-000000000053', 'selena-sp-org', 'selena-sp-brand', 'article', 'seed', 'ARTICLE', 'aether',
  '33333333-3333-4333-8333-333333333353', '44444444-4444-4444-8444-444444444453');

-- Versions 1–3, each approved for the site, released and accepted: 1 will be
-- merged, 2 closed, 3 superseded. Version 4 is already confirmed.
INSERT INTO selena_registry.content_versions (id, organization_id, brand_id, content_id, version, body, cta_url, disclosure, policy_version, content_hash, created_by)
SELECT ('d2000000-0000-4000-8000-00000000005' || n)::uuid, 'selena-sp-org', 'selena-sp-brand', 'd1000000-0000-4000-8000-000000000053',
  n::int, 'body ' || n, 'https://cta',
  '{"origin":{"system":"aether","project_id":"11111111-1111-4111-8111-111111111153","trace_id":"22222222-2222-4222-8222-222222222253"}}'::jsonb,
  'pol-1', 'h' || n, 'seed'
FROM (VALUES ('1'), ('2'), ('3'), ('4')) AS versions(n);
INSERT INTO selena_registry.approvals (id, organization_id, brand_id, content_version_id, channel_account_id, decision, binding_hash, content_hash, asset_bundle_hash, policy_version, disclosure_hash, approver_id)
SELECT ('d4000000-0000-4000-8000-00000000005' || n)::uuid, 'selena-sp-org', 'selena-sp-brand',
  ('d2000000-0000-4000-8000-00000000005' || n)::uuid, 'd3000000-0000-4000-8000-000000000053',
  'APPROVED', 'bh', 'ch', 'abh', 'pol-1', 'dh', 'selena-sp-owner'
FROM (VALUES ('1'), ('2'), ('3'), ('4')) AS versions(n);
INSERT INTO selena_release.release_intents (id, organization_id, brand_id, content_version_id, approval_id, channel_account_id, platform, idempotency_key, correlation_id, created_by, status)
SELECT ('d5000000-0000-4000-8000-00000000005' || n)::uuid, 'selena-sp-org', 'selena-sp-brand',
  ('d2000000-0000-4000-8000-00000000005' || n)::uuid, ('d4000000-0000-4000-8000-00000000005' || n)::uuid,
  'd3000000-0000-4000-8000-000000000053', 'website_lab', 'sp-intent-' || n, gen_random_uuid(), 'seed', 'SUCCEEDED'
FROM (VALUES ('1'), ('2'), ('3'), ('4')) AS versions(n);
INSERT INTO selena_release.release_manifests (id, organization_id, brand_id, content_version_id, approval_id, channel_account_id, platform, manifest, manifest_hash, signature_algorithm, signing_key_version, signature, expires_at, created_by)
SELECT ('d6000000-0000-4000-8000-00000000005' || n)::uuid, 'selena-sp-org', 'selena-sp-brand',
  ('d2000000-0000-4000-8000-00000000005' || n)::uuid, ('d4000000-0000-4000-8000-00000000005' || n)::uuid,
  'd3000000-0000-4000-8000-000000000053', 'website_lab',
  jsonb_build_object('releaseIntentId', 'd5000000-0000-4000-8000-00000000005' || n), 'mh' || n,
  'ed25519', 'v1', 'sig', now() + interval '1 day', 'seed'
FROM (VALUES ('1'), ('2'), ('3'), ('4')) AS versions(n);
INSERT INTO selena_release.dispatch_reservations (id, organization_id, brand_id, release_manifest_id, channel_account_id, platform, integration_id, allowlist_reference, idempotency_key, nonce)
SELECT ('d7000000-0000-4000-8000-00000000005' || n)::uuid, 'selena-sp-org', 'selena-sp-brand',
  ('d6000000-0000-4000-8000-00000000005' || n)::uuid, 'd3000000-0000-4000-8000-000000000053', 'website_lab',
  'Selena-AI-projects/SELENA-AI-COMPANY', 'allow', 'sp-idem-' || n, 'sp-nonce-' || n
FROM (VALUES ('1'), ('2'), ('3'), ('4')) AS versions(n);
INSERT INTO selena_release.publication_attempts (organization_id, brand_id, reservation_id, release_manifest_id, channel_account_id, platform, integration_id, allowlist_reference, manifest_hash, attempt_number, transition_number, status, provider_reference_id)
SELECT 'selena-sp-org', 'selena-sp-brand', ('d7000000-0000-4000-8000-00000000005' || n)::uuid,
  ('d6000000-0000-4000-8000-00000000005' || n)::uuid, 'd3000000-0000-4000-8000-000000000053', 'website_lab',
  'Selena-AI-projects/SELENA-AI-COMPANY', 'allow', 'mh' || n, 1, t::int, status::selena_release.publication_attempt_status,
  'https://github.com/Selena-AI-projects/SELENA-AI-COMPANY/pull/20' || n
FROM (VALUES ('1', '1', 'ACCEPTED'), ('2', '1', 'ACCEPTED'), ('3', '1', 'ACCEPTED'), ('4', '1', 'ACCEPTED'), ('4', '2', 'CONFIRMED'))
  AS attempts(n, t, status);

-- Who may watch.
SET SESSION AUTHORIZATION selena_pgtap_web_0053;
SELECT selena_registry.set_request_context('selena-sp-owner', 'selena-sp-org', 'selena-sp-brand',
  'owner', 'eeeeeeee-0000-4000-8000-000000000053', 'web', 'session');
SELECT throws_ok(
  $$SELECT * FROM selena_release.list_pending_site_publications(10)$$,
  NULL, NULL,
  'the web runtime cannot list the releases waiting on the owner'
);
SELECT throws_ok(
  $$SELECT selena_release.record_site_publication_outcome('d7000000-0000-4000-8000-000000000051', 'PUBLISHED', 'https://x')$$,
  NULL, NULL,
  'the web runtime cannot settle a site release'
);
RESET SESSION AUTHORIZATION;

SET SESSION AUTHORIZATION selena_pgtap_gateway_0053;
SELECT selena_registry.set_request_context('service:gateway', '__gateway__', '__gateway__', 'service',
  'eeeeeeee-0000-4000-8000-000000000153', 'gateway', 'service', NULL);
SELECT is(
  (SELECT array_agg(reservation_id ORDER BY reservation_id)::text FROM selena_release.list_pending_site_publications(10)
    WHERE reservation_id::text LIKE 'd7000000-%'),
  '{d7000000-0000-4000-8000-000000000051,d7000000-0000-4000-8000-000000000052,d7000000-0000-4000-8000-000000000053}',
  'the gateway sees each accepted site release whose latest attempt is still ACCEPTED'
);
SELECT is(
  (SELECT manifest ->> 'releaseIntentId' FROM selena_release.list_pending_site_publications(10)
    WHERE reservation_id = 'd7000000-0000-4000-8000-000000000051'),
  'd5000000-0000-4000-8000-000000000051',
  'the signed manifest travels with it, so the gateway knows which edition it wrote'
);
SELECT throws_ok(
  $$SELECT selena_release.record_site_publication_outcome('d7000000-0000-4000-8000-000000000051', 'PUBLISHED',
    'https://www.selenasystems.com/ru/lab/articles/a')$$,
  'Gateway may only record an outcome for its exact manifest',
  'a settlement is bound to the manifest in the request context'
);

SELECT selena_registry.set_request_context('service:gateway', '__gateway__', '__gateway__', 'service',
  'eeeeeeee-0000-4000-8000-000000000253', 'gateway', 'service', 'd6000000-0000-4000-8000-000000000051');
SELECT throws_ok(
  $$SELECT selena_release.record_site_publication_outcome('d7000000-0000-4000-8000-000000000051', 'PUBLISHED', NULL)$$,
  'A published article needs the address of its page',
  'published means a page the author can open'
);
SELECT throws_ok(
  $$SELECT selena_release.record_site_publication_outcome('d7000000-0000-4000-8000-000000000051', 'MAYBE', NULL)$$,
  'Site publication result is invalid',
  'only the three endings are accepted'
);
SELECT lives_ok(
  $$SELECT selena_release.record_site_publication_outcome('d7000000-0000-4000-8000-000000000051', 'PUBLISHED',
    'https://www.selenasystems.com/ru/lab/articles/a')$$,
  'the gateway records a merged edition as published'
);
SELECT throws_ok(
  $$SELECT selena_release.record_site_publication_outcome('d7000000-0000-4000-8000-000000000051', 'CLOSED', NULL)$$,
  'Only an accepted site release is waiting on the owner',
  'a settled release cannot be settled again'
);

SELECT selena_registry.set_request_context('service:gateway', '__gateway__', '__gateway__', 'service',
  'eeeeeeee-0000-4000-8000-000000000353', 'gateway', 'service', 'd6000000-0000-4000-8000-000000000052');
SELECT selena_release.record_site_publication_outcome('d7000000-0000-4000-8000-000000000052', 'CLOSED', NULL);
SELECT selena_registry.set_request_context('service:gateway', '__gateway__', '__gateway__', 'service',
  'eeeeeeee-0000-4000-8000-000000000453', 'gateway', 'service', 'd6000000-0000-4000-8000-000000000053');
SELECT selena_release.record_site_publication_outcome('d7000000-0000-4000-8000-000000000053', 'SUPERSEDED', NULL);
SELECT is(
  (SELECT count(*)::int FROM selena_release.list_pending_site_publications(10) WHERE reservation_id::text LIKE 'd7000000-%'),
  0,
  'nothing settled is watched again'
);
RESET SESSION AUTHORIZATION;

SELECT is(
  (SELECT status::text || ' ' || provider_reference_id FROM selena_release.publication_attempts
   WHERE reservation_id = 'd7000000-0000-4000-8000-000000000051' ORDER BY transition_number DESC LIMIT 1),
  'CONFIRMED https://www.selenasystems.com/ru/lab/articles/a',
  'the published attempt is CONFIRMED and names the page'
);
SELECT is(
  (SELECT outcome || ' ' || reference FROM selena_registry.aether_outcome_outbox
   WHERE content_version_id = 'd2000000-0000-4000-8000-000000000051'),
  'PUBLISHED https://www.selenasystems.com/ru/lab/articles/a',
  'the author is told it is published, with the page'
);
SELECT is(
  (SELECT status::text || ' ' || error_classification FROM selena_release.publication_attempts
   WHERE reservation_id = 'd7000000-0000-4000-8000-000000000052' ORDER BY transition_number DESC LIMIT 1),
  'DEFINITIVE_FAILURE SITE_CHANGE_CLOSED',
  'a closed pull request ends the release'
);
SELECT is(
  (SELECT outcome FROM selena_registry.aether_outcome_outbox WHERE content_version_id = 'd2000000-0000-4000-8000-000000000052'),
  'REJECTED',
  'the author learns the owner declined it'
);
SELECT is(
  (SELECT string_agg(status::text, ',' ORDER BY id) FROM selena_release.release_intents
   WHERE id IN ('d5000000-0000-4000-8000-000000000051', 'd5000000-0000-4000-8000-000000000052', 'd5000000-0000-4000-8000-000000000053')),
  'SUCCEEDED,CANCELLED,CANCELLED',
  'a published release stays succeeded; one the owner did not merge is cancelled'
);
SELECT is(
  (SELECT count(*)::int FROM selena_registry.aether_outcome_outbox WHERE content_version_id = 'd2000000-0000-4000-8000-000000000053'),
  0,
  'a superseded version stays silent so it cannot overwrite the newer version''s outcome'
);
SELECT is(
  (SELECT count(*)::int FROM selena_audit.incidents WHERE brand_id = 'selena-sp-brand'),
  0,
  'the owner declining a release raises no incident'
);

SELECT * FROM finish();
ROLLBACK;

-- Run only against a disposable database after migration 0052 is installed.
-- This file must never be executed against staging or production.
BEGIN;
SELECT plan(13);

INSERT INTO public."user" (id, name, email, email_verified, created_at, updated_at)
VALUES
  ('selena-pgtap-lab-owner', 'Site owner', 'selena-pgtap-lab-owner@example.invalid', true, now(), now()),
  ('selena-pgtap-lab-member', 'Site member', 'selena-pgtap-lab-member@example.invalid', true, now(), now());
INSERT INTO public.organization (id, name, slug, created_at)
VALUES ('selena-pgtap-lab-org', 'Site org', 'selena-pgtap-lab-org', now());
INSERT INTO public.member (id, organization_id, user_id, role, created_at)
VALUES
  ('selena-pgtap-lab-m-owner', 'selena-pgtap-lab-org', 'selena-pgtap-lab-owner', 'owner', now()),
  ('selena-pgtap-lab-m-member', 'selena-pgtap-lab-org', 'selena-pgtap-lab-member', 'member', now());
INSERT INTO public.brands (id, name, website, organization_id)
VALUES
  ('selena-pgtap-lab-brand', 'Site brand', 'https://lab.example.invalid', 'selena-pgtap-lab-org'),
  ('selena-pgtap-lab-other', 'Other brand', 'https://lab-other.example.invalid', 'selena-pgtap-lab-org');

CREATE ROLE selena_pgtap_lab_web LOGIN IN ROLE selena_web_runtime;

SET SESSION AUTHORIZATION selena_pgtap_lab_web;
SELECT selena_registry.set_request_context('selena-pgtap-lab-owner', 'selena-pgtap-lab-org', 'selena-pgtap-lab-brand',
  'owner', 'eeeeeeee-0000-4000-8000-000000000001', 'web', 'session');

SELECT throws_ok(
  $$SELECT * FROM selena_registry.confirm_site_channel_binding('selena-pgtap-lab-brand', 'not a repository', 'PRODUCTION')$$,
  'The site repository must be named owner/name',
  'the site is named by its repository and nothing else'
);

SELECT lives_ok(
  $$SELECT * FROM selena_registry.confirm_site_channel_binding('selena-pgtap-lab-brand',
    'Selena-AI-projects/SELENA-AI-COMPANY', 'PRODUCTION')$$,
  'an owner binds the site'
);

SELECT lives_ok(
  $$SELECT * FROM selena_registry.confirm_site_channel_binding('selena-pgtap-lab-brand',
    'Selena-AI-projects/SELENA-AI-COMPANY', 'PRODUCTION')$$,
  'binding the site again re-points it rather than failing'
);

SELECT selena_registry.set_request_context('selena-pgtap-lab-member', 'selena-pgtap-lab-org', 'selena-pgtap-lab-brand',
  'member', 'eeeeeeee-0000-4000-8000-000000000002', 'web', 'session');
SELECT throws_ok(
  $$SELECT * FROM selena_registry.confirm_site_channel_binding('selena-pgtap-lab-brand',
    'Selena-AI-projects/SELENA-AI-COMPANY', 'PRODUCTION')$$,
  'Only an interactive owner session for this brand may bind a publishing channel',
  'a member of the organization cannot bind the site'
);

SELECT selena_registry.set_request_context('selena-pgtap-lab-owner', 'selena-pgtap-lab-org', 'selena-pgtap-lab-brand',
  'owner', 'eeeeeeee-0000-4000-8000-000000000001', 'web', 'session');
SELECT throws_ok(
  $$SELECT * FROM selena_registry.confirm_site_channel_binding('selena-pgtap-lab-other',
    'Selena-AI-projects/SELENA-AI-COMPANY', 'PRODUCTION')$$,
  'Only an interactive owner session for this brand may bind a publishing channel',
  'the brand in context is the only brand an owner can bind the site for'
);

RESET SESSION AUTHORIZATION;

SELECT is(
  (SELECT count(*)::int FROM selena_registry.channel_accounts
    WHERE brand_id = 'selena-pgtap-lab-brand' AND platform = 'website_lab'
      AND provider_integration_id = 'Selena-AI-projects/SELENA-AI-COMPANY' AND allowlisted AND status = 'ACTIVE'),
  1,
  'one allowlisted site channel names the repository'
);

SELECT is(
  (SELECT count(*)::int FROM selena_registry.channel_provider_bindings binding
    JOIN selena_registry.channel_accounts account ON account.id = binding.channel_account_id
    WHERE account.brand_id = 'selena-pgtap-lab-brand' AND binding.provider = 'selena_lab'
      AND binding.environment = 'PRODUCTION' AND binding.active),
  1,
  'the site channel has one active selena_lab binding on the contour it was bound for'
);

SELECT is(
  (SELECT count(*)::int FROM selena_audit.audit_events
    WHERE brand_id = 'selena-pgtap-lab-brand' AND action = 'release.channel_bound'
      AND metadata ->> 'provider' = 'selena_lab'
      AND metadata ->> 'repository' = 'Selena-AI-projects/SELENA-AI-COMPANY'),
  2,
  'each bind is an act in the audit log, with the repository it names'
);

SELECT throws_ok(
  $$INSERT INTO selena_registry.channel_provider_bindings (
      organization_id, brand_id, channel_account_id, provider, environment, active, created_by
    ) SELECT organization_id, brand_id, id, 'selena-lab', 'STAGING', false, 'seed'
      FROM selena_registry.channel_accounts
      WHERE brand_id = 'selena-pgtap-lab-brand' AND platform = 'website_lab'$$,
  '23514',
  NULL,
  'the allowlist admits selena_lab by its exact name only'
);

-- An Aether article released to the site: an open pull request is not a
-- publication, so it does not return to the author; a refusal does.
INSERT INTO selena_registry.content_items (id, organization_id, brand_id, title, created_by, kind, external_source, external_ref, brief_ref)
VALUES ('c1000000-0000-4000-8000-000000000052', 'selena-pgtap-lab-org', 'selena-pgtap-lab-brand', 'article', 'seed', 'ARTICLE', 'aether',
  '33333333-3333-4333-8333-333333333352', '44444444-4444-4444-8444-444444444452');
INSERT INTO selena_registry.content_versions (id, organization_id, brand_id, content_id, version, body, cta_url, disclosure, policy_version, content_hash, created_by)
VALUES
  ('c2000000-0000-4000-8000-000000000052', 'selena-pgtap-lab-org', 'selena-pgtap-lab-brand', 'c1000000-0000-4000-8000-000000000052', 1, 'b', 'https://cta',
    '{"origin":{"system":"aether","project_id":"11111111-1111-4111-8111-111111111152","trace_id":"22222222-2222-4222-8222-222222222252"}}'::jsonb,
    'pol-1', 'h1', 'seed'),
  ('c2000000-0000-4000-8000-000000000053', 'selena-pgtap-lab-org', 'selena-pgtap-lab-brand', 'c1000000-0000-4000-8000-000000000052', 2, 'b2', 'https://cta',
    '{"origin":{"system":"aether","project_id":"11111111-1111-4111-8111-111111111152","trace_id":"22222222-2222-4222-8222-222222222252"}}'::jsonb,
    'pol-1', 'h2', 'seed');
INSERT INTO selena_registry.approvals (id, organization_id, brand_id, content_version_id, channel_account_id, decision, binding_hash, content_hash, asset_bundle_hash, policy_version, disclosure_hash, approver_id)
SELECT ('ab000000-0000-4000-8000-00000000005' || n)::uuid, 'selena-pgtap-lab-org', 'selena-pgtap-lab-brand',
  ('c2000000-0000-4000-8000-00000000005' || n)::uuid, account.id, 'APPROVED', 'bh', 'ch', 'abh', 'pol-1', 'dh', 'owner'
FROM selena_registry.channel_accounts account, (VALUES ('2'), ('3')) AS versions(n)
WHERE account.brand_id = 'selena-pgtap-lab-brand' AND account.platform = 'website_lab';
INSERT INTO selena_release.release_manifests (id, organization_id, brand_id, content_version_id, approval_id, channel_account_id, platform, manifest, manifest_hash, signature_algorithm, signing_key_version, signature, expires_at, created_by)
SELECT ('ba000000-0000-4000-8000-00000000005' || n)::uuid, 'selena-pgtap-lab-org', 'selena-pgtap-lab-brand',
  ('c2000000-0000-4000-8000-00000000005' || n)::uuid, ('ab000000-0000-4000-8000-00000000005' || n)::uuid, account.id,
  'website_lab', '{}'::jsonb, 'mh' || n, 'ed25519', 'v1', 'sig', now() + interval '1 day', 'seed'
FROM selena_registry.channel_accounts account, (VALUES ('2'), ('3')) AS versions(n)
WHERE account.brand_id = 'selena-pgtap-lab-brand' AND account.platform = 'website_lab';
INSERT INTO selena_release.dispatch_reservations (id, organization_id, brand_id, release_manifest_id, channel_account_id, platform, integration_id, allowlist_reference, idempotency_key, nonce)
SELECT ('bb000000-0000-4000-8000-00000000005' || n)::uuid, 'selena-pgtap-lab-org', 'selena-pgtap-lab-brand',
  ('ba000000-0000-4000-8000-00000000005' || n)::uuid, account.id, 'website_lab', 'Selena-AI-projects/SELENA-AI-COMPANY',
  'allow', 'idem-lab-' || n, 'nonce-lab-' || n
FROM selena_registry.channel_accounts account, (VALUES ('2'), ('3')) AS versions(n)
WHERE account.brand_id = 'selena-pgtap-lab-brand' AND account.platform = 'website_lab';

INSERT INTO selena_release.publication_attempts (organization_id, brand_id, reservation_id, release_manifest_id, channel_account_id, platform, integration_id, allowlist_reference, manifest_hash, attempt_number, transition_number, status, provider_reference_id)
SELECT 'selena-pgtap-lab-org', 'selena-pgtap-lab-brand', 'bb000000-0000-4000-8000-000000000052', 'ba000000-0000-4000-8000-000000000052',
  account.id, 'website_lab', 'Selena-AI-projects/SELENA-AI-COMPANY', 'allow', 'mh2', 1, 1, 'ACCEPTED',
  'https://github.com/Selena-AI-projects/SELENA-AI-COMPANY/pull/154'
FROM selena_registry.channel_accounts account
WHERE account.brand_id = 'selena-pgtap-lab-brand' AND account.platform = 'website_lab';
SELECT is(
  (SELECT count(*)::int FROM selena_registry.aether_outcome_outbox WHERE content_version_id = 'c2000000-0000-4000-8000-000000000052'),
  0,
  'an open pull request on the site is not returned to the author as published'
);

INSERT INTO selena_release.publication_attempts (organization_id, brand_id, reservation_id, release_manifest_id, channel_account_id, platform, integration_id, allowlist_reference, manifest_hash, attempt_number, transition_number, status, provider_reference_id)
SELECT 'selena-pgtap-lab-org', 'selena-pgtap-lab-brand', 'bb000000-0000-4000-8000-000000000052', 'ba000000-0000-4000-8000-000000000052',
  account.id, 'website_lab', 'Selena-AI-projects/SELENA-AI-COMPANY', 'allow', 'mh2', 1, 2, 'CONFIRMED',
  'https://github.com/Selena-AI-projects/SELENA-AI-COMPANY/pull/154'
FROM selena_registry.channel_accounts account
WHERE account.brand_id = 'selena-pgtap-lab-brand' AND account.platform = 'website_lab';
SELECT is(
  (SELECT outcome FROM selena_registry.aether_outcome_outbox WHERE content_version_id = 'c2000000-0000-4000-8000-000000000052'),
  'PUBLISHED',
  'a confirmed site publication returns as PUBLISHED'
);

INSERT INTO selena_release.publication_attempts (organization_id, brand_id, reservation_id, release_manifest_id, channel_account_id, platform, integration_id, allowlist_reference, manifest_hash, attempt_number, transition_number, status)
SELECT 'selena-pgtap-lab-org', 'selena-pgtap-lab-brand', 'bb000000-0000-4000-8000-000000000053', 'ba000000-0000-4000-8000-000000000053',
  account.id, 'website_lab', 'Selena-AI-projects/SELENA-AI-COMPANY', 'allow', 'mh3', 1, 1, 'NOT_SENT'
FROM selena_registry.channel_accounts account
WHERE account.brand_id = 'selena-pgtap-lab-brand' AND account.platform = 'website_lab';
SELECT is(
  (SELECT outcome FROM selena_registry.aether_outcome_outbox WHERE content_version_id = 'c2000000-0000-4000-8000-000000000053'),
  'REFUSED',
  'an article the site provider refused still returns to the author as refused'
);

SELECT ok(
  NOT has_function_privilege('selena_gateway_runtime',
    'selena_registry.confirm_site_channel_binding(text, text, selena_registry.release_environment)', 'EXECUTE'),
  'the gateway cannot bind the site it writes to'
);

SELECT * FROM finish();
ROLLBACK;

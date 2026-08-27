-- Run only against a disposable database after migration 0024 is installed.
-- This file must never be executed against staging or production.
BEGIN;

SELECT plan(3);

INSERT INTO public."user" (id, name, email, email_verified, created_at, updated_at)
VALUES ('selena-pgtap-staging-owner', 'Selena staging owner', 'selena-staging-owner@example.invalid', true, now(), now());
INSERT INTO public.organization (id, name, slug, created_at)
VALUES ('default', 'Selena Systems', 'selena-systems', now());
INSERT INTO public.member (id, organization_id, user_id, role, created_at)
VALUES ('selena-pgtap-staging-member', 'default', 'selena-pgtap-staging-owner', 'owner', now());
INSERT INTO public.brands (id, name, website, organization_id)
VALUES ('selena', 'Selena Systems', 'https://selena.example.invalid', 'default');

CREATE ROLE selena_pgtap_staging_web LOGIN IN ROLE selena_web_runtime;

SET ROLE selena_backup_restore;
INSERT INTO selena_registry.content_items (id, organization_id, brand_id, title, created_by)
VALUES ('30000000-0000-0000-0000-000000000001', 'default', 'selena', 'Staging text-only content', 'seed');
INSERT INTO selena_registry.content_versions (
  id, organization_id, brand_id, content_id, version, body, cta_url, evidence, policy_version,
  content_hash, evidence_expires_at, created_by
) VALUES (
  '30000000-0000-0000-0000-000000000002',
  'default',
  'selena',
  '30000000-0000-0000-0000-000000000001',
  1,
  'Staging text-only content',
  'https://selena.example.invalid/dry-run',
  '[{"source":"fixture://staging-evidence"}]'::jsonb,
  'selena-staging-dry-run/v1',
  repeat('a', 64),
  now() + interval '1 hour',
  'seed'
);
INSERT INTO selena_registry.channel_accounts (
  id, organization_id, brand_id, platform, provider_account_ref, provider_integration_id,
  status, allowlisted, created_by
) VALUES (
  '30000000-0000-0000-0000-000000000003',
  'default',
  'selena',
  'linkedin_page_dry_run',
  'Postiz local dry run',
  NULL,
  'DRY_RUN',
  false,
  'seed'
);
RESET ROLE;

SET SESSION AUTHORIZATION selena_pgtap_staging_web;
SELECT selena_registry.set_request_context(
  'selena-pgtap-staging-owner',
  'default',
  'selena',
  'owner',
  '30000000-0000-0000-0000-000000000004',
  'web',
  'session'
);
SELECT lives_ok(
  $$INSERT INTO selena_registry.approvals (
      organization_id, brand_id, content_version_id, channel_account_id, decision,
      binding_hash, content_hash, asset_bundle_hash, policy_version, disclosure_hash, approver_id, expires_at
    ) VALUES (
      'default', 'selena', '30000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000003',
      'APPROVED', repeat('b', 64), repeat('a', 64), repeat('c', 64), 'selena-staging-dry-run/v1', repeat('d', 64),
      'selena-pgtap-staging-owner', now() + interval '1 hour'
    )$$,
  'fixed staging dry-run account permits a text-only human approval'
);
SELECT is(
  (SELECT count(*) FROM selena_registry.approvals)::integer,
  1,
  'the staging approval is stored in the private registry'
);
SELECT ok(
  NOT has_table_privilege('selena_web_runtime', 'selena_release.publication_attempts', 'INSERT'),
  'web cannot create publication attempts from the staging approval'
);
RESET SESSION AUTHORIZATION;

SELECT * FROM finish();
ROLLBACK;

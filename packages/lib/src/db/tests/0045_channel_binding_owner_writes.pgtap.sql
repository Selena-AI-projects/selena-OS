-- Run only against a disposable database after migration 0045 is installed.
-- This file must never be executed against staging or production.
BEGIN;
SELECT plan(11);

INSERT INTO public."user" (id, name, email, email_verified, created_at, updated_at)
VALUES
  ('selena-pgtap-cb-owner', 'Channel owner', 'selena-pgtap-cb-owner@example.invalid', true, now(), now()),
  ('selena-pgtap-cb-member', 'Channel member', 'selena-pgtap-cb-member@example.invalid', true, now(), now());
INSERT INTO public.organization (id, name, slug, created_at)
VALUES ('selena-pgtap-cb-org', 'Channel org', 'selena-pgtap-cb-org', now());
INSERT INTO public.member (id, organization_id, user_id, role, created_at)
VALUES
  ('selena-pgtap-cb-m-owner', 'selena-pgtap-cb-org', 'selena-pgtap-cb-owner', 'owner', now()),
  ('selena-pgtap-cb-m-member', 'selena-pgtap-cb-org', 'selena-pgtap-cb-member', 'member', now());
INSERT INTO public.brands (id, name, website, organization_id)
VALUES
  ('selena-pgtap-cb-brand', 'Channel brand', 'https://cb.example.invalid', 'selena-pgtap-cb-org'),
  ('selena-pgtap-cb-other', 'Other brand', 'https://cb-other.example.invalid', 'selena-pgtap-cb-org');

CREATE ROLE selena_pgtap_cb_web LOGIN IN ROLE selena_web_runtime;

SELECT ok(
  NOT has_table_privilege('selena_web_runtime', 'selena_registry.channel_provider_bindings', 'INSERT')
  AND NOT has_table_privilege('selena_gateway_runtime', 'selena_registry.channel_provider_bindings', 'INSERT')
  AND NOT has_table_privilege('selena_web_runtime', 'selena_registry.channel_accounts', 'INSERT'),
  'no runtime writes a channel or its binding directly'
);

SET SESSION AUTHORIZATION selena_pgtap_cb_web;
SELECT selena_registry.set_request_context('selena-pgtap-cb-owner', 'selena-pgtap-cb-org', 'selena-pgtap-cb-brand',
  'owner', 'cccccccc-0000-4000-8000-000000000001', 'web', 'session');

SELECT lives_ok(
  $$SELECT selena_registry.confirm_channel_provider_binding('selena-pgtap-cb-brand',
    'Selena LinkedIn Page', 'blotato-linkedin-page', 'blotato', 'STAGING')$$,
  'an interactive owner binds a publishing channel for the brand in context'
);
SELECT results_eq(
  $$SELECT platform, status, allowlisted, provider_integration_id
    FROM selena_registry.channel_accounts WHERE brand_id = 'selena-pgtap-cb-brand'$$,
  $$VALUES ('linkedin_page', 'ACTIVE', true, 'blotato-linkedin-page')$$,
  'the channel is an active, allowlisted LinkedIn page standing for the provider account'
);
SELECT results_eq(
  $$SELECT provider, environment::text, active
    FROM selena_registry.channel_provider_bindings WHERE brand_id = 'selena-pgtap-cb-brand'$$,
  $$VALUES ('blotato', 'STAGING', true)$$,
  'the binding names the provider and the environment it may publish from'
);

SELECT lives_ok(
  $$SELECT selena_registry.confirm_channel_provider_binding('selena-pgtap-cb-brand',
    'Selena LinkedIn Page', 'blotato-linkedin-page', 'blotato', 'STAGING')$$,
  'binding the same channel again is not a collision'
);
SELECT is(
  (SELECT count(*)::int FROM selena_registry.channel_accounts WHERE brand_id = 'selena-pgtap-cb-brand'),
  1, 'repeating the act leaves one channel, not two'
);

SELECT lives_ok(
  $$SELECT selena_registry.confirm_channel_provider_binding('selena-pgtap-cb-brand',
    'Selena LinkedIn Page', 'blotato-linkedin-page', 'postiz', 'STAGING')$$,
  'moving the channel to another provider is allowed'
);
SELECT results_eq(
  $$SELECT provider FROM selena_registry.channel_provider_bindings
    WHERE brand_id = 'selena-pgtap-cb-brand' AND active$$,
  $$VALUES ('postiz')$$,
  'the provider it moved away from stops being active instead of colliding'
);

SELECT throws_ok(
  $$SELECT selena_registry.confirm_channel_provider_binding('selena-pgtap-cb-other',
    'Other page', 'blotato-other', 'blotato', 'STAGING')$$,
  'Only an interactive owner session for this brand may bind a publishing channel',
  'the brand in context is the only brand an owner can bind'
);
SELECT throws_ok(
  $$SELECT selena_registry.confirm_channel_provider_binding('selena-pgtap-cb-brand',
    'Selena LinkedIn Page', 'blotato-linkedin-page', 'tiktok', 'STAGING')$$,
  '23514',
  NULL,
  'a provider outside the allowlist is refused by the database'
);

SELECT selena_registry.set_request_context('selena-pgtap-cb-member', 'selena-pgtap-cb-org', 'selena-pgtap-cb-brand',
  'member', 'cccccccc-0000-4000-8000-000000000002', 'web', 'session');
SELECT throws_ok(
  $$SELECT selena_registry.confirm_channel_provider_binding('selena-pgtap-cb-brand',
    'Member page', 'blotato-member', 'blotato', 'STAGING')$$,
  'Only an interactive owner session for this brand may bind a publishing channel',
  'a member of the organization cannot bind where a release may land'
);

RESET SESSION AUTHORIZATION;
SELECT * FROM finish();
ROLLBACK;

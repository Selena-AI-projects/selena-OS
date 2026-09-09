-- Run only against a disposable database after migration 0047 is installed.
-- This file must never be executed against staging or production.
BEGIN;
SELECT plan(9);

INSERT INTO public."user" (id, name, email, email_verified, created_at, updated_at)
VALUES
  ('selena-pgtap-cbr-owner', 'Channel owner', 'selena-pgtap-cbr-owner@example.invalid', true, now(), now()),
  ('selena-pgtap-cbr-member', 'Channel member', 'selena-pgtap-cbr-member@example.invalid', true, now(), now());
INSERT INTO public.organization (id, name, slug, created_at)
VALUES ('selena-pgtap-cbr-org', 'Channel org', 'selena-pgtap-cbr-org', now());
INSERT INTO public.member (id, organization_id, user_id, role, created_at)
VALUES
  ('selena-pgtap-cbr-m-owner', 'selena-pgtap-cbr-org', 'selena-pgtap-cbr-owner', 'owner', now()),
  ('selena-pgtap-cbr-m-member', 'selena-pgtap-cbr-org', 'selena-pgtap-cbr-member', 'member', now());
INSERT INTO public.brands (id, name, website, organization_id)
VALUES
  ('selena-pgtap-cbr-brand', 'Channel brand', 'https://cbr.example.invalid', 'selena-pgtap-cbr-org'),
  ('selena-pgtap-cbr-other', 'Other brand', 'https://cbr-other.example.invalid', 'selena-pgtap-cbr-org');

CREATE ROLE selena_pgtap_cbr_web LOGIN IN ROLE selena_web_runtime;

SET SESSION AUTHORIZATION selena_pgtap_cbr_web;
SELECT selena_registry.set_request_context('selena-pgtap-cbr-owner', 'selena-pgtap-cbr-org', 'selena-pgtap-cbr-brand',
  'owner', 'dddddddd-0000-4000-8000-000000000001', 'web', 'session');

SELECT lives_ok(
  $$SELECT selena_registry.confirm_channel_provider_binding('selena-pgtap-cbr-brand',
    'Selena LinkedIn Page', 'blotato-linkedin-page', 'blotato', 'STAGING')$$,
  'an owner binds a channel to set up the case this test revokes'
);

SELECT ok(
  NOT has_table_privilege('selena_web_runtime', 'selena_registry.channel_provider_bindings', 'UPDATE')
  AND NOT has_table_privilege('selena_gateway_runtime', 'selena_registry.channel_provider_bindings', 'UPDATE'),
  'no runtime updates a channel binding directly'
);

SELECT throws_ok(
  $$SELECT selena_registry.revoke_channel_provider_binding('selena-pgtap-cbr-other',
    (SELECT id FROM selena_registry.channel_provider_bindings WHERE brand_id = 'selena-pgtap-cbr-brand'))$$,
  'Only an interactive owner session for this brand may revoke a publishing channel binding',
  'the brand in context is the only brand an owner can revoke from'
);

SELECT selena_registry.set_request_context('selena-pgtap-cbr-member', 'selena-pgtap-cbr-org', 'selena-pgtap-cbr-brand',
  'member', 'dddddddd-0000-4000-8000-000000000002', 'web', 'session');
SELECT throws_ok(
  $$SELECT selena_registry.revoke_channel_provider_binding('selena-pgtap-cbr-brand',
    (SELECT id FROM selena_registry.channel_provider_bindings WHERE brand_id = 'selena-pgtap-cbr-brand'))$$,
  'Only an interactive owner session for this brand may revoke a publishing channel binding',
  'a member of the organization cannot revoke where a release may land'
);

SELECT selena_registry.set_request_context('selena-pgtap-cbr-owner', 'selena-pgtap-cbr-org', 'selena-pgtap-cbr-brand',
  'owner', 'dddddddd-0000-4000-8000-000000000001', 'web', 'session');
SELECT lives_ok(
  $$SELECT selena_registry.revoke_channel_provider_binding('selena-pgtap-cbr-brand',
    (SELECT id FROM selena_registry.channel_provider_bindings WHERE brand_id = 'selena-pgtap-cbr-brand'))$$,
  'the owner who bound the mistaken environment can revoke it'
);
SELECT results_eq(
  $$SELECT active FROM selena_registry.channel_provider_bindings WHERE brand_id = 'selena-pgtap-cbr-brand'$$,
  $$VALUES (false)$$,
  'the binding is stood down, not deleted — the audit trail keeps its shape'
);

SELECT lives_ok(
  $$SELECT selena_registry.revoke_channel_provider_binding('selena-pgtap-cbr-brand',
    (SELECT id FROM selena_registry.channel_provider_bindings WHERE brand_id = 'selena-pgtap-cbr-brand'))$$,
  'revoking an already-inactive binding is not an error'
);

SELECT throws_ok(
  $$SELECT selena_registry.revoke_channel_provider_binding('selena-pgtap-cbr-brand', gen_random_uuid())$$,
  'No such binding for this brand',
  'a binding id that does not belong to this brand is refused, not silently ignored'
);

SELECT is(
  (SELECT count(*)::int FROM selena_audit.audit_events
    WHERE brand_id = 'selena-pgtap-cbr-brand' AND action = 'release.channel_unbound'),
  1, 'the audit trail records the revocation exactly once, not on the repeat'
);

RESET SESSION AUTHORIZATION;
SELECT * FROM finish();
ROLLBACK;

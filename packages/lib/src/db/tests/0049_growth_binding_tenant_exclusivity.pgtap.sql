-- Run only against a disposable database after migration 0049 is installed.
-- This file must never be executed against staging or production.
--
-- A revoked binding must not let another organization reclaim the same Aether
-- project in the same environment, while the first organization may rebind it
-- and another organization may still bind it in a different environment.
BEGIN;
SELECT plan(6);

INSERT INTO public."user" (id, name, email, email_verified, created_at, updated_at)
VALUES
  ('selena-pgtap-xb-user-a', 'Excl owner A', 'selena-pgtap-xb-a@example.invalid', true, now(), now()),
  ('selena-pgtap-xb-user-b', 'Excl owner B', 'selena-pgtap-xb-b@example.invalid', true, now(), now());
INSERT INTO public.organization (id, name, slug, created_at)
VALUES
  ('selena-pgtap-xb-org-a', 'Excl org A', 'selena-pgtap-xb-org-a', now()),
  ('selena-pgtap-xb-org-b', 'Excl org B', 'selena-pgtap-xb-org-b', now());
INSERT INTO public.member (id, organization_id, user_id, role, created_at)
VALUES
  ('selena-pgtap-xb-m-a', 'selena-pgtap-xb-org-a', 'selena-pgtap-xb-user-a', 'owner', now()),
  ('selena-pgtap-xb-m-b', 'selena-pgtap-xb-org-b', 'selena-pgtap-xb-user-b', 'owner', now());
INSERT INTO public.brands (id, name, website, organization_id)
VALUES
  ('selena-pgtap-xb-brand-a', 'Excl brand A', 'https://xb-a.example.invalid', 'selena-pgtap-xb-org-a'),
  ('selena-pgtap-xb-brand-b', 'Excl brand B', 'https://xb-b.example.invalid', 'selena-pgtap-xb-org-b');

CREATE ROLE selena_pgtap_xb_web LOGIN IN ROLE selena_web_runtime;

-- Owner A binds a project in 'local', then revokes it.
SET SESSION AUTHORIZATION selena_pgtap_xb_web;
SELECT selena_registry.set_request_context('selena-pgtap-xb-user-a', 'selena-pgtap-xb-org-a', 'selena-pgtap-xb-brand-a',
  'owner', 'bbbbbbbb-0000-4000-8000-000000000001', 'web', 'session');
SELECT lives_ok(
  $$SELECT selena_registry.confirm_growth_binding('selena-pgtap-xb-brand-a',
    '1c7f2e3d-4a5b-4c6d-9e8f-0a1b2c3d4e5f', 'selena', 'local')$$,
  'owner A binds the project in local'
);
SELECT lives_ok(
  $$SELECT selena_registry.revoke_growth_binding(
    (SELECT id FROM selena_registry.growth_project_bindings WHERE brand_id = 'selena-pgtap-xb-brand-a'),
    'pgtap revocation')$$,
  'owner A revokes the binding'
);
RESET SESSION AUTHORIZATION;

-- Owner B must not reclaim the revoked (project, environment) for its own brand.
SET SESSION AUTHORIZATION selena_pgtap_xb_web;
SELECT selena_registry.set_request_context('selena-pgtap-xb-user-b', 'selena-pgtap-xb-org-b', 'selena-pgtap-xb-brand-b',
  'owner', 'bbbbbbbb-0000-4000-8000-000000000002', 'web', 'session');
SELECT throws_ok(
  $$SELECT selena_registry.confirm_growth_binding('selena-pgtap-xb-brand-b',
    '1c7f2e3d-4a5b-4c6d-9e8f-0a1b2c3d4e5f', 'selena', 'local')$$,
  'Another tenant has held this Aether project in this environment',
  'another organization cannot reclaim a revoked project in the same environment'
);
-- A different environment of the same project has no history for anyone, so it is allowed.
SELECT lives_ok(
  $$SELECT selena_registry.confirm_growth_binding('selena-pgtap-xb-brand-b',
    '1c7f2e3d-4a5b-4c6d-9e8f-0a1b2c3d4e5f', 'selena', 'staging')$$,
  'another organization may still bind the same project in a different environment'
);
RESET SESSION AUTHORIZATION;

-- The first organization may rebind what it revoked.
SET SESSION AUTHORIZATION selena_pgtap_xb_web;
SELECT selena_registry.set_request_context('selena-pgtap-xb-user-a', 'selena-pgtap-xb-org-a', 'selena-pgtap-xb-brand-a',
  'owner', 'bbbbbbbb-0000-4000-8000-000000000003', 'web', 'session');
SELECT lives_ok(
  $$SELECT selena_registry.confirm_growth_binding('selena-pgtap-xb-brand-a',
    '1c7f2e3d-4a5b-4c6d-9e8f-0a1b2c3d4e5f', 'selena', 'local')$$,
  'the first organization may rebind the project it revoked'
);
SELECT is(
  (SELECT count(*)::int FROM selena_registry.growth_project_bindings
   WHERE brand_id = 'selena-pgtap-xb-brand-a' AND revoked_at IS NULL),
  1, 'brand A has exactly one active binding again'
);
RESET SESSION AUTHORIZATION;

SELECT * FROM finish();
ROLLBACK;

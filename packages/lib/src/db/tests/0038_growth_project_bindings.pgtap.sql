-- Run only against a disposable database after migration 0038 is installed.
-- This file must never be executed against staging or production.
BEGIN;
SELECT plan(21);

INSERT INTO public."user" (id, name, email, email_verified, created_at, updated_at)
VALUES
  ('selena-pgtap-gb-user-a', 'Growth owner A', 'selena-pgtap-gb-a@example.invalid', true, now(), now()),
  ('selena-pgtap-gb-user-b', 'Growth owner B', 'selena-pgtap-gb-b@example.invalid', true, now(), now()),
  ('selena-pgtap-gb-member', 'Growth member A', 'selena-pgtap-gb-m@example.invalid', true, now(), now());
INSERT INTO public.organization (id, name, slug, created_at)
VALUES
  ('selena-pgtap-gb-org-a', 'Growth org A', 'selena-pgtap-gb-org-a', now()),
  ('selena-pgtap-gb-org-b', 'Growth org B', 'selena-pgtap-gb-org-b', now());
INSERT INTO public.member (id, organization_id, user_id, role, created_at)
VALUES
  ('selena-pgtap-gb-m-a', 'selena-pgtap-gb-org-a', 'selena-pgtap-gb-user-a', 'owner', now()),
  ('selena-pgtap-gb-m-b', 'selena-pgtap-gb-org-b', 'selena-pgtap-gb-user-b', 'owner', now()),
  ('selena-pgtap-gb-m-m', 'selena-pgtap-gb-org-a', 'selena-pgtap-gb-member', 'member', now());
INSERT INTO public.brands (id, name, website, organization_id)
VALUES
  ('selena-pgtap-gb-brand-a', 'Growth brand A', 'https://gb-a.example.invalid', 'selena-pgtap-gb-org-a'),
  ('selena-pgtap-gb-brand-b', 'Growth brand B', 'https://gb-b.example.invalid', 'selena-pgtap-gb-org-b');

CREATE ROLE selena_pgtap_gb_web LOGIN IN ROLE selena_web_runtime;
CREATE ROLE selena_pgtap_gb_worker LOGIN IN ROLE selena_registry_worker_runtime;
CREATE ROLE selena_pgtap_gb_ingestion LOGIN IN ROLE selena_ingestion_runtime;

-- Privileges: the table is never written by a runtime login.
SELECT ok(
  NOT has_table_privilege('selena_web_runtime', 'selena_registry.growth_project_bindings', 'INSERT')
  AND NOT has_table_privilege('selena_web_runtime', 'selena_registry.growth_project_bindings', 'UPDATE')
  AND NOT has_table_privilege('selena_registry_worker_runtime', 'selena_registry.growth_project_bindings', 'SELECT'),
  'runtimes cannot write bindings and the worker cannot read the table directly'
);
SELECT ok(
  (SELECT relforcerowsecurity FROM pg_class WHERE oid = 'selena_registry.growth_project_bindings'::regclass),
  'row level security is forced on bindings'
);

-- An owner session in brand A confirms a binding.
SET SESSION AUTHORIZATION selena_pgtap_gb_web;
SELECT selena_registry.set_request_context('selena-pgtap-gb-user-a', 'selena-pgtap-gb-org-a', 'selena-pgtap-gb-brand-a',
  'owner', 'aaaaaaaa-0000-4000-8000-000000000001', 'web', 'session');
SELECT lives_ok(
  $$SELECT selena_registry.confirm_growth_binding('selena-pgtap-gb-brand-a',
    '0b6f1d2e-3c4b-4a59-8d6e-7f8091a2b3c4', 'selena', 'local')$$,
  'an interactive owner confirms a binding for the brand in context'
);
SELECT is(
  (SELECT count(*)::int FROM selena_registry.growth_project_bindings WHERE brand_id = 'selena-pgtap-gb-brand-a'),
  1, 'the owner sees the binding of the brand in context'
);
SELECT throws_ok(
  $$SELECT selena_registry.confirm_growth_binding('selena-pgtap-gb-brand-b',
    '0b6f1d2e-3c4b-4a59-8d6e-7f8091a2b3c5', 'selena', 'local')$$,
  'Only an interactive owner session for this brand may confirm a growth binding',
  'the brand in context is the only brand an owner can bind'
);
SELECT throws_ok(
  $$SELECT selena_registry.confirm_growth_binding('selena-pgtap-gb-brand-a',
    '0b6f1d2e-3c4b-4a59-8d6e-7f8091a2b3c4', 'kora', 'local')$$,
  '23505',
  NULL,
  'the same Aether project cannot be bound twice in one environment'
);
SELECT throws_ok(
  $$SELECT selena_registry.confirm_growth_binding('selena-pgtap-gb-brand-a',
    '0b6f1d2e-3c4b-4a59-8d6e-7f8091a2b3c4', 'Selena Systems', 'local')$$,
  '23514',
  NULL,
  'a business key outside the alias shape is refused'
);
SELECT throws_ok(
  $$SELECT selena_registry.confirm_growth_binding('selena-pgtap-gb-brand-a',
    '0b6f1d2e-3c4b-4a59-8d6e-7f8091a2b3c6', 'selena', 'dev')$$,
  '23514',
  NULL,
  'an unknown source environment is refused'
);
SELECT is(
  (SELECT count(*)::int FROM selena_audit.audit_events
   WHERE brand_id = 'selena-pgtap-gb-brand-a' AND action = 'growth.binding_confirmed'),
  1, 'the confirmation is on the audit chain'
);
RESET SESSION AUTHORIZATION;

-- A member of the same brand is not an owner.
SET SESSION AUTHORIZATION selena_pgtap_gb_web;
SELECT selena_registry.set_request_context('selena-pgtap-gb-member', 'selena-pgtap-gb-org-a', 'selena-pgtap-gb-brand-a',
  'member', 'aaaaaaaa-0000-4000-8000-000000000002', 'web', 'session');
SELECT throws_ok(
  $$SELECT selena_registry.confirm_growth_binding('selena-pgtap-gb-brand-a',
    '0b6f1d2e-3c4b-4a59-8d6e-7f8091a2b3c7', 'selena', 'local')$$,
  'Only an interactive owner session for this brand may confirm a growth binding',
  'a member cannot confirm a binding'
);
RESET SESSION AUTHORIZATION;

-- The other organization's owner sees nothing and cannot claim the same project.
SET SESSION AUTHORIZATION selena_pgtap_gb_web;
SELECT selena_registry.set_request_context('selena-pgtap-gb-user-b', 'selena-pgtap-gb-org-b', 'selena-pgtap-gb-brand-b',
  'owner', 'aaaaaaaa-0000-4000-8000-000000000003', 'web', 'session');
SELECT is(
  (SELECT count(*)::int FROM selena_registry.growth_project_bindings), 0,
  'another organization sees no bindings of brand A'
);
SELECT throws_ok(
  $$SELECT selena_registry.confirm_growth_binding('selena-pgtap-gb-brand-b',
    '0b6f1d2e-3c4b-4a59-8d6e-7f8091a2b3c4', 'selena', 'local')$$,
  '23505',
  NULL,
  'another organization cannot bind the same Aether project in the same environment'
);
SELECT lives_ok(
  $$SELECT selena_registry.confirm_growth_binding('selena-pgtap-gb-brand-b',
    '0b6f1d2e-3c4b-4a59-8d6e-7f8091a2b3c4', 'selena', 'staging')$$,
  'the same project may be bound in a different environment'
);
RESET SESSION AUTHORIZATION;

-- The worker resolves only through its function and only in its own identity.
SET SESSION AUTHORIZATION selena_pgtap_gb_worker;
SELECT throws_ok(
  $$SELECT * FROM selena_registry.resolve_growth_binding('0b6f1d2e-3c4b-4a59-8d6e-7f8091a2b3c4', 'local')$$,
  'Only the registry worker may resolve a growth binding',
  'the worker login without service context is refused'
);
SELECT set_config('app.selena_service_identity', 'registry_worker', true);
SELECT set_config('app.selena_actor_id', 'service:registry-worker', true);
SELECT set_config('app.selena_auth_type', 'service', true);
SELECT is(
  (SELECT brand_id FROM selena_registry.resolve_growth_binding('0b6f1d2e-3c4b-4a59-8d6e-7f8091a2b3c4', 'local')),
  'selena-pgtap-gb-brand-a',
  'the worker resolves the local binding to brand A'
);
SELECT is(
  (SELECT brand_id FROM selena_registry.resolve_growth_binding('0b6f1d2e-3c4b-4a59-8d6e-7f8091a2b3c4', 'staging')),
  'selena-pgtap-gb-brand-b',
  'the same project in another environment resolves to another brand'
);
SELECT is(
  (SELECT count(*)::int FROM selena_registry.resolve_growth_binding('0b6f1d2e-3c4b-4a59-8d6e-7f8091a2b3c4', 'production')),
  0, 'an unbound environment resolves to nothing'
);
SELECT throws_ok(
  $$SELECT * FROM selena_registry.growth_project_bindings$$,
  '42501',
  NULL,
  'the worker cannot read the bindings table directly'
);
RESET SESSION AUTHORIZATION;

SET SESSION AUTHORIZATION selena_pgtap_gb_ingestion;
SELECT throws_ok(
  $$SELECT * FROM selena_registry.resolve_growth_binding('0b6f1d2e-3c4b-4a59-8d6e-7f8091a2b3c4', 'local')$$,
  '42501',
  NULL,
  'the ingestion runtime (the receiver) cannot resolve bindings at all'
);
RESET SESSION AUTHORIZATION;

-- Revocation stops resolution and is the only permitted change.
SET SESSION AUTHORIZATION selena_pgtap_gb_web;
SELECT selena_registry.set_request_context('selena-pgtap-gb-user-a', 'selena-pgtap-gb-org-a', 'selena-pgtap-gb-brand-a',
  'owner', 'aaaaaaaa-0000-4000-8000-000000000004', 'web', 'session');
SELECT lives_ok(
  $$SELECT selena_registry.revoke_growth_binding(
    (SELECT id FROM selena_registry.growth_project_bindings WHERE brand_id = 'selena-pgtap-gb-brand-a'),
    'pgtap revocation')$$,
  'the owner revokes the binding'
);
RESET SESSION AUTHORIZATION;
SET SESSION AUTHORIZATION selena_pgtap_gb_worker;
SELECT set_config('app.selena_service_identity', 'registry_worker', true);
SELECT set_config('app.selena_actor_id', 'service:registry-worker', true);
SELECT set_config('app.selena_auth_type', 'service', true);
SELECT is(
  (SELECT count(*)::int FROM selena_registry.resolve_growth_binding('0b6f1d2e-3c4b-4a59-8d6e-7f8091a2b3c4', 'local')),
  0, 'a revoked binding no longer resolves'
);
RESET SESSION AUTHORIZATION;

SELECT * FROM finish();
ROLLBACK;

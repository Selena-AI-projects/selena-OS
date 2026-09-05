-- Run only against a disposable database after migration 0039 is installed.
-- This file must never be executed against staging or production.
BEGIN;
SELECT plan(24);

INSERT INTO public."user" (id, name, email, email_verified, created_at, updated_at)
VALUES ('selena-pgtap-pj-user-a', 'Projection owner A', 'selena-pgtap-pj-a@example.invalid', true, now(), now());
INSERT INTO public.organization (id, name, slug, created_at)
VALUES ('selena-pgtap-pj-org-a', 'Projection org A', 'selena-pgtap-pj-org-a', now()),
       ('selena-pgtap-pj-org-b', 'Projection org B', 'selena-pgtap-pj-org-b', now());
INSERT INTO public.member (id, organization_id, user_id, role, created_at)
VALUES ('selena-pgtap-pj-m-a', 'selena-pgtap-pj-org-a', 'selena-pgtap-pj-user-a', 'owner', now());
INSERT INTO public.brands (id, name, website, organization_id)
VALUES ('selena-pgtap-pj-brand-a', 'Projection brand A', 'https://pj-a.example.invalid', 'selena-pgtap-pj-org-a'),
       ('selena-pgtap-pj-brand-b', 'Projection brand B', 'https://pj-b.example.invalid', 'selena-pgtap-pj-org-b');

CREATE ROLE selena_pgtap_pj_ingestion LOGIN IN ROLE selena_ingestion_runtime;
CREATE ROLE selena_pgtap_pj_worker LOGIN IN ROLE selena_registry_worker_runtime;

-- Privilege shape.
SELECT ok(
  NOT has_table_privilege('selena_registry_worker_runtime', 'selena_ingest_raw.aether_events', 'UPDATE')
  AND NOT has_table_privilege('selena_registry_worker_runtime', 'selena_ingest_raw.aether_events', 'INSERT')
  AND has_column_privilege('selena_registry_worker_runtime', 'selena_ingest_raw.aether_events', 'payload', 'SELECT'),
  'the worker reads the inbox and cannot write it directly'
);
SELECT ok(
  NOT has_table_privilege('selena_ingestion_runtime', 'selena_registry.content_items', 'SELECT')
  AND NOT has_table_privilege('selena_ingestion_runtime', 'selena_registry.content_versions', 'INSERT'),
  'the receiver identity never reaches the content registry'
);
SELECT ok(
  has_table_privilege('selena_registry_worker_runtime', 'selena_registry.content_versions', 'INSERT')
  AND has_table_privilege('selena_registry_worker_runtime', 'selena_registry.content_items', 'INSERT'),
  'the worker may create content items and versions (under RLS)'
);

-- Recording semantics under the ingestion identity.
SET SESSION AUTHORIZATION selena_pgtap_pj_ingestion;
SELECT set_config('app.selena_service_identity', 'ingestion', true);
SELECT set_config('app.selena_auth_type', 'service', true);

SELECT is(
  (SELECT outcome FROM selena_ingest_raw.record_aether_event(
    'a1111111-1111-4111-8111-111111111111', 'content.draft_ready', '1.1',
    'a2222222-2222-4222-8222-222222222222', 'a3333333-3333-4333-8333-333333333333',
    1, now(), 'a4444444-4444-4444-8444-444444444444',
    '{"content_kind":"ARTICLE","title":"v1"}'::jsonb, repeat('a', 64))),
  'recorded', 'a material event under schema 1.1 is recorded'
);
SELECT is(
  (SELECT outcome FROM selena_ingest_raw.record_aether_event(
    'a1111111-1111-4111-8111-111111111111', 'content.draft_ready', '1.1',
    'a2222222-2222-4222-8222-222222222222', 'a3333333-3333-4333-8333-333333333333',
    1, now(), 'a4444444-4444-4444-8444-444444444444',
    '{"content_kind":"ARTICLE","title":"v1"}'::jsonb, repeat('a', 64))),
  'duplicate', 'redelivery of the same event is a duplicate'
);
SELECT is(
  (SELECT outcome FROM selena_ingest_raw.record_aether_event(
    'a5555555-5555-4555-8555-555555555555', 'content.draft_ready', '1.1',
    'a2222222-2222-4222-8222-222222222222', 'a3333333-3333-4333-8333-333333333333',
    1, now(), 'a4444444-4444-4444-8444-444444444444',
    '{"content_kind":"ARTICLE","title":"v1"}'::jsonb, repeat('a', 64))),
  'duplicate', 'the same version with the same content under a new event id is still a duplicate'
);
SELECT throws_ok(
  $$SELECT outcome FROM selena_ingest_raw.record_aether_event(
    'a6666666-6666-4666-8666-666666666666', 'content.draft_ready', '1.1',
    'a2222222-2222-4222-8222-222222222222', 'a3333333-3333-4333-8333-333333333333',
    1, now(), 'a4444444-4444-4444-8444-444444444444',
    '{"content_kind":"ARTICLE","title":"changed"}'::jsonb, repeat('b', 64))$$,
  'SE409', NULL,
  'the same version with different content is a conflict, not a duplicate'
);
SELECT throws_ok(
  $$SELECT outcome FROM selena_ingest_raw.record_aether_event(
    'a1111111-1111-4111-8111-111111111111', 'content.draft_ready', '1.1',
    'a2222222-2222-4222-8222-222222222222', 'a3333333-3333-4333-8333-333333333333',
    1, now(), 'a4444444-4444-4444-8444-444444444444',
    '{"content_kind":"ARTICLE","title":"changed"}'::jsonb, repeat('c', 64))$$,
  'SE409', NULL,
  'a reused event id with different content is a conflict'
);
SELECT is(
  (SELECT outcome FROM selena_ingest_raw.record_aether_event(
    'a7777777-7777-4777-8777-777777777777', 'content.draft_ready', '1.1',
    'a2222222-2222-4222-8222-222222222222', 'a3333333-3333-4333-8333-333333333333',
    2, now(), 'a4444444-4444-4444-8444-444444444444',
    '{"content_kind":"ARTICLE","title":"v2"}'::jsonb, repeat('d', 64))),
  'recorded', 'a newer version of the material is recorded'
);
SELECT is(
  (SELECT outcome FROM selena_ingest_raw.record_aether_event(
    'a8888888-8888-4888-8888-888888888888', 'content.draft_ready', '1.1',
    'a2222222-2222-4222-8222-222222222222', 'a3333333-3333-4333-8333-333333333333',
    1, now(), 'a4444444-4444-4444-8444-444444444444',
    '{"content_kind":"ARTICLE","title":"v1"}'::jsonb, repeat('a', 64))),
  'duplicate', 'an old version redelivered unchanged after a newer one is a duplicate'
);
SELECT throws_ok(
  $$SELECT outcome FROM selena_ingest_raw.record_aether_event(
    'a9999999-9999-4999-8999-999999999999', 'content.draft_ready', '1',
    'a2222222-2222-4222-8222-222222222222', 'b3333333-3333-4333-8333-333333333333',
    1, now(), 'a4444444-4444-4444-8444-444444444444',
    '{"content_kind":"ARTICLE","title":"v1"}'::jsonb, repeat('e', 64))$$,
  '23514', NULL,
  'a material event cannot claim schema version 1'
);
SELECT throws_ok(
  $$SELECT * FROM selena_ingest_raw.claim_next_aether_draft_event()$$,
  '42501', NULL,
  'the receiver identity cannot claim material events for projection'
);
RESET SESSION AUTHORIZATION;

-- Projection under the worker identity.
SET SESSION AUTHORIZATION selena_pgtap_pj_worker;
SELECT throws_ok(
  $$SELECT * FROM selena_ingest_raw.claim_next_aether_draft_event()$$,
  'Only the registry worker may claim Aether material events',
  'the worker login without service context cannot claim'
);
SELECT set_config('app.selena_service_identity', 'registry_worker', true);
SELECT set_config('app.selena_actor_id', 'service:registry-worker', true);
SELECT set_config('app.selena_auth_type', 'service', true);
SELECT is(
  (SELECT count(*)::int FROM selena_ingest_raw.claim_next_aether_draft_event()),
  1, 'the worker claims exactly one unprojected material event'
);
SELECT is(
  (SELECT version FROM selena_ingest_raw.claim_next_aether_draft_event()),
  1, 'the earliest received event is claimed first'
);

-- Without a brand context the worker cannot write content anywhere.
SELECT throws_ok(
  $$INSERT INTO selena_registry.content_items (organization_id, brand_id, title, created_by)
    VALUES ('selena-pgtap-pj-org-a', 'selena-pgtap-pj-brand-a', 'no context', 'service:registry-worker')$$,
  '42501', NULL,
  'the worker cannot create content outside an established brand context'
);

-- In the brand context established through the standard function it can.
SELECT selena_registry.set_request_context('service:registry-worker', 'selena-pgtap-pj-org-a', 'selena-pgtap-pj-brand-a',
  'service', 'a0000000-0000-4000-8000-000000000001', 'registry_worker', 'service');
SELECT lives_ok(
  $$INSERT INTO selena_registry.content_items (id, organization_id, brand_id, title, created_by, kind, external_source, external_ref, brief_ref)
    VALUES ('c1111111-1111-4111-8111-111111111111', 'selena-pgtap-pj-org-a', 'selena-pgtap-pj-brand-a', 'projected',
            'service:registry-worker', 'ARTICLE', 'aether', 'a3333333-3333-4333-8333-333333333333', 'a2222222-2222-4222-8222-222222222222')$$,
  'the worker creates a content item in the brand in context'
);
SELECT throws_ok(
  $$INSERT INTO selena_registry.content_items (organization_id, brand_id, title, created_by, kind, external_source, external_ref)
    VALUES ('selena-pgtap-pj-org-a', 'selena-pgtap-pj-brand-a', 'again', 'service:registry-worker', 'ARTICLE', 'aether',
            'a3333333-3333-4333-8333-333333333333')$$,
  '23505', NULL,
  'one material aggregate is one content item per brand'
);
SELECT throws_ok(
  $$INSERT INTO selena_registry.content_items (organization_id, brand_id, title, created_by)
    VALUES ('selena-pgtap-pj-org-b', 'selena-pgtap-pj-brand-b', 'other tenant', 'service:registry-worker')$$,
  '42501', NULL,
  'the worker cannot write into a brand outside its context'
);
SELECT lives_ok(
  $$INSERT INTO selena_registry.content_versions (id, organization_id, brand_id, content_id, version, body, cta_url,
      claims, evidence, disclosure, policy_version, content_hash, created_by)
    VALUES ('c2222222-2222-4222-8222-222222222222', 'selena-pgtap-pj-org-a', 'selena-pgtap-pj-brand-a',
      'c1111111-1111-4111-8111-111111111111', 1, 'body', 'https://pj-a.example.invalid/cta',
      '[]'::jsonb, '[]'::jsonb, '{"source":"SYNTHETIC_FIXTURE"}'::jsonb, 'pgtap-v1', repeat('f', 64), 'service:registry-worker')$$,
  'the worker creates the projected content version'
);
SELECT lives_ok(
  $$SELECT selena_ingest_raw.mark_aether_event_projected(
    (SELECT id FROM selena_ingest_raw.aether_events WHERE event_id = 'a1111111-1111-4111-8111-111111111111'),
    'c2222222-2222-4222-8222-222222222222', NULL)$$,
  'the worker marks the event as projected'
);
SELECT throws_ok(
  $$SELECT selena_ingest_raw.mark_aether_event_projected(
    (SELECT id FROM selena_ingest_raw.aether_events WHERE event_id = 'a1111111-1111-4111-8111-111111111111'),
    'c2222222-2222-4222-8222-222222222222', NULL)$$,
  'Aether material event is not awaiting projection',
  'a projected event cannot be projected again'
);
SELECT is(
  (SELECT version FROM selena_ingest_raw.claim_next_aether_draft_event()),
  2, 'after projection the next claim is the newer version'
);
SELECT lives_ok(
  $$SELECT selena_ingest_raw.mark_aether_event_projected(
    (SELECT id FROM selena_ingest_raw.aether_events WHERE event_id = 'a7777777-7777-4777-8777-777777777777'),
    NULL, 'NO_BINDING')$$,
  'a projection failure is recorded as a code'
);
SELECT is(
  (SELECT count(*)::int FROM selena_ingest_raw.claim_next_aether_draft_event()),
  0, 'nothing is left to claim once every event has an outcome'
);
RESET SESSION AUTHORIZATION;

SELECT * FROM finish();
ROLLBACK;

BEGIN;

SELECT plan(44);

SELECT has_table('selena_registry', 'brand_content_profile_versions', 'profile versions table exists');
SELECT has_table('selena_registry', 'brand_content_profile_decisions', 'profile decisions table exists');
SELECT has_table('selena_registry', 'content_channels', 'content channels table exists');
SELECT ok(to_regtype('selena_registry.profile_decision') IS NOT NULL, 'profile decision enum exists');
SELECT has_index('selena_registry', 'brand_content_profile_versions', 'brand_content_profile_versions_brand_version_unique', 'profile versions are unique per brand/version');
SELECT has_index('selena_registry', 'brand_content_profile_versions', 'brand_content_profile_versions_brand_hash_unique', 'profile hashes are unique per brand');
SELECT has_index('selena_registry', 'content_channels', 'content_channels_brand_platform_unique', 'channels are unique per brand/platform');
SELECT col_not_null('selena_registry', 'brand_content_profile_versions', 'immutable', 'profile versions are immutable');
SELECT col_not_null('selena_registry', 'brand_content_profile_versions', 'profile_hash', 'profile hash is required');
SELECT col_not_null('selena_registry', 'brand_content_profile_decisions', 'profile_hash', 'decision hash is required');
SELECT col_not_null('selena_registry', 'content_channels', 'publication_mode', 'publication mode is required');
SELECT is((SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'selena_registry' AND tablename = 'brand_content_profile_versions'), 5, 'profile version policies are explicit');
SELECT is((SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'selena_registry' AND tablename = 'brand_content_profile_decisions'), 5, 'profile decision policies are explicit');
SELECT is((SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'selena_registry' AND tablename = 'content_channels'), 5, 'channel policies are explicit');
SELECT is((SELECT count(*)::integer FROM pg_trigger WHERE tgrelid = 'selena_registry.brand_content_profile_versions'::regclass AND NOT tgisinternal), 1, 'profile versions are append-only');
SELECT is((SELECT count(*)::integer FROM pg_trigger WHERE tgrelid = 'selena_registry.brand_content_profile_decisions'::regclass AND NOT tgisinternal), 1, 'profile decisions are append-only');
SELECT is((SELECT count(*)::integer FROM pg_trigger WHERE tgrelid = 'selena_registry.content_channels'::regclass AND NOT tgisinternal), 1, 'channels are append-only');

SELECT ok(
  (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'selena_registry.brand_content_profile_versions'::regclass),
  'profile versions force RLS'
);
SELECT ok(
  (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'selena_registry.brand_content_profile_decisions'::regclass),
  'profile decisions force RLS'
);
SELECT ok(
  (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'selena_registry.content_channels'::regclass),
  'content channels force RLS'
);

INSERT INTO public."user" (id, name, email, created_at, updated_at)
VALUES
  ('content-owner', 'Content Owner', 'content-owner@example.test', now(), now()),
  ('content-member', 'Content Member', 'content-member@example.test', now(), now());
INSERT INTO public.organization (id, name, slug, created_at)
VALUES ('content-org', 'Content Org', 'content-org', now());
INSERT INTO public.member (id, organization_id, user_id, role, created_at)
VALUES
  ('content-owner-membership', 'content-org', 'content-owner', 'owner', now()),
  ('content-member-membership', 'content-org', 'content-member', 'member', now());
INSERT INTO public.brands (id, name, website, organization_id)
VALUES
  ('content-brand-a', 'Content Brand A', 'https://a.example.test', 'content-org'),
  ('content-brand-b', 'Content Brand B', 'https://b.example.test', 'content-org');

SET LOCAL ROLE selena_web_runtime;
SELECT selena_registry.set_request_context(
  'content-owner', 'content-org', 'content-brand-a', 'owner',
  '10000000-0000-4000-8000-000000000001', 'web', 'session'
);

SELECT throws_matching(
  $$INSERT INTO selena_registry.brand_content_profile_versions (
    organization_id, brand_id, version, languages, audience, voice,
    profile_hash, created_by
  ) VALUES (
    'content-org', 'content-brand-a', 1, ARRAY['en'], '{}'::jsonb, '{}'::jsonb,
    repeat('a', 64), 'content-member'
  )$$,
  'row-level security policy',
  'profile creator must match the interactive actor'
);
SELECT lives_ok(
  $$INSERT INTO selena_registry.brand_content_profile_versions (
    id, organization_id, brand_id, version, languages, audience, voice,
    cta_rules, visual_rules, claim_rules, facts, source_refs, profile_hash, created_by
  ) VALUES (
    '10000000-0000-4000-8000-000000000010', 'content-org', 'content-brand-a', 1,
    ARRAY['en'], '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb,
    '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, repeat('a', 64), 'content-owner'
  )$$,
  'owner can create a profile draft for the active brand'
);
SELECT throws_matching(
  $$INSERT INTO selena_registry.content_channels (
    organization_id, brand_id, platform, publication_mode, created_by
  ) VALUES (
    'content-org', 'content-brand-a', 'youtube', 'DRAFT_ONLY', 'content-member'
  )$$,
  'row-level security policy',
  'channel creator must match the interactive actor'
);
SELECT lives_ok(
  $$INSERT INTO selena_registry.content_channels (
    id, organization_id, brand_id, platform, publication_mode, created_by
  ) VALUES (
    '10000000-0000-4000-8000-000000000020', 'content-org', 'content-brand-a',
    'youtube', 'DRAFT_ONLY', 'content-owner'
  )$$,
  'owner can create a draft-only YouTube target for the active brand'
);

SELECT selena_registry.set_request_context(
  'content-owner', 'content-org', 'content-brand-b', 'owner',
  '10000000-0000-4000-8000-000000000002', 'web', 'session'
);
SELECT is(
  (SELECT count(*)::integer FROM selena_registry.brand_content_profile_versions),
  0,
  'cross-brand profile SELECT is denied'
);
SELECT is(
  (SELECT count(*)::integer FROM selena_registry.content_channels),
  0,
  'cross-brand channel SELECT is denied'
);
SELECT throws_matching(
  $$INSERT INTO selena_registry.brand_content_profile_versions (
    organization_id, brand_id, version, languages, audience, voice,
    profile_hash, created_by
  ) VALUES (
    'content-org', 'content-brand-a', 2, ARRAY['en'], '{}'::jsonb, '{}'::jsonb,
    repeat('b', 64), 'content-owner'
  )$$,
  'row-level security policy',
  'cross-brand profile INSERT is denied'
);
SELECT throws_matching(
  $$UPDATE selena_registry.brand_content_profile_versions
    SET languages = ARRAY['fr']
    WHERE id = '10000000-0000-4000-8000-000000000010'
    RETURNING id$$,
  'permission denied',
  'cross-brand profile UPDATE is denied'
);
SELECT throws_matching(
  $$DELETE FROM selena_registry.brand_content_profile_versions
    WHERE id = '10000000-0000-4000-8000-000000000010'
    RETURNING id$$,
  'permission denied',
  'cross-brand profile DELETE is denied'
);

SELECT selena_registry.set_request_context(
  'content-member', 'content-org', 'content-brand-a', 'member',
  '10000000-0000-4000-8000-000000000003', 'web', 'session'
);
SELECT lives_ok(
  $$INSERT INTO selena_registry.brand_content_profile_versions (
    id, organization_id, brand_id, version, languages, audience, voice,
    profile_hash, created_by
  ) VALUES (
    '10000000-0000-4000-8000-000000000011', 'content-org', 'content-brand-a', 2,
    ARRAY['en'], '{}'::jsonb, '{}'::jsonb, repeat('b', 64), 'content-member'
  )$$,
  'member can create a profile draft'
);
SELECT throws_matching(
  $$INSERT INTO selena_registry.brand_content_profile_decisions (
    organization_id, brand_id, profile_version_id, profile_hash, decision, decided_by
  ) VALUES (
    'content-org', 'content-brand-a', '10000000-0000-4000-8000-000000000010',
    repeat('a', 64), 'CONFIRMED', 'content-member'
  )$$,
  'row-level security policy',
  'member cannot confirm a profile'
);

SELECT selena_registry.set_request_context(
  'content-owner', 'content-org', 'content-brand-a', 'owner',
  '10000000-0000-4000-8000-000000000004', 'web', 'session'
);
SELECT lives_ok(
  $$INSERT INTO selena_registry.brand_content_profile_decisions (
    id, organization_id, brand_id, profile_version_id, profile_hash, decision, decided_by
  ) VALUES (
    '10000000-0000-4000-8000-000000000030', 'content-org', 'content-brand-a',
    '10000000-0000-4000-8000-000000000010', repeat('a', 64), 'CONFIRMED', 'content-owner'
  )$$,
  'interactive owner can confirm an exact profile version and hash'
);
SELECT throws_matching(
  $$INSERT INTO selena_registry.brand_content_profile_decisions (
    organization_id, brand_id, profile_version_id, profile_hash, decision, decided_by
  ) VALUES (
    'content-org', 'content-brand-a', '10000000-0000-4000-8000-000000000010',
    repeat('c', 64), 'CONFIRMED', 'content-owner'
  )$$,
  'row-level security policy',
  'profile decision cannot bind a stale or foreign hash'
);
SELECT throws_matching(
  $$INSERT INTO selena_registry.brand_content_profile_decisions (
    organization_id, brand_id, profile_version_id, profile_hash, decision, decided_by
  ) VALUES (
    'content-org', 'content-brand-a', '10000000-0000-4000-8000-000000000010',
    repeat('a', 64), 'REVOKED', 'content-owner'
  )$$,
  'brand_content_profile_decisions_revoke_reason',
  'revocation requires a reason'
);

RESET ROLE;

SELECT throws_matching(
  $$UPDATE selena_registry.brand_content_profile_versions SET languages = ARRAY['fr']
    WHERE id = '10000000-0000-4000-8000-000000000010'$$,
  'append-only',
  'profile versions cannot be updated'
);
SELECT throws_matching(
  $$DELETE FROM selena_registry.brand_content_profile_versions
    WHERE id = '10000000-0000-4000-8000-000000000010'$$,
  'append-only',
  'profile versions cannot be deleted'
);
SELECT throws_matching(
  $$UPDATE selena_registry.brand_content_profile_decisions SET reason = 'changed'
    WHERE id = '10000000-0000-4000-8000-000000000030'$$,
  'append-only',
  'profile decisions cannot be updated'
);
SELECT throws_matching(
  $$DELETE FROM selena_registry.brand_content_profile_decisions
    WHERE id = '10000000-0000-4000-8000-000000000030'$$,
  'append-only',
  'profile decisions cannot be deleted'
);
SELECT throws_matching(
  $$UPDATE selena_registry.content_channels SET display_name = 'Changed'
    WHERE id = '10000000-0000-4000-8000-000000000020'$$,
  'append-only',
  'draft channels cannot be updated'
);
SELECT throws_matching(
  $$DELETE FROM selena_registry.content_channels
    WHERE id = '10000000-0000-4000-8000-000000000020'$$,
  'append-only',
  'draft channels cannot be deleted'
);
SELECT throws_matching(
  $$INSERT INTO selena_registry.content_channels (
    organization_id, brand_id, platform, publication_mode, created_by
  ) VALUES ('content-org', 'content-brand-a', 'linkedin', 'DRAFT_ONLY', 'content-owner')$$,
  'content_channels_platform_check',
  'only YouTube targets are accepted in Slice 1'
);
SELECT throws_matching(
  $$INSERT INTO selena_registry.content_channels (
    organization_id, brand_id, platform, publication_mode, created_by
  ) VALUES ('content-org', 'content-brand-a', 'youtube', 'LIVE', 'content-owner')$$,
  'content_channels_publication_mode_check',
  'YouTube target cannot acquire publication authority'
);
SELECT is(
  (
    (SELECT count(*) FROM selena_registry.channel_accounts) +
    (SELECT count(*) FROM selena_release.release_intents) +
    (SELECT count(*) FROM selena_release.outbox_events) +
    (SELECT count(*) FROM selena_release.publication_attempts)
  )::integer,
  0,
  'Slice 1 creates no account, release intent, outbox event or publication attempt'
);
SELECT is(
  (SELECT count(*)::integer FROM selena_registry.brand_content_profile_decisions
    WHERE profile_version_id = '10000000-0000-4000-8000-000000000010'
      AND decision = 'CONFIRMED'),
  1,
  'owner confirmation is stored as one append-only decision'
);

SELECT * FROM finish();
ROLLBACK;

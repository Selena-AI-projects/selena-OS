BEGIN;

SELECT plan(27);

SELECT ok(to_regtype('selena_registry.asset_origin') IS NOT NULL, 'asset origin enum exists');
SELECT has_column('selena_registry', 'content_assets', 'origin', 'assets record where the image came from');

SELECT is(
  (SELECT count(*)::integer FROM pg_enum e
   JOIN pg_type t ON t.oid = e.enumtypid
   JOIN pg_namespace n ON n.oid = t.typnamespace
   WHERE n.nspname = 'selena_registry' AND t.typname = 'editorial_decision'),
  4,
  'an approval can be withdrawn as well as given'
);

-- A definer function that reads a table it has no policy on returns nothing and
-- the caller reads the emptiness as an answer. Both of these are gates.
SELECT ok(
  (SELECT bool_and(p.prosecdef) FROM pg_proc p
   JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'selena_registry'
     AND p.proname IN ('editorial_asset_bundle_hash', 'editorial_evidence_hash')),
  'both editorial digests are computed past row-level security'
);

INSERT INTO public."user" (id, name, email, created_at, updated_at)
VALUES
  ('review-owner', 'Review Owner', 'review-owner@example.test', now(), now()),
  ('review-member', 'Review Member', 'review-member@example.test', now(), now());
INSERT INTO public.organization (id, name, slug, created_at)
VALUES ('review-org', 'Review Org', 'review-org', now());
INSERT INTO public.member (id, organization_id, user_id, role, created_at)
VALUES
  ('review-owner-membership', 'review-org', 'review-owner', 'owner', now()),
  ('review-member-membership', 'review-org', 'review-member', 'member', now());
INSERT INTO public.brands (id, name, website, organization_id)
VALUES ('review-brand', 'Review Brand', 'https://review.example.test', 'review-org');

INSERT INTO selena_registry.brand_content_profile_versions (
  id, organization_id, brand_id, version, languages, audience, voice, profile_hash, created_by
) VALUES (
  '42000000-0000-4000-8000-000000000001', 'review-org', 'review-brand', 1,
  ARRAY['en'], '{}'::jsonb, '{}'::jsonb, repeat('a', 64), 'review-owner'
);
INSERT INTO selena_registry.brand_content_profile_decisions (
  organization_id, brand_id, profile_version_id, profile_hash, decision, decided_by, created_at
) VALUES (
  'review-org', 'review-brand', '42000000-0000-4000-8000-000000000001', repeat('a', 64),
  'CONFIRMED', 'review-owner', now()
);

INSERT INTO selena_registry.content_items (id, organization_id, brand_id, title, created_by)
VALUES ('42000000-0000-4000-8000-000000000101', 'review-org', 'review-brand', 'A draft', 'review-owner');

INSERT INTO selena_registry.content_research_runs (
  id, organization_id, brand_id, profile_version_id, profile_hash, idempotency_key, adapter_id,
  status, pipeline_version, scoring_version, baseline_version, correlation_id,
  started_at, completed_at, created_by
) VALUES (
  '42000000-0000-4000-8000-000000000111', 'review-org', 'review-brand',
  '42000000-0000-4000-8000-000000000001', repeat('a', 64), 'review-seed', 'fixture',
  'COMPLETED', 'content.research/v1', 'content.research.scoring/v1', 'radar-baseline-v1',
  '52000000-0000-4000-8000-000000000011', now(), now(), 'review-owner'
);
INSERT INTO selena_registry.generation_runs (
  id, organization_id, brand_id, kind, status, adapter_id, provider,
  prompt_version, schema_version, pipeline_version, input_snapshot_hash, output_hash,
  validated_output, profile_version_id, profile_hash, research_run_id,
  idempotency_key, correlation_id, started_at, completed_at, created_by
) VALUES (
  '42000000-0000-4000-8000-000000000121', 'review-org', 'review-brand', 'IDEAS', 'COMPLETED',
  'fixture', 'none', 'fixture/v1', 'content.creation.idea/v1', 'content.creation/v1',
  repeat('1', 64), repeat('2', 64), '{"ideas":[]}'::jsonb,
  '42000000-0000-4000-8000-000000000001', repeat('a', 64),
  '42000000-0000-4000-8000-000000000111',
  'review-gen', '52000000-0000-4000-8000-000000000012', now(), now(), 'review-owner'
);

-- Two versions: one structured and reviewable, one legacy. Editorial review binds
-- a profile hash, and only a version that names a profile version has one.
INSERT INTO selena_registry.content_versions (
  id, organization_id, brand_id, content_id, version, body, cta_url,
  policy_version, content_hash, evidence, format_version, hash_version, structured_body,
  project_profile_version_id, research_run_id, generation_run_id, created_by
) VALUES (
  '42000000-0000-4000-8000-000000000201', 'review-org', 'review-brand',
  '42000000-0000-4000-8000-000000000101', 1, 'Rendered body', 'https://example.test/cta',
  'brand-pack/v1', repeat('8', 64), '[{"id":"claim-1"}]'::jsonb,
  'content.youtube-video/v1', 'content.workflow/v2', '{"schema":"content.youtube-video/v1"}'::jsonb,
  '42000000-0000-4000-8000-000000000001', '42000000-0000-4000-8000-000000000111',
  '42000000-0000-4000-8000-000000000121', 'review-owner'
);
INSERT INTO selena_registry.content_versions (
  id, organization_id, brand_id, content_id, version, body, cta_url,
  policy_version, content_hash, created_by
) VALUES (
  '42000000-0000-4000-8000-000000000202', 'review-org', 'review-brand',
  '42000000-0000-4000-8000-000000000101', 2, 'Legacy body', 'https://example.test/cta',
  'brand-pack/v1', repeat('7', 64), 'review-owner'
);

SELECT is(
  selena_registry.editorial_asset_bundle_hash('42000000-0000-4000-8000-000000000201'),
  encode(sha256(convert_to('', 'UTF8')), 'hex'),
  'a version with no clean asset has an empty bundle rather than no answer'
);

SELECT is(
  selena_registry.editorial_evidence_hash('42000000-0000-4000-8000-000000000201'),
  encode(sha256(convert_to((SELECT evidence::text FROM selena_registry.content_versions
                            WHERE id = '42000000-0000-4000-8000-000000000201'), 'UTF8')), 'hex'),
  'the evidence digest is taken over the evidence the version stores'
);

INSERT INTO selena_registry.content_assets (
  id, organization_id, brand_id, content_version_id, storage_key, sha256, mime_type, size_bytes,
  scan_status, created_by
) VALUES
  ('42000000-0000-4000-8000-000000000301', 'review-org', 'review-brand',
   '42000000-0000-4000-8000-000000000201', 'k/clean-b', repeat('b', 64), 'image/png', 1024,
   'CLEAN', 'review-owner'),
  ('42000000-0000-4000-8000-000000000302', 'review-org', 'review-brand',
   '42000000-0000-4000-8000-000000000201', 'k/clean-a', repeat('1', 64), 'image/png', 1024,
   'CLEAN', 'review-owner'),
  ('42000000-0000-4000-8000-000000000303', 'review-org', 'review-brand',
   '42000000-0000-4000-8000-000000000201', 'k/dirty', repeat('c', 64), 'image/png', 1024,
   'QUARANTINED', 'review-owner');

SELECT is(
  (SELECT origin::text FROM selena_registry.content_assets
   WHERE id = '42000000-0000-4000-8000-000000000301'),
  'UPLOADED',
  'an asset that says nothing about its origin is an upload'
);

-- Inserted b-then-1, hashed 1-then-b: the bundle is the set of clean digests and
-- not the order a caller happened to write them in.
SELECT is(
  selena_registry.editorial_asset_bundle_hash('42000000-0000-4000-8000-000000000201'),
  encode(sha256(convert_to(repeat('1', 64) || ',' || repeat('b', 64), 'UTF8')), 'hex'),
  'the bundle is the clean digests in digest order, and the quarantined one is not in it'
);

SET LOCAL ROLE selena_web_runtime;
SELECT selena_registry.set_request_context(
  'review-owner', 'review-org', 'review-brand', 'owner',
  '52000000-0000-4000-8000-000000000001', 'web', 'session'
);

SELECT throws_ok(
  $$INSERT INTO selena_registry.editorial_approvals (
    organization_id, brand_id, content_version_id, decision,
    content_hash, profile_hash, evidence_hash, asset_bundle_hash, decided_by
  ) VALUES (
    'review-org', 'review-brand', '42000000-0000-4000-8000-000000000201', 'APPROVED',
    repeat('8', 64), repeat('a', 64), repeat('e', 64),
    selena_registry.editorial_asset_bundle_hash('42000000-0000-4000-8000-000000000201'),
    'review-owner'
  )$$,
  42501,
  'new row violates row-level security policy for table "editorial_approvals"',
  'an approval naming evidence the version does not carry is refused'
);

SELECT throws_ok(
  $$INSERT INTO selena_registry.editorial_approvals (
    organization_id, brand_id, content_version_id, decision,
    content_hash, profile_hash, evidence_hash, asset_bundle_hash, decided_by
  ) VALUES (
    'review-org', 'review-brand', '42000000-0000-4000-8000-000000000201', 'APPROVED',
    repeat('8', 64), repeat('a', 64),
    selena_registry.editorial_evidence_hash('42000000-0000-4000-8000-000000000201'),
    repeat('f', 64), 'review-owner'
  )$$,
  42501,
  'new row violates row-level security policy for table "editorial_approvals"',
  'an approval naming a bundle the version does not have is refused'
);

SELECT throws_ok(
  $$INSERT INTO selena_registry.editorial_approvals (
    organization_id, brand_id, content_version_id, decision,
    content_hash, profile_hash, evidence_hash, asset_bundle_hash, decided_by
  ) VALUES (
    'review-org', 'review-brand', '42000000-0000-4000-8000-000000000201', 'APPROVED',
    repeat('8', 64), repeat('9', 64),
    selena_registry.editorial_evidence_hash('42000000-0000-4000-8000-000000000201'),
    selena_registry.editorial_asset_bundle_hash('42000000-0000-4000-8000-000000000201'),
    'review-owner'
  )$$,
  42501,
  'new row violates row-level security policy for table "editorial_approvals"',
  'an approval naming a profile the version was not written against is refused'
);

SELECT throws_ok(
  $$INSERT INTO selena_registry.editorial_approvals (
    organization_id, brand_id, content_version_id, decision,
    content_hash, profile_hash, evidence_hash, asset_bundle_hash, decided_by
  ) VALUES (
    'review-org', 'review-brand', '42000000-0000-4000-8000-000000000202', 'APPROVED',
    repeat('7', 64), repeat('a', 64),
    selena_registry.editorial_evidence_hash('42000000-0000-4000-8000-000000000202'),
    selena_registry.editorial_asset_bundle_hash('42000000-0000-4000-8000-000000000202'),
    'review-owner'
  )$$,
  42501,
  'new row violates row-level security policy for table "editorial_approvals"',
  'a version carrying no profile lineage cannot be editorially approved'
);

SELECT throws_ok(
  $$INSERT INTO selena_registry.editorial_approvals (
    organization_id, brand_id, content_version_id, decision,
    content_hash, profile_hash, evidence_hash, asset_bundle_hash, reason, decided_by
  ) VALUES (
    'review-org', 'review-brand', '42000000-0000-4000-8000-000000000201', 'REVOKED',
    repeat('8', 64), repeat('a', 64),
    selena_registry.editorial_evidence_hash('42000000-0000-4000-8000-000000000201'),
    selena_registry.editorial_asset_bundle_hash('42000000-0000-4000-8000-000000000201'),
    'Withdrawn', 'review-owner'
  )$$,
  42501,
  'new row violates row-level security policy for table "editorial_approvals"',
  'an approval that was never given cannot be withdrawn'
);

SELECT lives_ok(
  $$INSERT INTO selena_registry.editorial_approvals (
    organization_id, brand_id, content_version_id, decision,
    content_hash, profile_hash, evidence_hash, asset_bundle_hash, decided_by
  ) VALUES (
    'review-org', 'review-brand', '42000000-0000-4000-8000-000000000201', 'APPROVED',
    repeat('8', 64), repeat('a', 64),
    selena_registry.editorial_evidence_hash('42000000-0000-4000-8000-000000000201'),
    selena_registry.editorial_asset_bundle_hash('42000000-0000-4000-8000-000000000201'),
    'review-owner'
  )$$,
  'an owner can approve a version whose digests still describe it'
);

SELECT throws_ok(
  $$INSERT INTO selena_registry.editorial_approvals (
    organization_id, brand_id, content_version_id, decision,
    content_hash, profile_hash, evidence_hash, asset_bundle_hash, decided_by
  ) VALUES (
    'review-org', 'review-brand', '42000000-0000-4000-8000-000000000201', 'REVOKED',
    repeat('8', 64), repeat('a', 64),
    selena_registry.editorial_evidence_hash('42000000-0000-4000-8000-000000000201'),
    selena_registry.editorial_asset_bundle_hash('42000000-0000-4000-8000-000000000201'),
    'review-owner'
  )$$,
  '23514',
  NULL,
  'withdrawing an approval without saying why leaves the author a changed verdict and no next step'
);

SELECT lives_ok(
  $$INSERT INTO selena_registry.editorial_approvals (
    organization_id, brand_id, content_version_id, decision,
    content_hash, profile_hash, evidence_hash, asset_bundle_hash, reason, decided_by
  ) VALUES (
    'review-org', 'review-brand', '42000000-0000-4000-8000-000000000201', 'REVOKED',
    repeat('8', 64), repeat('a', 64),
    selena_registry.editorial_evidence_hash('42000000-0000-4000-8000-000000000201'),
    selena_registry.editorial_asset_bundle_hash('42000000-0000-4000-8000-000000000201'),
    'The payoff is not supported.', 'review-owner'
  )$$,
  'an owner can withdraw a standing approval'
);

SELECT throws_ok(
  $$INSERT INTO selena_registry.editorial_approvals (
    organization_id, brand_id, content_version_id, decision,
    content_hash, profile_hash, evidence_hash, asset_bundle_hash, reason, decided_by
  ) VALUES (
    'review-org', 'review-brand', '42000000-0000-4000-8000-000000000201', 'REVOKED',
    repeat('8', 64), repeat('a', 64),
    selena_registry.editorial_evidence_hash('42000000-0000-4000-8000-000000000201'),
    selena_registry.editorial_asset_bundle_hash('42000000-0000-4000-8000-000000000201'),
    'Again', 'review-owner'
  )$$,
  42501,
  'new row violates row-level security policy for table "editorial_approvals"',
  'an approval already withdrawn is not standing, so it cannot be withdrawn twice'
);

-- Approving again after a withdrawal is the point of withdrawing: the decision
-- is reversible in both directions, and each reversal is its own row.
SELECT lives_ok(
  $$INSERT INTO selena_registry.editorial_approvals (
    organization_id, brand_id, content_version_id, decision,
    content_hash, profile_hash, evidence_hash, asset_bundle_hash, decided_by
  ) VALUES (
    'review-org', 'review-brand', '42000000-0000-4000-8000-000000000201', 'APPROVED',
    repeat('8', 64), repeat('a', 64),
    selena_registry.editorial_evidence_hash('42000000-0000-4000-8000-000000000201'),
    selena_registry.editorial_asset_bundle_hash('42000000-0000-4000-8000-000000000201'),
    'review-owner'
  )$$,
  'a withdrawn version can be approved again'
);

SELECT is(
  (SELECT count(*)::integer FROM selena_registry.editorial_approvals
   WHERE content_version_id = '42000000-0000-4000-8000-000000000201'),
  3,
  'every decision is a row of its own rather than an edit of the one before it'
);

SELECT selena_registry.set_request_context(
  'review-member', 'review-org', 'review-brand', 'member',
  '52000000-0000-4000-8000-000000000002', 'web', 'session'
);

SELECT throws_ok(
  $$INSERT INTO selena_registry.editorial_approvals (
    organization_id, brand_id, content_version_id, decision,
    content_hash, profile_hash, evidence_hash, asset_bundle_hash, reason, decided_by
  ) VALUES (
    'review-org', 'review-brand', '42000000-0000-4000-8000-000000000201', 'REVOKED',
    repeat('8', 64), repeat('a', 64),
    selena_registry.editorial_evidence_hash('42000000-0000-4000-8000-000000000201'),
    selena_registry.editorial_asset_bundle_hash('42000000-0000-4000-8000-000000000201'),
    'Not mine to take back', 'review-member'
  )$$,
  42501,
  'new row violates row-level security policy for table "editorial_approvals"',
  'taking an approval back is an owner act, as giving one is'
);

SELECT lives_ok(
  $$INSERT INTO selena_registry.editorial_approvals (
    organization_id, brand_id, content_version_id, decision,
    content_hash, profile_hash, evidence_hash, asset_bundle_hash, reason, decided_by
  ) VALUES (
    'review-org', 'review-brand', '42000000-0000-4000-8000-000000000201', 'CHANGES_REQUESTED',
    repeat('8', 64), repeat('a', 64),
    selena_registry.editorial_evidence_hash('42000000-0000-4000-8000-000000000201'),
    selena_registry.editorial_asset_bundle_hash('42000000-0000-4000-8000-000000000201'),
    'The hook overpromises.', 'review-member'
  )$$,
  'a member who cannot approve can still ask for changes'
);

-- The whole reason editorial approval is a separate table: a release manifest
-- reads `approvals`, and nothing here may be mistaken for one.
SELECT is(
  (SELECT count(*)::integer FROM selena_registry.approvals),
  0,
  'no editorial decision has produced a publishing approval'
);

RESET ROLE;

-- Under the web runtime an UPDATE is refused by finding no rows rather than by
-- raising, so the trigger never fires and a throws_ok there would pass on
-- silence. The append-only guarantee has to hold against a role that *can* see
-- the rows, which is the only way to tell the two apart.
SELECT throws_ok(
  $$UPDATE selena_registry.editorial_approvals
    SET decision = 'APPROVED'
    WHERE content_version_id = '42000000-0000-4000-8000-000000000201'$$,
  'Selena record editorial_approvals is append-only; create a compensating record instead',
  'a decision cannot be edited after the fact'
);

-- Scoped to this brand rather than to the table: migrations seed channel
-- accounts of their own, and a count across the whole table would pass or fail
-- on what some other migration did.
SELECT is(
  (SELECT count(*)::integer FROM selena_registry.channel_accounts WHERE brand_id = 'review-brand'),
  0,
  'editorial review created no channel account'
);
SELECT is(
  (SELECT count(*)::integer FROM selena_release.release_intents WHERE brand_id = 'review-brand'),
  0,
  'editorial review created no release intent'
);
SELECT is(
  (SELECT count(*)::integer FROM selena_release.outbox_events WHERE brand_id = 'review-brand'),
  0,
  'editorial review created no outbox event'
);
SELECT is(
  (SELECT count(*)::integer FROM selena_release.publication_attempts WHERE brand_id = 'review-brand'),
  0,
  'editorial review created no publication attempt'
);

SELECT * FROM finish();
ROLLBACK;

BEGIN;

SELECT plan(70);

SELECT has_table('selena_registry', 'generation_runs', 'generation runs table exists');
SELECT has_table('selena_registry', 'editorial_approvals', 'editorial approvals table exists');
SELECT ok(to_regtype('selena_registry.content_kind') IS NOT NULL, 'content kind enum exists');
SELECT ok(to_regtype('selena_registry.content_workflow_stage') IS NOT NULL, 'workflow stage enum exists');
SELECT ok(to_regtype('selena_registry.generation_run_kind') IS NOT NULL, 'generation run kind enum exists');
SELECT ok(to_regtype('selena_registry.generation_run_status') IS NOT NULL, 'generation run status enum exists');
SELECT ok(to_regtype('selena_registry.editorial_decision') IS NOT NULL, 'editorial decision enum exists');

SELECT has_column('selena_registry', 'content_items', 'content_kind', 'content items carry a kind');
SELECT has_column('selena_registry', 'content_items', 'content_channel_id', 'content items carry a channel');
SELECT has_column('selena_registry', 'content_items', 'workflow_stage', 'content items carry a workflow stage');
SELECT has_column('selena_registry', 'content_versions', 'structured_body', 'versions carry a structured body');
SELECT has_column('selena_registry', 'content_versions', 'format_version', 'versions carry a format version');
SELECT has_column('selena_registry', 'content_versions', 'hash_version', 'versions carry a hash version');

-- Editorial approval must never be mistakable for publishing approval, and the
-- surest way to prevent that is for it to be unable to name a channel account.
SELECT hasnt_column(
  'selena_registry', 'editorial_approvals', 'channel_account_id',
  'editorial approval cannot name a channel account'
);

SELECT ok(
  (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'selena_registry.generation_runs'::regclass),
  'generation runs force RLS'
);
SELECT ok(
  (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'selena_registry.editorial_approvals'::regclass),
  'editorial approvals force RLS'
);
SELECT is((SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'selena_registry' AND tablename = 'generation_runs'), 4, 'generation run policies are explicit');
SELECT is((SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'selena_registry' AND tablename = 'editorial_approvals'), 4, 'editorial approval policies are explicit');
SELECT is((SELECT count(*)::integer FROM pg_trigger WHERE tgrelid = 'selena_registry.generation_runs'::regclass AND NOT tgisinternal), 1, 'generation runs are append-only');
SELECT is((SELECT count(*)::integer FROM pg_trigger WHERE tgrelid = 'selena_registry.editorial_approvals'::regclass AND NOT tgisinternal), 1, 'editorial approvals are append-only');

INSERT INTO public."user" (id, name, email, created_at, updated_at)
VALUES
  ('creation-owner', 'Creation Owner', 'creation-owner@example.test', now(), now()),
  ('creation-member', 'Creation Member', 'creation-member@example.test', now(), now());
INSERT INTO public.organization (id, name, slug, created_at)
VALUES ('creation-org', 'Creation Org', 'creation-org', now());
INSERT INTO public.member (id, organization_id, user_id, role, created_at)
VALUES
  ('creation-owner-membership', 'creation-org', 'creation-owner', 'owner', now()),
  ('creation-member-membership', 'creation-org', 'creation-member', 'member', now());
INSERT INTO public.brands (id, name, website, organization_id)
VALUES
  ('creation-brand-a', 'Creation Brand A', 'https://a.example.test', 'creation-org'),
  ('creation-brand-b', 'Creation Brand B', 'https://b.example.test', 'creation-org');

INSERT INTO selena_registry.brand_content_profile_versions (
  id, organization_id, brand_id, version, languages, audience, voice, profile_hash, created_by
) VALUES
  ('40000000-0000-4000-8000-000000000001', 'creation-org', 'creation-brand-a', 1, ARRAY['en'], '{}'::jsonb, '{}'::jsonb, repeat('a', 64), 'creation-owner'),
  ('40000000-0000-4000-8000-000000000002', 'creation-org', 'creation-brand-b', 1, ARRAY['en'], '{}'::jsonb, '{}'::jsonb, repeat('b', 64), 'creation-owner'),
  -- Confirmed and then revoked: generation must be refused against it.
  ('40000000-0000-4000-8000-000000000003', 'creation-org', 'creation-brand-a', 2, ARRAY['en'], '{}'::jsonb, '{}'::jsonb, repeat('c', 64), 'creation-owner');
INSERT INTO selena_registry.brand_content_profile_decisions (
  organization_id, brand_id, profile_version_id, profile_hash, decision, decided_by, reason, created_at
) VALUES
  ('creation-org', 'creation-brand-a', '40000000-0000-4000-8000-000000000001', repeat('a', 64), 'CONFIRMED', 'creation-owner', NULL, now()),
  ('creation-org', 'creation-brand-b', '40000000-0000-4000-8000-000000000002', repeat('b', 64), 'CONFIRMED', 'creation-owner', NULL, now()),
  ('creation-org', 'creation-brand-a', '40000000-0000-4000-8000-000000000003', repeat('c', 64), 'CONFIRMED', 'creation-owner', NULL, now() - interval '1 minute'),
  ('creation-org', 'creation-brand-a', '40000000-0000-4000-8000-000000000003', repeat('c', 64), 'REVOKED', 'creation-owner', 'Superseded', now());

INSERT INTO selena_registry.content_research_runs (
  id, organization_id, brand_id, profile_version_id, profile_hash, idempotency_key, adapter_id,
  status, pipeline_version, scoring_version, baseline_version, correlation_id,
  started_at, completed_at, created_by
) VALUES
  ('40000000-0000-4000-8000-000000000101', 'creation-org', 'creation-brand-a',
   '40000000-0000-4000-8000-000000000001', repeat('a', 64), 'seed-a', 'fixture',
   'COMPLETED', 'content.research/v1', 'content.research.scoring/v1', 'radar-baseline-v1',
   '50000000-0000-4000-8000-000000000001', now(), now(), 'creation-owner'),
  ('40000000-0000-4000-8000-000000000102', 'creation-org', 'creation-brand-b',
   '40000000-0000-4000-8000-000000000002', repeat('b', 64), 'seed-b', 'fixture',
   'COMPLETED', 'content.research/v1', 'content.research.scoring/v1', 'radar-baseline-v1',
   '50000000-0000-4000-8000-000000000002', now(), now(), 'creation-owner');

INSERT INTO selena_registry.content_research_sources (
  id, organization_id, brand_id, run_id, platform, external_id, source_url, adapter_id,
  channel_id, channel_name, title, description, published_at, captured_at,
  video_type, transcript_status, transcript_failure_reason, baseline_sample_size,
  baseline_confidence, outlier_band, outlier_maturity, relevance_score, candidate_score,
  weight_coverage, score_components, scoring_version, baseline_version, created_by
) VALUES
  ('40000000-0000-4000-8000-000000000151', 'creation-org', 'creation-brand-a',
   '40000000-0000-4000-8000-000000000101', 'youtube', 'source-a', 'https://example.test/a', 'fixture',
   'channel-a', 'Channel A', 'A title', 'A description', now(), now(), 'LONG', 'UNAVAILABLE',
   'NO_TRANSCRIPT_PUBLISHED', 16, 'HIGH', 'STRONG', 'MATURE', 0.6, 0.7, 1.0, '[]'::jsonb,
   'content.research.scoring/v1', 'radar-baseline-v1', 'creation-owner'),
  ('40000000-0000-4000-8000-000000000152', 'creation-org', 'creation-brand-b',
   '40000000-0000-4000-8000-000000000102', 'youtube', 'source-b', 'https://example.test/b', 'fixture',
   'channel-b', 'Channel B', 'A title', 'A description', now(), now(), 'LONG', 'UNAVAILABLE',
   'NO_TRANSCRIPT_PUBLISHED', 16, 'HIGH', 'STRONG', 'MATURE', 0.6, 0.7, 1.0, '[]'::jsonb,
   'content.research.scoring/v1', 'radar-baseline-v1', 'creation-owner');

INSERT INTO selena_registry.content_research_opportunities (
  id, organization_id, brand_id, run_id, source_id, profile_version_id, profile_hash, opportunity_key,
  proposed_angle, proposed_hook, content_format, rationale,
  evidence_summary, confidence, fact_requirements, created_by
) VALUES
  ('40000000-0000-4000-8000-000000000201', 'creation-org', 'creation-brand-a',
   '40000000-0000-4000-8000-000000000101', '40000000-0000-4000-8000-000000000151',
   '40000000-0000-4000-8000-000000000001', repeat('a', 64),
   'opp-a', 'An angle', 'A hook', 'LONG_VIDEO', 'A rationale', 'Evidence', 'HIGH', '[]'::jsonb, 'creation-owner'),
  ('40000000-0000-4000-8000-000000000202', 'creation-org', 'creation-brand-b',
   '40000000-0000-4000-8000-000000000102', '40000000-0000-4000-8000-000000000152',
   '40000000-0000-4000-8000-000000000002', repeat('b', 64),
   'opp-b', 'An angle', 'A hook', 'LONG_VIDEO', 'A rationale', 'Evidence', 'HIGH', '[]'::jsonb, 'creation-owner');

INSERT INTO selena_registry.content_channels (id, organization_id, brand_id, platform, created_by)
VALUES
  ('40000000-0000-4000-8000-000000000301', 'creation-org', 'creation-brand-a', 'youtube', 'creation-owner'),
  ('40000000-0000-4000-8000-000000000302', 'creation-org', 'creation-brand-b', 'youtube', 'creation-owner');

-- A sibling brand's item and generation run, seeded before the role switch
-- because the web runtime is refused from writing them at all. They exist so the
-- lineage columns on content_items have something real to be pointed at.
INSERT INTO selena_registry.content_items (id, organization_id, brand_id, title, created_by)
VALUES ('40000000-0000-4000-8000-000000000502', 'creation-org', 'creation-brand-b', 'B post', 'creation-owner');
INSERT INTO selena_registry.generation_runs (
  id, organization_id, brand_id, kind, status, adapter_id, provider,
  prompt_version, schema_version, pipeline_version, input_snapshot_hash, output_hash,
  validated_output, profile_version_id, profile_hash, idempotency_key, correlation_id,
  started_at, completed_at, created_by
) VALUES (
  '40000000-0000-4000-8000-000000000403', 'creation-org', 'creation-brand-b', 'IDEAS', 'COMPLETED',
  'fixture', 'none', 'fixture/v1', 'content.creation.idea/v1', 'content.creation/v1',
  repeat('1', 64), repeat('2', 64), '{"ideas":[]}'::jsonb,
  '40000000-0000-4000-8000-000000000002', repeat('b', 64),
  'gen-b', '50000000-0000-4000-8000-000000000018', now(), now(), 'creation-owner'
);

SET LOCAL ROLE selena_web_runtime;
SELECT selena_registry.set_request_context(
  'creation-owner', 'creation-org', 'creation-brand-a', 'owner',
  '50000000-0000-4000-8000-000000000010', 'web', 'session'
);

SELECT lives_ok(
  $$INSERT INTO selena_registry.generation_runs (
    id, organization_id, brand_id, kind, status, adapter_id, provider,
    prompt_version, schema_version, pipeline_version, input_snapshot_hash, output_hash,
    validated_output, profile_version_id, profile_hash, research_run_id, research_opportunity_id,
    idempotency_key, correlation_id, started_at, completed_at, created_by
  ) VALUES (
    '40000000-0000-4000-8000-000000000401', 'creation-org', 'creation-brand-a', 'IDEAS', 'COMPLETED',
    'fixture', 'none', 'fixture/v1', 'content.creation.idea/v1', 'content.creation/v1',
    repeat('1', 64), repeat('2', 64), '{"ideas":[]}'::jsonb,
    '40000000-0000-4000-8000-000000000001', repeat('a', 64),
    '40000000-0000-4000-8000-000000000101', '40000000-0000-4000-8000-000000000201',
    'gen-one', '50000000-0000-4000-8000-000000000011', now(), now(), 'creation-owner'
  )$$,
  'a generation run can be recorded against the brand''s own confirmed profile and run'
);

SELECT throws_ok(
  $$INSERT INTO selena_registry.generation_runs (
    organization_id, brand_id, kind, status, adapter_id, provider,
    prompt_version, schema_version, pipeline_version, input_snapshot_hash, output_hash,
    validated_output, profile_version_id, profile_hash, idempotency_key, correlation_id,
    started_at, completed_at, created_by
  ) VALUES (
    'creation-org', 'creation-brand-b', 'IDEAS', 'COMPLETED', 'fixture', 'none',
    'fixture/v1', 'content.creation.idea/v1', 'content.creation/v1', repeat('1', 64), repeat('2', 64),
    '{"ideas":[]}'::jsonb, '40000000-0000-4000-8000-000000000002', repeat('b', 64),
    'gen-foreign', '50000000-0000-4000-8000-000000000012', now(), now(), 'creation-owner'
  )$$,
  42501,
  'new row violates row-level security policy for table "generation_runs"',
  'a generation run cannot be written for a brand outside the request context'
);

SELECT throws_ok(
  $$INSERT INTO selena_registry.generation_runs (
    organization_id, brand_id, kind, status, adapter_id, provider,
    prompt_version, schema_version, pipeline_version, input_snapshot_hash, output_hash,
    validated_output, profile_version_id, profile_hash, idempotency_key, correlation_id,
    started_at, completed_at, created_by
  ) VALUES (
    'creation-org', 'creation-brand-a', 'IDEAS', 'COMPLETED', 'fixture', 'none',
    'fixture/v1', 'content.creation.idea/v1', 'content.creation/v1', repeat('1', 64), repeat('2', 64),
    '{"ideas":[]}'::jsonb, '40000000-0000-4000-8000-000000000003', repeat('c', 64),
    'gen-revoked', '50000000-0000-4000-8000-000000000013', now(), now(), 'creation-owner'
  )$$,
  42501,
  'new row violates row-level security policy for table "generation_runs"',
  'a generation run cannot bind a revoked profile version'
);

-- The opportunity must belong to the run the generation names, not merely to the
-- same brand: otherwise a generation could cite evidence from research it was
-- not based on.
SELECT throws_ok(
  $$INSERT INTO selena_registry.generation_runs (
    organization_id, brand_id, kind, status, adapter_id, provider,
    prompt_version, schema_version, pipeline_version, input_snapshot_hash, output_hash,
    validated_output, profile_version_id, profile_hash, research_run_id, research_opportunity_id,
    idempotency_key, correlation_id, started_at, completed_at, created_by
  ) VALUES (
    'creation-org', 'creation-brand-a', 'IDEAS', 'COMPLETED', 'fixture', 'none',
    'fixture/v1', 'content.creation.idea/v1', 'content.creation/v1', repeat('1', 64), repeat('2', 64),
    '{"ideas":[]}'::jsonb, '40000000-0000-4000-8000-000000000001', repeat('a', 64),
    '40000000-0000-4000-8000-000000000101', '40000000-0000-4000-8000-000000000202',
    'gen-crossed', '50000000-0000-4000-8000-000000000014', now(), now(), 'creation-owner'
  )$$,
  42501,
  'new row violates row-level security policy for table "generation_runs"',
  'a generation run cannot cite an opportunity from another run'
);

SELECT throws_ok(
  $$INSERT INTO selena_registry.generation_runs (
    organization_id, brand_id, kind, status, adapter_id, provider,
    prompt_version, schema_version, pipeline_version, input_snapshot_hash,
    profile_version_id, profile_hash, idempotency_key, correlation_id,
    started_at, completed_at, created_by
  ) VALUES (
    'creation-org', 'creation-brand-a', 'IDEAS', 'COMPLETED', 'fixture', 'none',
    'fixture/v1', 'content.creation.idea/v1', 'content.creation/v1', repeat('1', 64),
    '40000000-0000-4000-8000-000000000001', repeat('a', 64),
    'gen-no-output', '50000000-0000-4000-8000-000000000015', now(), now(), 'creation-owner'
  )$$,
  '23514',
  NULL,
  'a COMPLETED generation run must carry validated output'
);

SELECT throws_matching(
  $$INSERT INTO selena_registry.generation_runs (
    organization_id, brand_id, kind, status, adapter_id, provider,
    prompt_version, schema_version, pipeline_version, input_snapshot_hash,
    validated_output, output_hash, profile_version_id, profile_hash, error_code,
    idempotency_key, correlation_id, started_at, completed_at, created_by
  ) VALUES (
    'creation-org', 'creation-brand-a', 'IDEAS', 'FAILED', 'fixture', 'none',
    'fixture/v1', 'content.creation.idea/v1', 'content.creation/v1', repeat('1', 64),
    '{"ideas":[]}'::jsonb, repeat('2', 64), '40000000-0000-4000-8000-000000000001', repeat('a', 64),
    'the provider said: quota exceeded for project 12345',
    'gen-failed-with-output', '50000000-0000-4000-8000-000000000016', now(), now(), 'creation-owner'
  )$$,
  'generation_runs',
  'a FAILED generation run cannot store output, and its error is a normalized code'
);

SELECT lives_ok(
  $$INSERT INTO selena_registry.generation_runs (
    id, organization_id, brand_id, kind, status, adapter_id, provider,
    prompt_version, schema_version, pipeline_version, input_snapshot_hash,
    profile_version_id, profile_hash, error_code,
    idempotency_key, correlation_id, started_at, completed_at, created_by
  ) VALUES (
    '40000000-0000-4000-8000-000000000402', 'creation-org', 'creation-brand-a', 'IDEAS', 'FAILED',
    'gemini', 'none', 'fixture/v1', 'content.creation.idea/v1', 'content.creation/v1', repeat('1', 64),
    '40000000-0000-4000-8000-000000000001', repeat('a', 64), 'ADAPTER_DISABLED',
    'gen-refused', '50000000-0000-4000-8000-000000000017', now(), now(), 'creation-owner'
  )$$,
  'a refused adapter is recorded as a failure with a normalized code and no output'
);

-- ── content items and versions ──────────────────────────────────────────────

SELECT throws_ok(
  $$INSERT INTO selena_registry.content_items (organization_id, brand_id, title, content_kind, created_by)
    VALUES ('creation-org', 'creation-brand-a', 'A video', 'YOUTUBE_VIDEO', 'creation-owner')$$,
  '23514',
  NULL,
  'a YouTube video must name the channel it is for'
);

SELECT lives_ok(
  $$INSERT INTO selena_registry.content_items (
    id, organization_id, brand_id, title, content_kind, content_channel_id, workflow_stage, created_by
  ) VALUES (
    '40000000-0000-4000-8000-000000000501', 'creation-org', 'creation-brand-a', 'A video',
    'YOUTUBE_VIDEO', '40000000-0000-4000-8000-000000000301', 'IDEA_SELECTED', 'creation-owner'
  )$$,
  'a YouTube video item can be created for a DRAFT_ONLY channel'
);

-- content_items now carries lineage of its own, and 0021 governed both writes
-- with a bare can_write_brand. The foreign keys prove the referenced rows exist
-- and say nothing about whose they are.
SELECT throws_ok(
  $$INSERT INTO selena_registry.content_items (
    organization_id, brand_id, title, content_kind, content_channel_id, created_by
  ) VALUES (
    'creation-org', 'creation-brand-a', 'A video', 'YOUTUBE_VIDEO',
    '40000000-0000-4000-8000-000000000302', 'creation-owner'
  )$$,
  42501,
  'new row violates row-level security policy for table "content_items"',
  'a draft cannot be created for a sibling brand''s channel'
);
SELECT throws_ok(
  $$UPDATE selena_registry.content_items
      SET content_channel_id = '40000000-0000-4000-8000-000000000302'
      WHERE id = '40000000-0000-4000-8000-000000000501'$$,
  42501,
  'new row violates row-level security policy for table "content_items"',
  'a draft cannot be moved onto a sibling brand''s channel'
);
SELECT throws_ok(
  $$UPDATE selena_registry.content_items
      SET selected_idea_index = 0, idea_generation_run_id = '40000000-0000-4000-8000-000000000403'
      WHERE id = '40000000-0000-4000-8000-000000000501'$$,
  42501,
  'new row violates row-level security policy for table "content_items"',
  'a draft cannot name a sibling brand''s generation run as the idea it came from'
);
SELECT lives_ok(
  $$UPDATE selena_registry.content_items
      SET selected_idea_index = 0, idea_generation_run_id = '40000000-0000-4000-8000-000000000401'
      WHERE id = '40000000-0000-4000-8000-000000000501'$$,
  'a draft names its own brand''s generation run, so this is a condition and not a refusal'
);

-- What a draft is decides whether the release guard gates it, whether a channel
-- is required, and whether the creation surfaces list it. An UPDATE is not a way
-- to change the answer.
SELECT throws_matching(
  $$UPDATE selena_registry.content_items SET content_kind = 'GENERIC_POST'
      WHERE id = '40000000-0000-4000-8000-000000000501'$$,
  'refuses to change the kind of an existing content item',
  'the kind of an existing draft cannot be edited'
);
SELECT lives_ok(
  $$UPDATE selena_registry.content_items SET workflow_stage = 'SCRIPT_DRAFTED'
      WHERE id = '40000000-0000-4000-8000-000000000501'$$,
  'an ordinary stage change is untouched by the kind lock'
);

SELECT throws_ok(
  $$INSERT INTO selena_registry.content_versions (
    organization_id, brand_id, content_id, version, body, cta_url,
    policy_version, content_hash, created_by
  ) VALUES (
    'creation-org', 'creation-brand-a', '40000000-0000-4000-8000-000000000502', 1,
    'Legacy body', 'https://example.test/cta', 'brand-pack/v1', repeat('7', 64), 'creation-owner'
  )$$,
  42501,
  'new row violates row-level security policy for table "content_versions"',
  'a version cannot be hung off a sibling brand''s draft, taking the version number its own next write needs'
);

-- A version written before this migration is legacy text with a V1 hash, and
-- nothing here changes either.
SELECT lives_ok(
  $$INSERT INTO selena_registry.content_versions (
    id, organization_id, brand_id, content_id, version, body, cta_url,
    policy_version, content_hash, created_by
  ) VALUES (
    '40000000-0000-4000-8000-000000000601', 'creation-org', 'creation-brand-a',
    '40000000-0000-4000-8000-000000000501', 1, 'Legacy body', 'https://example.test/cta',
    'brand-pack/v1', repeat('9', 64), 'creation-owner'
  )$$,
  'a legacy version still writes with no structured columns at all'
);
SELECT is(
  (SELECT format_version FROM selena_registry.content_versions WHERE id = '40000000-0000-4000-8000-000000000601'),
  'legacy.text/v1',
  'an untouched version defaults to the legacy format'
);
SELECT is(
  (SELECT hash_version FROM selena_registry.content_versions WHERE id = '40000000-0000-4000-8000-000000000601'),
  'selena.content/v1',
  'an untouched version keeps the V1 hash version'
);

SELECT lives_ok(
  $$INSERT INTO selena_registry.content_versions (
    id, organization_id, brand_id, content_id, version, body, cta_url,
    policy_version, content_hash, format_version, hash_version, structured_body,
    project_profile_version_id, research_run_id, generation_run_id, created_by
  ) VALUES (
    '40000000-0000-4000-8000-000000000602', 'creation-org', 'creation-brand-a',
    '40000000-0000-4000-8000-000000000501', 2, 'Rendered body', 'https://example.test/cta',
    'brand-pack/v1', repeat('8', 64), 'content.youtube-video/v1', 'content.workflow/v2',
    '{"schema":"content.youtube-video/v1"}'::jsonb,
    '40000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000101',
    '40000000-0000-4000-8000-000000000401', 'creation-owner'
  )$$,
  'a structured version carries its document and its full lineage'
);

-- The two shapes are kept apart at the boundary. Each half of the rule is
-- asserted alone, so neither can be relied on to cover the other.
SELECT throws_ok(
  $$INSERT INTO selena_registry.content_versions (
    organization_id, brand_id, content_id, version, body, cta_url, policy_version, content_hash,
    format_version, hash_version, created_by
  ) VALUES (
    'creation-org', 'creation-brand-a', '40000000-0000-4000-8000-000000000501', 3,
    'Rendered body', 'https://example.test/cta', 'brand-pack/v1', repeat('7', 64),
    'content.youtube-video/v1', 'content.workflow/v2', 'creation-owner'
  )$$,
  '23514',
  NULL,
  'a structured version without a document is refused'
);
SELECT throws_ok(
  $$INSERT INTO selena_registry.content_versions (
    organization_id, brand_id, content_id, version, body, cta_url, policy_version, content_hash,
    format_version, hash_version, structured_body, project_profile_version_id, research_run_id, created_by
  ) VALUES (
    'creation-org', 'creation-brand-a', '40000000-0000-4000-8000-000000000501', 4,
    'Rendered body', 'https://example.test/cta', 'brand-pack/v1', repeat('6', 64),
    'content.youtube-video/v1', 'selena.content/v1', '{"schema":"content.youtube-video/v1"}'::jsonb,
    '40000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000101', 'creation-owner'
  )$$,
  '23514',
  NULL,
  'a structured version hashed as V1 is refused'
);
SELECT throws_ok(
  $$INSERT INTO selena_registry.content_versions (
    organization_id, brand_id, content_id, version, body, cta_url, policy_version, content_hash,
    format_version, hash_version, structured_body, created_by
  ) VALUES (
    'creation-org', 'creation-brand-a', '40000000-0000-4000-8000-000000000501', 5,
    'Legacy body', 'https://example.test/cta', 'brand-pack/v1', repeat('5', 64),
    'legacy.text/v1', 'selena.content/v1', '{"schema":"content.youtube-video/v1"}'::jsonb, 'creation-owner'
  )$$,
  '23514',
  NULL,
  'a legacy version carrying a structured document is refused'
);
SELECT throws_ok(
  $$INSERT INTO selena_registry.content_versions (
    organization_id, brand_id, content_id, version, body, cta_url, policy_version, content_hash,
    format_version, hash_version, structured_body, project_profile_version_id, research_run_id, created_by
  ) VALUES (
    'creation-org', 'creation-brand-a', '40000000-0000-4000-8000-000000000501', 6,
    'Rendered body', 'https://example.test/cta', 'brand-pack/v1', repeat('4', 64),
    'content.youtube-video/v1', 'content.workflow/v2', '{"schema":"something.else/v1"}'::jsonb,
    '40000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000101', 'creation-owner'
  )$$,
  '23514',
  NULL,
  'a structured version whose document names another schema is refused'
);
SELECT throws_ok(
  $$INSERT INTO selena_registry.content_versions (
    organization_id, brand_id, content_id, version, body, cta_url, policy_version, content_hash,
    format_version, hash_version, structured_body, project_profile_version_id, created_by
  ) VALUES (
    'creation-org', 'creation-brand-a', '40000000-0000-4000-8000-000000000501', 7,
    'Rendered body', 'https://example.test/cta', 'brand-pack/v1', repeat('3', 64),
    'content.youtube-video/v1', 'content.workflow/v2', '{"schema":"content.youtube-video/v1"}'::jsonb,
    '40000000-0000-4000-8000-000000000001', 'creation-owner'
  )$$,
  '23514',
  NULL,
  'a structured version without its research lineage is refused'
);

-- The lineage columns are as protected as generation_runs' own. A version may
-- only cite research, a profile version and a generation run belonging to the
-- brand it is written for; the V2 digest covers those ids, so a forged one would
-- become part of what an editorial decision attests to.
SELECT throws_ok(
  $$INSERT INTO selena_registry.content_versions (
    organization_id, brand_id, content_id, version, body, cta_url, policy_version, content_hash,
    format_version, hash_version, structured_body, project_profile_version_id, research_run_id,
    generation_run_id, created_by
  ) VALUES (
    'creation-org', 'creation-brand-a', '40000000-0000-4000-8000-000000000501', 8,
    'Rendered body', 'https://example.test/cta', 'brand-pack/v1', repeat('a', 64),
    'content.youtube-video/v1', 'content.workflow/v2', '{"schema":"content.youtube-video/v1"}'::jsonb,
    '40000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000101',
    '40000000-0000-4000-8000-000000000401', 'creation-owner'
  )$$,
  42501,
  'new row violates row-level security policy for table "content_versions"',
  'a version cannot cite a sibling brand''s profile version'
);
SELECT throws_ok(
  $$INSERT INTO selena_registry.content_versions (
    organization_id, brand_id, content_id, version, body, cta_url, policy_version, content_hash,
    format_version, hash_version, structured_body, project_profile_version_id, research_run_id,
    generation_run_id, created_by
  ) VALUES (
    'creation-org', 'creation-brand-a', '40000000-0000-4000-8000-000000000501', 9,
    'Rendered body', 'https://example.test/cta', 'brand-pack/v1', repeat('b', 64),
    'content.youtube-video/v1', 'content.workflow/v2', '{"schema":"content.youtube-video/v1"}'::jsonb,
    '40000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000102',
    '40000000-0000-4000-8000-000000000401', 'creation-owner'
  )$$,
  42501,
  'new row violates row-level security policy for table "content_versions"',
  'a version cannot cite another brand''s research run'
);

-- ── editorial approvals ─────────────────────────────────────────────────────

SELECT lives_ok(
  $$INSERT INTO selena_registry.editorial_approvals (
    organization_id, brand_id, content_version_id, decision,
    content_hash, profile_hash, evidence_hash, asset_bundle_hash, decided_by
  ) VALUES (
    'creation-org', 'creation-brand-a', '40000000-0000-4000-8000-000000000602', 'APPROVED',
    repeat('8', 64), repeat('a', 64), selena_registry.editorial_evidence_hash('40000000-0000-4000-8000-000000000602'),
    selena_registry.editorial_asset_bundle_hash('40000000-0000-4000-8000-000000000602'), 'creation-owner'
  )$$,
  'an owner can approve a version editorially'
);

SELECT throws_ok(
  $$INSERT INTO selena_registry.editorial_approvals (
    organization_id, brand_id, content_version_id, decision,
    content_hash, profile_hash, evidence_hash, asset_bundle_hash, decided_by
  ) VALUES (
    'creation-org', 'creation-brand-a', '40000000-0000-4000-8000-000000000602', 'APPROVED',
    repeat('0', 64), repeat('a', 64), selena_registry.editorial_evidence_hash('40000000-0000-4000-8000-000000000602'),
    selena_registry.editorial_asset_bundle_hash('40000000-0000-4000-8000-000000000602'), 'creation-owner'
  )$$,
  42501,
  'new row violates row-level security policy for table "editorial_approvals"',
  'an approval naming a hash the version does not carry is refused'
);

SELECT throws_ok(
  $$INSERT INTO selena_registry.editorial_approvals (
    organization_id, brand_id, content_version_id, decision,
    content_hash, profile_hash, evidence_hash, asset_bundle_hash, decided_by
  ) VALUES (
    'creation-org', 'creation-brand-a', '40000000-0000-4000-8000-000000000602', 'REJECTED',
    repeat('8', 64), repeat('a', 64), selena_registry.editorial_evidence_hash('40000000-0000-4000-8000-000000000602'),
    selena_registry.editorial_asset_bundle_hash('40000000-0000-4000-8000-000000000602'), 'creation-owner'
  )$$,
  '23514',
  NULL,
  'rejecting without a reason leaves the author a verdict and no next step'
);

SELECT lives_ok(
  $$INSERT INTO selena_registry.editorial_approvals (
    organization_id, brand_id, content_version_id, decision,
    content_hash, profile_hash, evidence_hash, asset_bundle_hash, reason, decided_by
  ) VALUES (
    'creation-org', 'creation-brand-a', '40000000-0000-4000-8000-000000000602', 'CHANGES_REQUESTED',
    repeat('8', 64), repeat('a', 64), selena_registry.editorial_evidence_hash('40000000-0000-4000-8000-000000000602'),
    selena_registry.editorial_asset_bundle_hash('40000000-0000-4000-8000-000000000602'), 'The payoff is not supported.', 'creation-owner'
  )$$,
  'changes can be requested with a reason'
);

SELECT throws_ok(
  $$INSERT INTO selena_registry.editorial_approvals (
    organization_id, brand_id, content_version_id, decision,
    content_hash, profile_hash, evidence_hash, asset_bundle_hash, decided_by
  ) VALUES (
    'creation-org', 'creation-brand-a', '40000000-0000-4000-8000-000000000602', 'APPROVED',
    repeat('8', 64), repeat('a', 64), selena_registry.editorial_evidence_hash('40000000-0000-4000-8000-000000000602'),
    selena_registry.editorial_asset_bundle_hash('40000000-0000-4000-8000-000000000602'), 'creation-member'
  )$$,
  42501,
  'new row violates row-level security policy for table "editorial_approvals"',
  'a decision cannot be attributed to another actor'
);

-- Append-only, proved by attempting the mutation rather than by reading the
-- trigger's existence.
SELECT throws_matching(
  $$UPDATE selena_registry.generation_runs SET status = 'FAILED'
    WHERE id = '40000000-0000-4000-8000-000000000401'$$,
  'permission denied',
  'a generation run cannot be updated by the web runtime'
);
SELECT throws_matching(
  $$DELETE FROM selena_registry.editorial_approvals$$,
  'permission denied',
  'an editorial approval cannot be deleted by the web runtime'
);

-- Cross-brand isolation, from the reading side.
SELECT selena_registry.set_request_context(
  'creation-owner', 'creation-org', 'creation-brand-b', 'owner',
  '50000000-0000-4000-8000-000000000020', 'web', 'session'
);
SELECT is(
  (SELECT count(*)::integer FROM selena_registry.generation_runs WHERE brand_id <> 'creation-brand-b'),
  0,
  'a sibling brand sees none of the first brand''s generation runs'
);
-- Counted against its own row rather than against an empty table: a policy that
-- returned nothing to anybody would pass the assertion above and be useless.
SELECT is(
  (SELECT count(*)::integer FROM selena_registry.generation_runs),
  1,
  'and does see its own'
);
SELECT is(
  (SELECT count(*)::integer FROM selena_registry.editorial_approvals),
  0,
  'a sibling brand sees none of the first brand''s editorial decisions'
);

RESET ROLE;

-- ── release fail-closed ─────────────────────────────────────────────────────
-- Deliberately run with row security bypassed. The claim being tested is that
-- the refusal is not an RLS refusal: a caller that can see and write everything
-- is still refused, because the gate is a trigger rather than a policy.

INSERT INTO selena_registry.channel_accounts (id, organization_id, brand_id, platform, provider_account_ref, created_by)
VALUES ('40000000-0000-4000-8000-000000000701', 'creation-org', 'creation-brand-a', 'youtube', 'yt-ref', 'creation-owner');
INSERT INTO selena_registry.approvals (
  id, organization_id, brand_id, content_version_id, channel_account_id, decision,
  binding_hash, content_hash, asset_bundle_hash, policy_version, disclosure_hash,
  approver_id, expires_at
) VALUES (
  '40000000-0000-4000-8000-000000000801', 'creation-org', 'creation-brand-a',
  '40000000-0000-4000-8000-000000000602', '40000000-0000-4000-8000-000000000701', 'APPROVED',
  repeat('b', 64), repeat('8', 64), repeat('f', 64), 'brand-pack/v1', repeat('d', 64),
  'creation-owner', now() + interval '1 day'
);

SELECT throws_matching(
  $$INSERT INTO selena_release.release_intents (
    organization_id, brand_id, content_version_id, approval_id, channel_account_id,
    platform, idempotency_key, correlation_id, created_by
  ) VALUES (
    'creation-org', 'creation-brand-a', '40000000-0000-4000-8000-000000000602',
    '40000000-0000-4000-8000-000000000801', '40000000-0000-4000-8000-000000000701',
    'youtube', 'release-one', '50000000-0000-4000-8000-000000000030', 'creation-owner'
  )$$,
  'no allowlisted YouTube channel account with a publication adapter exists',
  'a YouTube video cannot be queued for release in Stage 1'
);

-- Scoped to this version rather than to the whole table. Earlier suites in the
-- same disposable database leave release rows behind, so a global count would
-- pass or fail depending on which files ran first — which is not a property of
-- this migration.
SELECT is(
  (SELECT count(*)::integer FROM selena_release.release_intents
   WHERE content_version_id = '40000000-0000-4000-8000-000000000602'),
  0,
  'no release intent exists for the refused YouTube version'
);
SELECT is(
  (SELECT count(*)::integer FROM selena_release.release_manifests
   WHERE content_version_id = '40000000-0000-4000-8000-000000000602'),
  0,
  'no release manifest exists for the refused YouTube version'
);
SELECT is(
  (SELECT count(*)::integer FROM selena_release.outbox_events event
   JOIN selena_release.release_intents intent ON intent.id = event.release_intent_id
   WHERE intent.content_version_id = '40000000-0000-4000-8000-000000000602'),
  0,
  'no outbox event exists for the refused YouTube version'
);

-- The gate must name a YouTube publication adapter. An active binding for some
-- other provider, attached to a YouTube channel account, says nothing about
-- YouTube publication — and a gate that accepted it would open on a routing
-- decision nobody made about YouTube.
INSERT INTO selena_registry.channel_provider_bindings (
  organization_id, brand_id, channel_account_id, provider, environment, active, created_by
) VALUES (
  'creation-org', 'creation-brand-a', '40000000-0000-4000-8000-000000000701',
  'postiz', 'STAGING', true, 'creation-owner'
);
SELECT throws_matching(
  $$INSERT INTO selena_release.release_intents (
    organization_id, brand_id, content_version_id, approval_id, channel_account_id,
    platform, idempotency_key, correlation_id, created_by
  ) VALUES (
    'creation-org', 'creation-brand-a', '40000000-0000-4000-8000-000000000602',
    '40000000-0000-4000-8000-000000000801', '40000000-0000-4000-8000-000000000701',
    'youtube', 'release-postiz', '50000000-0000-4000-8000-000000000031', 'creation-owner'
  )$$,
  'no allowlisted YouTube channel account with a publication adapter exists',
  'an active binding for another provider does not open the YouTube gate'
);

-- The intent table is not append-only, so an intent created against a legacy
-- version could otherwise be re-pointed at a YouTube one after the gate.
INSERT INTO selena_registry.content_items (
  id, organization_id, brand_id, title, content_kind, created_by
) VALUES (
  '40000000-0000-4000-8000-000000000901', 'creation-org', 'creation-brand-a', 'A post',
  'GENERIC_POST', 'creation-owner'
);
INSERT INTO selena_registry.content_versions (
  id, organization_id, brand_id, content_id, version, body, cta_url, policy_version, content_hash, created_by
) VALUES (
  '40000000-0000-4000-8000-000000000902', 'creation-org', 'creation-brand-a',
  '40000000-0000-4000-8000-000000000901', 1, 'Legacy body', 'https://example.test/cta',
  'brand-pack/v1', repeat('2', 64), 'creation-owner'
);
INSERT INTO selena_registry.approvals (
  id, organization_id, brand_id, content_version_id, channel_account_id, decision,
  binding_hash, content_hash, asset_bundle_hash, policy_version, disclosure_hash, approver_id, expires_at
) VALUES (
  '40000000-0000-4000-8000-000000000903', 'creation-org', 'creation-brand-a',
  '40000000-0000-4000-8000-000000000902', '40000000-0000-4000-8000-000000000701', 'APPROVED',
  repeat('b', 64), repeat('2', 64), repeat('f', 64), 'brand-pack/v1', repeat('d', 64),
  'creation-owner', now() + interval '1 day'
);
SELECT lives_ok(
  $$INSERT INTO selena_release.release_intents (
    id, organization_id, brand_id, content_version_id, approval_id, channel_account_id,
    platform, idempotency_key, correlation_id, created_by
  ) VALUES (
    '40000000-0000-4000-8000-000000000904', 'creation-org', 'creation-brand-a',
    '40000000-0000-4000-8000-000000000902', '40000000-0000-4000-8000-000000000903',
    '40000000-0000-4000-8000-000000000701', 'postiz', 'release-legacy',
    '50000000-0000-4000-8000-000000000032', 'creation-owner'
  )$$,
  'a legacy version is still releasable, so the gate is a condition and not a blanket refusal'
);
SELECT throws_matching(
  $$UPDATE selena_release.release_intents
    SET content_version_id = '40000000-0000-4000-8000-000000000602'
    WHERE id = '40000000-0000-4000-8000-000000000904'$$,
  'no allowlisted YouTube channel account with a publication adapter exists',
  'an intent cannot be re-pointed at a YouTube version after the fact'
);

-- ...and the manifest boundary refuses the same version for the same reason, so
-- neither entry point is left as the one somebody forgot.
SELECT throws_matching(
  $$INSERT INTO selena_release.release_manifests (
    organization_id, brand_id, content_version_id, approval_id, channel_account_id,
    platform, manifest, manifest_hash, signature_algorithm, signing_key_version,
    signature, expires_at, created_by
  ) VALUES (
    'creation-org', 'creation-brand-a', '40000000-0000-4000-8000-000000000602',
    '40000000-0000-4000-8000-000000000801', '40000000-0000-4000-8000-000000000701',
    'youtube', '{}'::jsonb, repeat('c', 64), 'ed25519', 'v1', 'signature',
    now() + interval '1 day', 'creation-owner'
  )$$,
  'no allowlisted YouTube channel account with a publication adapter exists',
  'a YouTube video cannot be given a release manifest in Stage 1'
);

-- The kind of a draft is a column the ordinary web runtime may UPDATE, so a gate
-- that read only it would be opened by flipping the kind, releasing, and
-- flipping it back. Here the item says GENERIC_POST and the version says
-- content.youtube-video/v1, and the version is the one that cannot be edited.
INSERT INTO selena_registry.content_items (
  id, organization_id, brand_id, title, content_kind, created_by
) VALUES (
  '40000000-0000-4000-8000-000000000905', 'creation-org', 'creation-brand-a', 'A disguised video',
  'GENERIC_POST', 'creation-owner'
);
INSERT INTO selena_registry.content_versions (
  id, organization_id, brand_id, content_id, version, body, cta_url, policy_version, content_hash,
  format_version, hash_version, structured_body, project_profile_version_id, research_run_id,
  generation_run_id, created_by
) VALUES (
  '40000000-0000-4000-8000-000000000906', 'creation-org', 'creation-brand-a',
  '40000000-0000-4000-8000-000000000905', 1, 'Rendered body', 'https://example.test/cta',
  'brand-pack/v1', repeat('3', 64), 'content.youtube-video/v1', 'content.workflow/v2',
  '{"schema":"content.youtube-video/v1"}'::jsonb,
  '40000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000101',
  '40000000-0000-4000-8000-000000000401', 'creation-owner'
);
INSERT INTO selena_registry.approvals (
  id, organization_id, brand_id, content_version_id, channel_account_id, decision,
  binding_hash, content_hash, asset_bundle_hash, policy_version, disclosure_hash, approver_id, expires_at
) VALUES (
  '40000000-0000-4000-8000-000000000907', 'creation-org', 'creation-brand-a',
  '40000000-0000-4000-8000-000000000906', '40000000-0000-4000-8000-000000000701', 'APPROVED',
  repeat('b', 64), repeat('3', 64), repeat('f', 64), 'brand-pack/v1', repeat('d', 64),
  'creation-owner', now() + interval '1 day'
);
SELECT throws_matching(
  $$INSERT INTO selena_release.release_intents (
    organization_id, brand_id, content_version_id, approval_id, channel_account_id,
    platform, idempotency_key, correlation_id, created_by
  ) VALUES (
    'creation-org', 'creation-brand-a', '40000000-0000-4000-8000-000000000906',
    '40000000-0000-4000-8000-000000000907', '40000000-0000-4000-8000-000000000701',
    'youtube', 'release-disguised', '50000000-0000-4000-8000-000000000033', 'creation-owner'
  )$$,
  'no allowlisted YouTube channel account with a publication adapter exists',
  'the gate reads the version''s own immutable format, not only the item''s editable kind'
);
SELECT throws_matching(
  $$UPDATE selena_registry.content_items SET content_kind = 'GENERIC_POST'
      WHERE id = '40000000-0000-4000-8000-000000000501'$$,
  'refuses to change the kind of an existing content item',
  'the kind is held by a trigger, so bypassing row security does not unlock it'
);

-- The tenant half of the gate cannot be reached while 0033's allowlist refuses
-- every YouTube provider value, so the allowlist is lifted for the rest of this
-- transaction — which is rolled back — to rehearse the day a YouTube adapter is
-- admitted. Without this the predicate would be untested until the migration
-- that introduces the adapter, which is the wrong time to discover it is absent.
ALTER TABLE selena_registry.channel_provider_bindings
  DROP CONSTRAINT channel_provider_bindings_provider_known;
INSERT INTO selena_registry.channel_accounts (id, organization_id, brand_id, platform, provider_account_ref, created_by)
VALUES ('40000000-0000-4000-8000-000000000702', 'creation-org', 'creation-brand-b', 'youtube', 'yt-ref-b', 'creation-owner');
INSERT INTO selena_registry.channel_provider_bindings (
  organization_id, brand_id, channel_account_id, provider, environment, active, created_by
) VALUES (
  'creation-org', 'creation-brand-b', '40000000-0000-4000-8000-000000000702',
  'youtube', 'PRODUCTION', true, 'creation-owner'
);
INSERT INTO selena_registry.approvals (
  id, organization_id, brand_id, content_version_id, channel_account_id, decision,
  binding_hash, content_hash, asset_bundle_hash, policy_version, disclosure_hash, approver_id, expires_at
) VALUES (
  '40000000-0000-4000-8000-000000000908', 'creation-org', 'creation-brand-a',
  '40000000-0000-4000-8000-000000000602', '40000000-0000-4000-8000-000000000702', 'APPROVED',
  repeat('b', 64), repeat('8', 64), repeat('f', 64), 'brand-pack/v1', repeat('d', 64),
  'creation-owner', now() + interval '1 day'
);
SELECT throws_matching(
  $$INSERT INTO selena_release.release_intents (
    organization_id, brand_id, content_version_id, approval_id, channel_account_id,
    platform, idempotency_key, correlation_id, created_by
  ) VALUES (
    'creation-org', 'creation-brand-a', '40000000-0000-4000-8000-000000000602',
    '40000000-0000-4000-8000-000000000908', '40000000-0000-4000-8000-000000000702',
    'youtube', 'release-foreign-account', '50000000-0000-4000-8000-000000000034', 'creation-owner'
  )$$,
  'no allowlisted YouTube channel account with a publication adapter exists',
  'another brand''s allowlisted YouTube account does not open this brand''s gate'
);
INSERT INTO selena_registry.channel_provider_bindings (
  organization_id, brand_id, channel_account_id, provider, environment, active, created_by
) VALUES (
  'creation-org', 'creation-brand-a', '40000000-0000-4000-8000-000000000701',
  'youtube', 'PRODUCTION', true, 'creation-owner'
);
SELECT lives_ok(
  $$INSERT INTO selena_release.release_intents (
    organization_id, brand_id, content_version_id, approval_id, channel_account_id,
    platform, idempotency_key, correlation_id, created_by
  ) VALUES (
    'creation-org', 'creation-brand-a', '40000000-0000-4000-8000-000000000602',
    '40000000-0000-4000-8000-000000000801', '40000000-0000-4000-8000-000000000701',
    'youtube', 'release-own-account', '50000000-0000-4000-8000-000000000035', 'creation-owner'
  )$$,
  'the brand''s own allowlisted YouTube account with a YouTube adapter does open the gate'
);

-- The guard reads content_items through a SECURITY DEFINER function owned by
-- selena_schema_owner. Without a read policy for that role the lookup returns
-- nothing and the guard waves every row through, so the policy is asserted here
-- rather than left as an implementation detail nobody would miss until it
-- mattered.
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'selena_registry'
      AND tablename = 'content_items'
      AND policyname = 'content_items_schema_owner_select'
  ),
  'the release guard can actually read the content item it is gating'
);

SELECT * FROM finish();
ROLLBACK;

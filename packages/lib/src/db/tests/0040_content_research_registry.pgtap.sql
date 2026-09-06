BEGIN;

SELECT plan(65);

SELECT has_table('selena_registry', 'content_research_runs', 'research runs table exists');
SELECT has_table('selena_registry', 'content_research_sources', 'research sources table exists');
SELECT has_table('selena_registry', 'content_research_metric_snapshots', 'metric snapshots table exists');
SELECT has_table('selena_registry', 'content_research_opportunities', 'opportunities table exists');
SELECT has_table('selena_registry', 'content_research_opportunity_decisions', 'opportunity decisions table exists');
SELECT ok(to_regtype('selena_registry.content_research_run_status') IS NOT NULL, 'run status enum exists');
SELECT ok(to_regtype('selena_registry.content_transcript_status') IS NOT NULL, 'transcript status enum exists');
SELECT ok(to_regtype('selena_registry.content_opportunity_decision') IS NOT NULL, 'opportunity decision enum exists');
SELECT has_index('selena_registry', 'content_research_runs', 'content_research_runs_brand_idempotency_unique', 'runs are idempotent per brand');
SELECT has_index('selena_registry', 'content_research_sources', 'content_research_sources_run_external_unique', 'sources are unique per run');
SELECT has_index('selena_registry', 'content_research_metric_snapshots', 'content_research_metric_snapshots_source_captured_unique', 'snapshots are unique per source and capture time');
SELECT has_index('selena_registry', 'content_research_opportunities', 'content_research_opportunities_run_key_unique', 'opportunities are unique per run key');

-- Stage 1 stores transcript state but never transcript text, so there is no
-- column an ambiguous transcript right could be written into.
SELECT hasnt_column('selena_registry', 'content_research_sources', 'transcript_text', 'transcript text is not persisted');

SELECT ok(
  (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'selena_registry.content_research_runs'::regclass),
  'research runs force RLS'
);
SELECT ok(
  (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'selena_registry.content_research_sources'::regclass),
  'research sources force RLS'
);
SELECT ok(
  (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'selena_registry.content_research_metric_snapshots'::regclass),
  'metric snapshots force RLS'
);
SELECT ok(
  (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'selena_registry.content_research_opportunities'::regclass),
  'opportunities force RLS'
);
SELECT ok(
  (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'selena_registry.content_research_opportunity_decisions'::regclass),
  'opportunity decisions force RLS'
);

SELECT is((SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'selena_registry' AND tablename = 'content_research_runs'), 5, 'run policies are explicit');
SELECT is((SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'selena_registry' AND tablename = 'content_research_sources'), 5, 'source policies are explicit');
SELECT is((SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'selena_registry' AND tablename = 'content_research_metric_snapshots'), 5, 'snapshot policies are explicit');
SELECT is((SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'selena_registry' AND tablename = 'content_research_opportunities'), 5, 'opportunity policies are explicit');
SELECT is((SELECT count(*)::integer FROM pg_policies WHERE schemaname = 'selena_registry' AND tablename = 'content_research_opportunity_decisions'), 5, 'decision policies are explicit');

SELECT is((SELECT count(*)::integer FROM pg_trigger WHERE tgrelid = 'selena_registry.content_research_runs'::regclass AND NOT tgisinternal), 1, 'runs are append-only');
SELECT is((SELECT count(*)::integer FROM pg_trigger WHERE tgrelid = 'selena_registry.content_research_sources'::regclass AND NOT tgisinternal), 1, 'sources are append-only');
SELECT is((SELECT count(*)::integer FROM pg_trigger WHERE tgrelid = 'selena_registry.content_research_metric_snapshots'::regclass AND NOT tgisinternal), 1, 'snapshots are append-only');
SELECT is((SELECT count(*)::integer FROM pg_trigger WHERE tgrelid = 'selena_registry.content_research_opportunities'::regclass AND NOT tgisinternal), 1, 'opportunities are append-only');
SELECT is((SELECT count(*)::integer FROM pg_trigger WHERE tgrelid = 'selena_registry.content_research_opportunity_decisions'::regclass AND NOT tgisinternal), 1, 'decisions are append-only');

INSERT INTO public."user" (id, name, email, created_at, updated_at)
VALUES
  ('research-owner', 'Research Owner', 'research-owner@example.test', now(), now()),
  ('research-member', 'Research Member', 'research-member@example.test', now(), now()),
  ('research-outsider', 'Research Outsider', 'research-outsider@example.test', now(), now());
INSERT INTO public.organization (id, name, slug, created_at)
VALUES
  ('research-org', 'Research Org', 'research-org', now()),
  ('research-other-org', 'Research Other Org', 'research-other-org', now());
INSERT INTO public.member (id, organization_id, user_id, role, created_at)
VALUES
  ('research-owner-membership', 'research-org', 'research-owner', 'owner', now()),
  ('research-member-membership', 'research-org', 'research-member', 'member', now()),
  ('research-outsider-membership', 'research-other-org', 'research-outsider', 'owner', now());
INSERT INTO public.brands (id, name, website, organization_id)
VALUES
  ('research-brand-a', 'Research Brand A', 'https://a.example.test', 'research-org'),
  ('research-brand-b', 'Research Brand B', 'https://b.example.test', 'research-org'),
  ('research-brand-c', 'Research Brand C', 'https://c.example.test', 'research-other-org');

INSERT INTO selena_registry.brand_content_profile_versions (
  id, organization_id, brand_id, version, languages, audience, voice, profile_hash, created_by
) VALUES
  ('20000000-0000-4000-8000-000000000001', 'research-org', 'research-brand-a', 1, ARRAY['en'], '{}'::jsonb, '{}'::jsonb, repeat('a', 64), 'research-owner'),
  ('20000000-0000-4000-8000-000000000002', 'research-org', 'research-brand-b', 1, ARRAY['en'], '{}'::jsonb, '{}'::jsonb, repeat('b', 64), 'research-owner'),
  -- Never decided, and confirmed-then-revoked: research must be refused against both.
  ('20000000-0000-4000-8000-000000000003', 'research-org', 'research-brand-a', 2, ARRAY['en'], '{}'::jsonb, '{}'::jsonb, repeat('d', 64), 'research-owner'),
  ('20000000-0000-4000-8000-000000000004', 'research-org', 'research-brand-a', 3, ARRAY['en'], '{}'::jsonb, '{}'::jsonb, repeat('e', 64), 'research-owner');

INSERT INTO selena_registry.brand_content_profile_decisions (
  organization_id, brand_id, profile_version_id, profile_hash, decision, decided_by, reason, created_at
) VALUES
  ('research-org', 'research-brand-a', '20000000-0000-4000-8000-000000000001', repeat('a', 64), 'CONFIRMED', 'research-owner', NULL, now()),
  ('research-org', 'research-brand-b', '20000000-0000-4000-8000-000000000002', repeat('b', 64), 'CONFIRMED', 'research-owner', NULL, now()),
  ('research-org', 'research-brand-a', '20000000-0000-4000-8000-000000000004', repeat('e', 64), 'CONFIRMED', 'research-owner', NULL, now() - interval '1 minute'),
  ('research-org', 'research-brand-a', '20000000-0000-4000-8000-000000000004', repeat('e', 64), 'REVOKED', 'research-owner', 'Superseded', now());

INSERT INTO selena_registry.content_research_runs (
  id, organization_id, brand_id, profile_version_id, profile_hash, idempotency_key, adapter_id,
  status, pipeline_version, scoring_version, baseline_version, correlation_id,
  started_at, completed_at, created_by
) VALUES (
  '20000000-0000-4000-8000-000000000101', 'research-org', 'research-brand-b',
  '20000000-0000-4000-8000-000000000002', repeat('b', 64), 'seed-brand-b', 'fixture',
  'COMPLETED', 'content.research/v1', 'content.research.scoring/v1', 'radar-baseline-v1',
  '30000000-0000-4000-8000-000000000001', now(), now(), 'research-owner'
);

SET LOCAL ROLE selena_web_runtime;
SELECT selena_registry.set_request_context(
  'research-owner', 'research-org', 'research-brand-a', 'owner',
  '30000000-0000-4000-8000-000000000010', 'web', 'session'
);

SELECT lives_ok(
  $$INSERT INTO selena_registry.content_research_runs (
    id, organization_id, brand_id, profile_version_id, profile_hash, idempotency_key, adapter_id,
    status, pipeline_version, scoring_version, baseline_version, correlation_id,
    started_at, completed_at, created_by
  ) VALUES (
    '20000000-0000-4000-8000-000000000110', 'research-org', 'research-brand-a',
    '20000000-0000-4000-8000-000000000001', repeat('a', 64), 'run-one', 'fixture',
    'COMPLETED', 'content.research/v1', 'content.research.scoring/v1', 'radar-baseline-v1',
    '30000000-0000-4000-8000-000000000011', now(), now(), 'research-owner'
  )$$,
  'a run can be recorded against the brand''s own confirmed profile version'
);
SELECT throws_matching(
  $$INSERT INTO selena_registry.content_research_runs (
    organization_id, brand_id, profile_version_id, profile_hash, idempotency_key, adapter_id,
    status, pipeline_version, scoring_version, baseline_version, correlation_id,
    started_at, completed_at, created_by
  ) VALUES (
    'research-org', 'research-brand-a', '20000000-0000-4000-8000-000000000001', repeat('c', 64),
    'run-stale-hash', 'fixture', 'COMPLETED', 'content.research/v1', 'content.research.scoring/v1',
    'radar-baseline-v1', '30000000-0000-4000-8000-000000000012', now(), now(), 'research-owner'
  )$$,
  'row-level security policy',
  'a run cannot bind a hash the profile version does not carry'
);
SELECT throws_matching(
  $$INSERT INTO selena_registry.content_research_runs (
    organization_id, brand_id, profile_version_id, profile_hash, idempotency_key, adapter_id,
    status, pipeline_version, scoring_version, baseline_version, correlation_id,
    started_at, completed_at, created_by
  ) VALUES (
    'research-org', 'research-brand-a', '20000000-0000-4000-8000-000000000002', repeat('b', 64),
    'run-foreign-profile', 'fixture', 'COMPLETED', 'content.research/v1', 'content.research.scoring/v1',
    'radar-baseline-v1', '30000000-0000-4000-8000-000000000013', now(), now(), 'research-owner'
  )$$,
  'row-level security policy',
  'a run cannot be bound to another brand''s profile version'
);
SELECT throws_matching(
  $$INSERT INTO selena_registry.content_research_runs (
    organization_id, brand_id, profile_version_id, profile_hash, idempotency_key, adapter_id,
    status, pipeline_version, scoring_version, baseline_version, correlation_id,
    started_at, completed_at, created_by
  ) VALUES (
    'research-org', 'research-brand-a', '20000000-0000-4000-8000-000000000003', repeat('d', 64),
    'run-undecided-profile', 'fixture', 'COMPLETED', 'content.research/v1', 'content.research.scoring/v1',
    'radar-baseline-v1', '30000000-0000-4000-8000-000000000015', now(), now(), 'research-owner'
  )$$,
  'row-level security policy',
  'a run cannot be bound to a profile version nobody confirmed'
);
SELECT throws_matching(
  $$INSERT INTO selena_registry.content_research_runs (
    organization_id, brand_id, profile_version_id, profile_hash, idempotency_key, adapter_id,
    status, pipeline_version, scoring_version, baseline_version, correlation_id,
    started_at, completed_at, created_by
  ) VALUES (
    'research-org', 'research-brand-a', '20000000-0000-4000-8000-000000000004', repeat('e', 64),
    'run-revoked-profile', 'fixture', 'COMPLETED', 'content.research/v1', 'content.research.scoring/v1',
    'radar-baseline-v1', '30000000-0000-4000-8000-000000000016', now(), now(), 'research-owner'
  )$$,
  'row-level security policy',
  'a run cannot be bound to a profile version whose confirmation was revoked'
);
SELECT throws_matching(
  $$INSERT INTO selena_registry.content_research_runs (
    organization_id, brand_id, profile_version_id, profile_hash, idempotency_key, adapter_id,
    status, pipeline_version, scoring_version, baseline_version, correlation_id,
    started_at, completed_at, created_by
  ) VALUES (
    'research-org', 'research-brand-a', '20000000-0000-4000-8000-000000000001', repeat('a', 64),
    'run-one', 'fixture', 'COMPLETED', 'content.research/v1', 'content.research.scoring/v1',
    'radar-baseline-v1', '30000000-0000-4000-8000-000000000014', now(), now(), 'research-owner'
  )$$,
  'content_research_runs_brand_idempotency_unique',
  'a repeated idempotency key cannot duplicate a run'
);

SELECT lives_ok(
  $$INSERT INTO selena_registry.content_research_sources (
    id, organization_id, brand_id, run_id, platform, external_id, source_url, adapter_id,
    channel_id, channel_name, title, description, published_at, captured_at, duration_seconds,
    video_type, language, views, likes, comments, transcript_status, baseline_sample_size,
    baseline_confidence, outlier_band, outlier_maturity, relevance_score, candidate_score,
    weight_coverage, score_components, shortlisted, scoring_version, baseline_version, created_by
  ) VALUES (
    '20000000-0000-4000-8000-000000000200', 'research-org', 'research-brand-a',
    '20000000-0000-4000-8000-000000000110', 'youtube', 'source-1', 'https://example.test/1', 'fixture',
    'channel-1', 'Channel One', 'A title', 'A description', now(), now(), 600,
    'LONG', 'en', 20000, 1000, 80, 'AVAILABLE', 16, 'HIGH', 'STRONG', 'MATURE', 0.9, 0.7,
    1.0, '[]'::jsonb, true, 'content.research.scoring/v1', 'radar-baseline-v1', 'research-owner'
  )$$,
  'a source can be recorded against a run of the same brand'
);
SELECT throws_matching(
  $$INSERT INTO selena_registry.content_research_sources (
    organization_id, brand_id, run_id, platform, external_id, source_url, adapter_id,
    channel_id, channel_name, title, description, published_at, captured_at,
    video_type, transcript_status, transcript_failure_reason, baseline_sample_size,
    baseline_confidence, outlier_band, outlier_maturity, relevance_score, candidate_score,
    weight_coverage, score_components, scoring_version, baseline_version, created_by
  ) VALUES (
    'research-org', 'research-brand-a', '20000000-0000-4000-8000-000000000101', 'youtube',
    'source-foreign', 'https://example.test/foreign', 'fixture', 'channel-1', 'Channel One',
    'A title', 'A description', now(), now(), 'LONG', 'UNAVAILABLE', 'NO_TRANSCRIPT', 0,
    'UNAVAILABLE', 'UNAVAILABLE', 'PROVISIONAL', 0.1, 0.1, 0.5, '[]'::jsonb,
    'content.research.scoring/v1', 'radar-baseline-v1', 'research-owner'
  )$$,
  'row-level security policy',
  'a source cannot be attached to another brand''s run'
);
SELECT throws_matching(
  $$INSERT INTO selena_registry.content_research_sources (
    organization_id, brand_id, run_id, platform, external_id, source_url, adapter_id,
    channel_id, channel_name, title, description, published_at, captured_at,
    video_type, transcript_status, transcript_failure_reason, baseline_sample_size,
    baseline_confidence, outlier_band, outlier_maturity, relevance_score, candidate_score,
    weight_coverage, score_components, scoring_version, baseline_version, created_by
  ) VALUES (
    'research-org', 'research-brand-a', '20000000-0000-4000-8000-000000000110', 'youtube',
    'source-1', 'https://example.test/1', 'fixture', 'channel-1', 'Channel One',
    'A title', 'A description', now(), now(), 'LONG', 'UNAVAILABLE', 'NO_TRANSCRIPT', 0,
    'UNAVAILABLE', 'UNAVAILABLE', 'PROVISIONAL', 0.1, 0.1, 0.5, '[]'::jsonb,
    'content.research.scoring/v1', 'radar-baseline-v1', 'research-owner'
  )$$,
  'content_research_sources_run_external_unique',
  'the same source cannot be recorded twice in one run'
);
SELECT throws_matching(
  $$INSERT INTO selena_registry.content_research_sources (
    organization_id, brand_id, run_id, platform, external_id, source_url, adapter_id,
    channel_id, channel_name, title, description, published_at, captured_at,
    video_type, transcript_status, baseline_sample_size,
    baseline_confidence, outlier_band, outlier_maturity, relevance_score, candidate_score,
    weight_coverage, score_components, scoring_version, baseline_version, created_by
  ) VALUES (
    'research-org', 'research-brand-a', '20000000-0000-4000-8000-000000000110', 'youtube',
    'source-2', 'https://example.test/2', 'fixture', 'channel-1', 'Channel One',
    'A title', 'A description', now(), now(), 'LONG', 'UNAVAILABLE', 0,
    'UNAVAILABLE', 'UNAVAILABLE', 'PROVISIONAL', 0.1, 0.1, 0.5, '[]'::jsonb,
    'content.research.scoring/v1', 'radar-baseline-v1', 'research-owner'
  )$$,
  'content_research_sources_transcript_reason',
  'an unavailable transcript must record why'
);

SELECT lives_ok(
  $$INSERT INTO selena_registry.content_research_metric_snapshots (
    id, organization_id, brand_id, source_id, captured_at, views, created_by
  ) VALUES (
    '20000000-0000-4000-8000-000000000300', 'research-org', 'research-brand-a',
    '20000000-0000-4000-8000-000000000200', '2026-02-01T00:00:00Z', 1000, 'research-owner'
  )$$,
  'a metric snapshot can be recorded for the brand''s own source'
);
SELECT throws_matching(
  $$INSERT INTO selena_registry.content_research_metric_snapshots (
    organization_id, brand_id, source_id, captured_at, views, created_by
  ) VALUES (
    'research-org', 'research-brand-a', '20000000-0000-4000-8000-000000000200',
    '2026-02-01T00:00:00Z', 2000, 'research-owner'
  )$$,
  'content_research_metric_snapshots_source_captured_unique',
  'the same capture time cannot be recorded twice for one source'
);

SELECT lives_ok(
  $$INSERT INTO selena_registry.content_research_opportunities (
    id, organization_id, brand_id, run_id, source_id, profile_version_id, profile_hash,
    opportunity_key, proposed_angle, proposed_hook, content_format, rationale,
    evidence_summary, confidence, created_by
  ) VALUES (
    '20000000-0000-4000-8000-000000000400', 'research-org', 'research-brand-a',
    '20000000-0000-4000-8000-000000000110', '20000000-0000-4000-8000-000000000200',
    '20000000-0000-4000-8000-000000000001', repeat('a', 64), 'opportunity-one',
    'An angle', 'A hook', 'LONG_VIDEO', 'Cleared the gate',
    'Channel One - 20,000 views, 3.1x creator baseline (mature)', 'HIGH', 'research-owner'
  )$$,
  'an opportunity can be recorded with its evidence'
);
SELECT throws_matching(
  $$INSERT INTO selena_registry.content_research_opportunities (
    organization_id, brand_id, run_id, source_id, profile_version_id, profile_hash,
    opportunity_key, proposed_angle, proposed_hook, content_format, rationale,
    evidence_summary, confidence, created_by
  ) VALUES (
    'research-org', 'research-brand-a', '20000000-0000-4000-8000-000000000101',
    '20000000-0000-4000-8000-000000000200', '20000000-0000-4000-8000-000000000001',
    repeat('a', 64), 'opportunity-mismatch', 'An angle', 'A hook', 'LONG_VIDEO',
    'Cleared the gate', 'Evidence', 'HIGH', 'research-owner'
  )$$,
  'row-level security policy',
  'an opportunity cannot claim a source that belongs to a different run'
);
SELECT throws_matching(
  $$INSERT INTO selena_registry.content_research_opportunities (
    organization_id, brand_id, run_id, source_id, profile_version_id, profile_hash,
    opportunity_key, proposed_angle, proposed_hook, content_format, rationale,
    evidence_summary, confidence, created_by
  ) VALUES (
    'research-org', 'research-brand-a', '20000000-0000-4000-8000-000000000110',
    '20000000-0000-4000-8000-000000000200', '20000000-0000-4000-8000-000000000001',
    repeat('a', 64), 'opportunity-no-evidence', 'An angle', 'A hook', 'LONG_VIDEO',
    'Cleared the gate', '   ', 'HIGH', 'research-owner'
  )$$,
  'content_research_opportunities_evidence_summary_check',
  'an opportunity cannot be stored without evidence'
);
SELECT throws_matching(
  $$INSERT INTO selena_registry.content_research_opportunities (
    organization_id, brand_id, run_id, source_id, profile_version_id, profile_hash,
    opportunity_key, proposed_angle, proposed_hook, content_format, rationale,
    evidence_summary, confidence, created_by
  ) VALUES (
    'research-org', 'research-brand-a', '20000000-0000-4000-8000-000000000110',
    '20000000-0000-4000-8000-000000000200', '20000000-0000-4000-8000-000000000004',
    repeat('e', 64), 'opportunity-foreign-lineage', 'An angle', 'A hook', 'LONG_VIDEO',
    'Cleared the gate', 'Evidence', 'HIGH', 'research-owner'
  )$$,
  'row-level security policy',
  'an opportunity cannot cite a profile version its own run was not scored against'
);

SELECT selena_registry.set_request_context(
  'research-member', 'research-org', 'research-brand-a', 'member',
  '30000000-0000-4000-8000-000000000020', 'web', 'session'
);
SELECT lives_ok(
  $$INSERT INTO selena_registry.content_research_opportunity_decisions (
    id, organization_id, brand_id, opportunity_id, decision, decided_by
  ) VALUES (
    '20000000-0000-4000-8000-000000000500', 'research-org', 'research-brand-a',
    '20000000-0000-4000-8000-000000000400', 'SAVED', 'research-member'
  )$$,
  'a member can save an opportunity'
);
SELECT throws_matching(
  $$INSERT INTO selena_registry.content_research_opportunity_decisions (
    organization_id, brand_id, opportunity_id, decision, decided_by
  ) VALUES (
    'research-org', 'research-brand-a', '20000000-0000-4000-8000-000000000400',
    'REJECTED', 'research-member'
  )$$,
  'content_research_opportunity_decisions_reject_reason',
  'a rejection requires a reason'
);

SELECT selena_registry.set_request_context(
  'research-owner', 'research-org', 'research-brand-b', 'owner',
  '30000000-0000-4000-8000-000000000030', 'web', 'session'
);
SELECT is((SELECT count(*)::integer FROM selena_registry.content_research_runs WHERE brand_id = 'research-brand-a'), 0, 'cross-brand run SELECT is denied');
SELECT is((SELECT count(*)::integer FROM selena_registry.content_research_sources), 0, 'cross-brand source SELECT is denied');
SELECT is((SELECT count(*)::integer FROM selena_registry.content_research_opportunities), 0, 'cross-brand opportunity SELECT is denied');
SELECT is((SELECT count(*)::integer FROM selena_registry.content_research_opportunity_decisions), 0, 'cross-brand decision SELECT is denied');
SELECT throws_matching(
  $$INSERT INTO selena_registry.content_research_opportunity_decisions (
    organization_id, brand_id, opportunity_id, decision, decided_by
  ) VALUES (
    'research-org', 'research-brand-a', '20000000-0000-4000-8000-000000000400',
    'SAVED', 'research-owner'
  )$$,
  'row-level security policy',
  'another brand cannot decide this brand''s opportunity'
);

SELECT selena_registry.set_request_context(
  'research-outsider', 'research-other-org', 'research-brand-c', 'owner',
  '30000000-0000-4000-8000-000000000040', 'web', 'session'
);
SELECT is((SELECT count(*)::integer FROM selena_registry.content_research_runs), 0, 'cross-organization run SELECT is denied');
SELECT is((SELECT count(*)::integer FROM selena_registry.content_research_opportunities), 0, 'cross-organization opportunity SELECT is denied');

RESET ROLE;

SELECT throws_matching(
  $$UPDATE selena_registry.content_research_runs SET status = 'FAILED' WHERE id = '20000000-0000-4000-8000-000000000110'$$,
  'append-only', 'runs cannot be updated'
);
SELECT throws_matching(
  $$DELETE FROM selena_registry.content_research_runs WHERE id = '20000000-0000-4000-8000-000000000110'$$,
  'append-only', 'runs cannot be deleted'
);
SELECT throws_matching(
  $$UPDATE selena_registry.content_research_sources SET title = 'changed' WHERE id = '20000000-0000-4000-8000-000000000200'$$,
  'append-only', 'sources cannot be updated'
);
SELECT throws_matching(
  $$DELETE FROM selena_registry.content_research_sources WHERE id = '20000000-0000-4000-8000-000000000200'$$,
  'append-only', 'sources cannot be deleted'
);
SELECT throws_matching(
  $$UPDATE selena_registry.content_research_metric_snapshots SET views = 1 WHERE id = '20000000-0000-4000-8000-000000000300'$$,
  'append-only', 'snapshots cannot be updated'
);
SELECT throws_matching(
  $$DELETE FROM selena_registry.content_research_metric_snapshots WHERE id = '20000000-0000-4000-8000-000000000300'$$,
  'append-only', 'snapshots cannot be deleted'
);
SELECT throws_matching(
  $$UPDATE selena_registry.content_research_opportunities SET proposed_hook = 'changed' WHERE id = '20000000-0000-4000-8000-000000000400'$$,
  'append-only', 'opportunities cannot be updated'
);
SELECT throws_matching(
  $$DELETE FROM selena_registry.content_research_opportunities WHERE id = '20000000-0000-4000-8000-000000000400'$$,
  'append-only', 'opportunities cannot be deleted'
);
SELECT throws_matching(
  $$UPDATE selena_registry.content_research_opportunity_decisions SET reason = 'changed' WHERE id = '20000000-0000-4000-8000-000000000500'$$,
  'append-only', 'decisions cannot be updated'
);
SELECT throws_matching(
  $$DELETE FROM selena_registry.content_research_opportunity_decisions WHERE id = '20000000-0000-4000-8000-000000000500'$$,
  'append-only', 'decisions cannot be deleted'
);

SELECT is(
  (SELECT external_provider_calls FROM selena_registry.content_research_runs WHERE id = '20000000-0000-4000-8000-000000000110'),
  0,
  'the recorded run made no external provider call'
);
SELECT is(
  (
    (SELECT count(*) FROM selena_registry.channel_accounts WHERE organization_id = 'research-org') +
    (SELECT count(*) FROM selena_release.release_intents WHERE organization_id = 'research-org') +
    (SELECT count(*) FROM selena_release.outbox_events WHERE organization_id = 'research-org') +
    (SELECT count(*) FROM selena_release.publication_attempts WHERE organization_id = 'research-org')
  )::integer,
  0,
  'Slice 2 creates no account, release intent, outbox event or publication attempt'
);

SELECT * FROM finish();
ROLLBACK;

SET ROLE selena_schema_owner;

CREATE TYPE selena_registry.content_research_run_status AS ENUM ('COMPLETED', 'PARTIAL', 'FAILED');
CREATE TYPE selena_registry.content_transcript_status AS ENUM (
  'PENDING', 'AVAILABLE', 'UNAVAILABLE', 'BLOCKED', 'FAILED', 'UNSUPPORTED'
);
CREATE TYPE selena_registry.content_opportunity_decision AS ENUM ('SAVED', 'REJECTED', 'SENT_TO_CREATION');

CREATE TABLE selena_registry.content_research_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id text NOT NULL REFERENCES public.organization(id),
  brand_id text NOT NULL REFERENCES public.brands(id),
  profile_version_id uuid NOT NULL REFERENCES selena_registry.brand_content_profile_versions(id),
  profile_hash text NOT NULL CHECK (profile_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) > 0),
  adapter_id text NOT NULL CHECK (adapter_id IN ('fixture', 'video-radar')),
  status selena_registry.content_research_run_status NOT NULL,
  pipeline_version text NOT NULL,
  scoring_version text NOT NULL,
  baseline_version text NOT NULL,
  counters jsonb DEFAULT '{}'::jsonb NOT NULL CHECK (jsonb_typeof(counters) = 'object'),
  -- Normalized codes only. A provider body must never reach this column.
  failures jsonb DEFAULT '[]'::jsonb NOT NULL CHECK (jsonb_typeof(failures) = 'array'),
  correlation_id uuid NOT NULL,
  external_provider_calls integer DEFAULT 0 NOT NULL CHECK (external_provider_calls >= 0),
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT content_research_runs_completed_after_start CHECK (completed_at >= started_at)
);
CREATE UNIQUE INDEX content_research_runs_brand_idempotency_unique
  ON selena_registry.content_research_runs (brand_id, idempotency_key);
CREATE INDEX content_research_runs_brand_idx ON selena_registry.content_research_runs (brand_id, created_at DESC);
CREATE INDEX content_research_runs_org_idx ON selena_registry.content_research_runs (organization_id);
CREATE INDEX content_research_runs_profile_idx ON selena_registry.content_research_runs (profile_version_id);

CREATE TABLE selena_registry.content_research_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id text NOT NULL REFERENCES public.organization(id),
  brand_id text NOT NULL REFERENCES public.brands(id),
  run_id uuid NOT NULL REFERENCES selena_registry.content_research_runs(id),
  platform text NOT NULL CHECK (platform = 'youtube'),
  external_id text NOT NULL CHECK (length(btrim(external_id)) > 0),
  source_url text NOT NULL CHECK (length(btrim(source_url)) > 0),
  adapter_id text NOT NULL CHECK (adapter_id IN ('fixture', 'video-radar')),
  channel_id text NOT NULL,
  channel_name text NOT NULL,
  title text NOT NULL,
  description text NOT NULL,
  published_at timestamptz NOT NULL,
  captured_at timestamptz NOT NULL,
  duration_seconds integer CHECK (duration_seconds IS NULL OR duration_seconds > 0),
  video_type text NOT NULL CHECK (video_type IN ('SHORT', 'LONG', 'UNKNOWN')),
  language text,
  views bigint CHECK (views IS NULL OR views >= 0),
  likes bigint CHECK (likes IS NULL OR likes >= 0),
  comments bigint CHECK (comments IS NULL OR comments >= 0),
  -- Retrieval state only. Stage 1 stores no transcript text, so no run can turn
  -- an unavailable transcript into text nobody has the rights to.
  transcript_status selena_registry.content_transcript_status NOT NULL,
  transcript_language text,
  transcript_failure_reason text,
  -- A median over an even sample is the mean of the middle two, so this is
  -- fractional. Rounding it would distort the denominator every ratio divides by.
  baseline_views double precision CHECK (baseline_views IS NULL OR baseline_views >= 0),
  baseline_sample_size integer NOT NULL CHECK (baseline_sample_size >= 0),
  baseline_confidence text NOT NULL CHECK (baseline_confidence IN ('HIGH', 'MEDIUM', 'LOW', 'UNAVAILABLE')),
  outlier_ratio double precision CHECK (outlier_ratio IS NULL OR outlier_ratio >= 0),
  outlier_band text NOT NULL CHECK (
    outlier_band IN ('UNAVAILABLE', 'NORMAL', 'INTERESTING', 'STRONG', 'MAJOR', 'EXCEPTIONAL')
  ),
  outlier_maturity text NOT NULL CHECK (outlier_maturity IN ('PROVISIONAL', 'MATURE')),
  relevance_score double precision NOT NULL CHECK (relevance_score BETWEEN 0 AND 1),
  candidate_score double precision NOT NULL CHECK (candidate_score BETWEEN 0 AND 1),
  weight_coverage double precision NOT NULL CHECK (weight_coverage BETWEEN 0 AND 1),
  score_components jsonb NOT NULL CHECK (jsonb_typeof(score_components) = 'array'),
  gate_reasons jsonb DEFAULT '[]'::jsonb NOT NULL CHECK (jsonb_typeof(gate_reasons) = 'array'),
  shortlisted boolean DEFAULT false NOT NULL,
  scoring_version text NOT NULL,
  baseline_version text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT content_research_sources_transcript_reason CHECK (
    transcript_status = 'AVAILABLE' OR transcript_failure_reason IS NOT NULL
  )
);
CREATE UNIQUE INDEX content_research_sources_run_external_unique
  ON selena_registry.content_research_sources (run_id, external_id);
CREATE INDEX content_research_sources_brand_idx
  ON selena_registry.content_research_sources (brand_id, shortlisted, candidate_score DESC);
CREATE INDEX content_research_sources_org_idx ON selena_registry.content_research_sources (organization_id);

CREATE TABLE selena_registry.content_research_metric_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id text NOT NULL REFERENCES public.organization(id),
  brand_id text NOT NULL REFERENCES public.brands(id),
  source_id uuid NOT NULL REFERENCES selena_registry.content_research_sources(id),
  captured_at timestamptz NOT NULL,
  views bigint CHECK (views IS NULL OR views >= 0),
  likes bigint CHECK (likes IS NULL OR likes >= 0),
  comments bigint CHECK (comments IS NULL OR comments >= 0),
  created_by text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX content_research_metric_snapshots_source_captured_unique
  ON selena_registry.content_research_metric_snapshots (source_id, captured_at);
CREATE INDEX content_research_metric_snapshots_brand_idx
  ON selena_registry.content_research_metric_snapshots (brand_id, captured_at);
CREATE INDEX content_research_metric_snapshots_org_idx
  ON selena_registry.content_research_metric_snapshots (organization_id);

CREATE TABLE selena_registry.content_research_opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id text NOT NULL REFERENCES public.organization(id),
  brand_id text NOT NULL REFERENCES public.brands(id),
  run_id uuid NOT NULL REFERENCES selena_registry.content_research_runs(id),
  source_id uuid NOT NULL REFERENCES selena_registry.content_research_sources(id),
  profile_version_id uuid NOT NULL REFERENCES selena_registry.brand_content_profile_versions(id),
  profile_hash text NOT NULL CHECK (profile_hash ~ '^[a-f0-9]{64}$'),
  opportunity_key text NOT NULL CHECK (length(btrim(opportunity_key)) > 0),
  proposed_angle text NOT NULL CHECK (length(btrim(proposed_angle)) > 0),
  proposed_hook text NOT NULL CHECK (length(btrim(proposed_hook)) > 0),
  content_format text NOT NULL CHECK (content_format IN ('SHORT_VIDEO', 'LONG_VIDEO')),
  rationale text NOT NULL,
  -- An opportunity without evidence is a suggestion, which is what this product
  -- exists not to produce.
  evidence_summary text NOT NULL CHECK (length(btrim(evidence_summary)) > 0),
  confidence text NOT NULL CHECK (confidence IN ('HIGH', 'MEDIUM', 'LOW')),
  fact_requirements jsonb DEFAULT '[]'::jsonb NOT NULL CHECK (jsonb_typeof(fact_requirements) = 'array'),
  created_by text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);
-- Scoped to the run rather than the brand: re-running research over the same
-- profile legitimately re-proposes the same source, and that proposal carries
-- the new run's evidence rather than replacing the old one.
CREATE UNIQUE INDEX content_research_opportunities_run_key_unique
  ON selena_registry.content_research_opportunities (run_id, opportunity_key);
CREATE INDEX content_research_opportunities_run_idx
  ON selena_registry.content_research_opportunities (run_id, created_at);
CREATE INDEX content_research_opportunities_brand_idx
  ON selena_registry.content_research_opportunities (brand_id, created_at DESC);
CREATE INDEX content_research_opportunities_org_idx
  ON selena_registry.content_research_opportunities (organization_id);

CREATE TABLE selena_registry.content_research_opportunity_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id text NOT NULL REFERENCES public.organization(id),
  brand_id text NOT NULL REFERENCES public.brands(id),
  opportunity_id uuid NOT NULL REFERENCES selena_registry.content_research_opportunities(id),
  decision selena_registry.content_opportunity_decision NOT NULL,
  reason text,
  decided_by text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT content_research_opportunity_decisions_reject_reason
    CHECK (decision <> 'REJECTED' OR (reason IS NOT NULL AND length(btrim(reason)) > 0))
);
CREATE INDEX content_research_opportunity_decisions_opportunity_idx
  ON selena_registry.content_research_opportunity_decisions (opportunity_id, created_at);
CREATE INDEX content_research_opportunity_decisions_brand_idx
  ON selena_registry.content_research_opportunity_decisions (brand_id, created_at);
CREATE INDEX content_research_opportunity_decisions_org_idx
  ON selena_registry.content_research_opportunity_decisions (organization_id);

ALTER TABLE selena_registry.content_research_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE selena_registry.content_research_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE selena_registry.content_research_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE selena_registry.content_research_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE selena_registry.content_research_metric_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE selena_registry.content_research_metric_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE selena_registry.content_research_opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE selena_registry.content_research_opportunities FORCE ROW LEVEL SECURITY;
ALTER TABLE selena_registry.content_research_opportunity_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE selena_registry.content_research_opportunity_decisions FORCE ROW LEVEL SECURITY;

CREATE POLICY content_research_runs_web_select ON selena_registry.content_research_runs
  FOR SELECT TO selena_web_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['web']));
CREATE POLICY content_research_runs_web_insert ON selena_registry.content_research_runs
  FOR INSERT TO selena_web_runtime
  WITH CHECK (
    created_by = current_setting('app.selena_actor_id', true)
    AND selena_registry.can_write_brand(organization_id, brand_id, ARRAY['web'])
    -- A run is bound to a profile version of the same brand carrying the same
    -- hash.
    -- Every reference to the new row is fully qualified: an unqualified name here
    -- resolves against the subquery's own table, which turns a cross-tenant guard
    -- into a comparison of a column with itself.
    AND EXISTS (
      SELECT 1 FROM selena_registry.brand_content_profile_versions version
      WHERE version.id = selena_registry.content_research_runs.profile_version_id
        AND version.organization_id = selena_registry.content_research_runs.organization_id
        AND version.brand_id = selena_registry.content_research_runs.brand_id
        AND version.profile_hash = selena_registry.content_research_runs.profile_hash
    )
    -- ...and that version's newest decision is CONFIRMED. The application checks
    -- this too, but an application check is not the invariant: without this
    -- predicate the runtime could store research against a draft or a revoked
    -- profile, which is the lineage the whole slice exists to preserve.
    AND (
      SELECT decision
      FROM selena_registry.brand_content_profile_decisions decided
      WHERE decided.profile_version_id = selena_registry.content_research_runs.profile_version_id
      ORDER BY decided.created_at DESC, decided.id DESC
      LIMIT 1
    ) = 'CONFIRMED'
  );
CREATE POLICY content_research_runs_web_update_denied ON selena_registry.content_research_runs
  FOR UPDATE TO selena_web_runtime USING (false) WITH CHECK (false);
CREATE POLICY content_research_runs_web_delete_denied ON selena_registry.content_research_runs
  FOR DELETE TO selena_web_runtime USING (false);

CREATE POLICY content_research_sources_web_select ON selena_registry.content_research_sources
  FOR SELECT TO selena_web_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['web']));
CREATE POLICY content_research_sources_web_insert ON selena_registry.content_research_sources
  FOR INSERT TO selena_web_runtime
  WITH CHECK (
    created_by = current_setting('app.selena_actor_id', true)
    AND selena_registry.can_write_brand(organization_id, brand_id, ARRAY['web'])
    AND EXISTS (
      SELECT 1 FROM selena_registry.content_research_runs run
      WHERE run.id = selena_registry.content_research_sources.run_id
        AND run.organization_id = selena_registry.content_research_sources.organization_id
        AND run.brand_id = selena_registry.content_research_sources.brand_id
    )
  );
CREATE POLICY content_research_sources_web_update_denied ON selena_registry.content_research_sources
  FOR UPDATE TO selena_web_runtime USING (false) WITH CHECK (false);
CREATE POLICY content_research_sources_web_delete_denied ON selena_registry.content_research_sources
  FOR DELETE TO selena_web_runtime USING (false);

CREATE POLICY content_research_metric_snapshots_web_select ON selena_registry.content_research_metric_snapshots
  FOR SELECT TO selena_web_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['web']));
CREATE POLICY content_research_metric_snapshots_web_insert ON selena_registry.content_research_metric_snapshots
  FOR INSERT TO selena_web_runtime
  WITH CHECK (
    created_by = current_setting('app.selena_actor_id', true)
    AND selena_registry.can_write_brand(organization_id, brand_id, ARRAY['web'])
    AND EXISTS (
      SELECT 1 FROM selena_registry.content_research_sources source
      WHERE source.id = selena_registry.content_research_metric_snapshots.source_id
        AND source.organization_id = selena_registry.content_research_metric_snapshots.organization_id
        AND source.brand_id = selena_registry.content_research_metric_snapshots.brand_id
    )
  );
CREATE POLICY content_research_metric_snapshots_web_update_denied ON selena_registry.content_research_metric_snapshots
  FOR UPDATE TO selena_web_runtime USING (false) WITH CHECK (false);
CREATE POLICY content_research_metric_snapshots_web_delete_denied ON selena_registry.content_research_metric_snapshots
  FOR DELETE TO selena_web_runtime USING (false);

CREATE POLICY content_research_opportunities_web_select ON selena_registry.content_research_opportunities
  FOR SELECT TO selena_web_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['web']));
CREATE POLICY content_research_opportunities_web_insert ON selena_registry.content_research_opportunities
  FOR INSERT TO selena_web_runtime
  WITH CHECK (
    created_by = current_setting('app.selena_actor_id', true)
    AND selena_registry.can_write_brand(organization_id, brand_id, ARRAY['web'])
    AND EXISTS (
      SELECT 1 FROM selena_registry.content_research_sources source
      WHERE source.id = selena_registry.content_research_opportunities.source_id
        AND source.run_id = selena_registry.content_research_opportunities.run_id
        AND source.organization_id = selena_registry.content_research_opportunities.organization_id
        AND source.brand_id = selena_registry.content_research_opportunities.brand_id
    )
    -- The opportunity repeats its run's profile lineage, so it must be the same
    -- lineage. Otherwise an opportunity could cite a profile version its own run
    -- was never scored against.
    AND EXISTS (
      SELECT 1 FROM selena_registry.content_research_runs run
      WHERE run.id = selena_registry.content_research_opportunities.run_id
        AND run.profile_version_id = selena_registry.content_research_opportunities.profile_version_id
        AND run.profile_hash = selena_registry.content_research_opportunities.profile_hash
    )
  );
CREATE POLICY content_research_opportunities_web_update_denied ON selena_registry.content_research_opportunities
  FOR UPDATE TO selena_web_runtime USING (false) WITH CHECK (false);
CREATE POLICY content_research_opportunities_web_delete_denied ON selena_registry.content_research_opportunities
  FOR DELETE TO selena_web_runtime USING (false);

CREATE POLICY content_research_opportunity_decisions_web_select ON selena_registry.content_research_opportunity_decisions
  FOR SELECT TO selena_web_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['web']));
CREATE POLICY content_research_opportunity_decisions_web_insert ON selena_registry.content_research_opportunity_decisions
  FOR INSERT TO selena_web_runtime
  WITH CHECK (
    decided_by = current_setting('app.selena_actor_id', true)
    AND selena_registry.can_write_brand(organization_id, brand_id, ARRAY['web'])
    AND EXISTS (
      SELECT 1 FROM selena_registry.content_research_opportunities opportunity
      WHERE opportunity.id = selena_registry.content_research_opportunity_decisions.opportunity_id
        AND opportunity.organization_id = selena_registry.content_research_opportunity_decisions.organization_id
        AND opportunity.brand_id = selena_registry.content_research_opportunity_decisions.brand_id
    )
  );
CREATE POLICY content_research_opportunity_decisions_web_update_denied
  ON selena_registry.content_research_opportunity_decisions
  FOR UPDATE TO selena_web_runtime USING (false) WITH CHECK (false);
CREATE POLICY content_research_opportunity_decisions_web_delete_denied
  ON selena_registry.content_research_opportunity_decisions
  FOR DELETE TO selena_web_runtime USING (false);

CREATE POLICY content_research_runs_schema_owner_select ON selena_registry.content_research_runs
  FOR SELECT TO selena_schema_owner USING (true);
CREATE POLICY content_research_sources_schema_owner_select ON selena_registry.content_research_sources
  FOR SELECT TO selena_schema_owner USING (true);
CREATE POLICY content_research_metric_snapshots_schema_owner_select
  ON selena_registry.content_research_metric_snapshots
  FOR SELECT TO selena_schema_owner USING (true);
CREATE POLICY content_research_opportunities_schema_owner_select ON selena_registry.content_research_opportunities
  FOR SELECT TO selena_schema_owner USING (true);
CREATE POLICY content_research_opportunity_decisions_schema_owner_select
  ON selena_registry.content_research_opportunity_decisions
  FOR SELECT TO selena_schema_owner USING (true);

CREATE TRIGGER content_research_runs_append_only
  BEFORE UPDATE OR DELETE ON selena_registry.content_research_runs
  FOR EACH ROW EXECUTE FUNCTION selena_audit.reject_immutable_mutation();
CREATE TRIGGER content_research_sources_append_only
  BEFORE UPDATE OR DELETE ON selena_registry.content_research_sources
  FOR EACH ROW EXECUTE FUNCTION selena_audit.reject_immutable_mutation();
CREATE TRIGGER content_research_metric_snapshots_append_only
  BEFORE UPDATE OR DELETE ON selena_registry.content_research_metric_snapshots
  FOR EACH ROW EXECUTE FUNCTION selena_audit.reject_immutable_mutation();
CREATE TRIGGER content_research_opportunities_append_only
  BEFORE UPDATE OR DELETE ON selena_registry.content_research_opportunities
  FOR EACH ROW EXECUTE FUNCTION selena_audit.reject_immutable_mutation();
CREATE TRIGGER content_research_opportunity_decisions_append_only
  BEFORE UPDATE OR DELETE ON selena_registry.content_research_opportunity_decisions
  FOR EACH ROW EXECUTE FUNCTION selena_audit.reject_immutable_mutation();

GRANT USAGE ON TYPE selena_registry.content_research_run_status TO selena_web_runtime;
GRANT USAGE ON TYPE selena_registry.content_transcript_status TO selena_web_runtime;
GRANT USAGE ON TYPE selena_registry.content_opportunity_decision TO selena_web_runtime;
GRANT SELECT, INSERT ON selena_registry.content_research_runs TO selena_web_runtime;
GRANT SELECT, INSERT ON selena_registry.content_research_sources TO selena_web_runtime;
GRANT SELECT, INSERT ON selena_registry.content_research_metric_snapshots TO selena_web_runtime;
GRANT SELECT, INSERT ON selena_registry.content_research_opportunities TO selena_web_runtime;
GRANT SELECT, INSERT ON selena_registry.content_research_opportunity_decisions TO selena_web_runtime;

RESET ROLE;

SET ROLE selena_schema_owner;

-- Numbered 0041 rather than 0039, for the reason recorded in DECISION_LOG.md and
-- gated in OWNER_GATES.md: growth/ge1-4-local-slice already holds 0038 and 0039,
-- and Drizzle applies by journal `when` as a strict high-water mark.

CREATE TYPE selena_registry.content_kind AS ENUM ('GENERIC_POST', 'YOUTUBE_VIDEO');
CREATE TYPE selena_registry.content_workflow_stage AS ENUM (
  'DRAFT', 'IDEA_SELECTED', 'SCRIPT_DRAFTED', 'IN_REVIEW', 'APPROVED', 'ARCHIVED'
);
CREATE TYPE selena_registry.generation_run_kind AS ENUM ('IDEAS', 'SCRIPT', 'SCRIPT_REVISION');
CREATE TYPE selena_registry.generation_run_status AS ENUM ('COMPLETED', 'FAILED');
CREATE TYPE selena_registry.editorial_decision AS ENUM ('APPROVED', 'CHANGES_REQUESTED', 'REJECTED');

-- ── content_items: kind, channel and workflow stage ──────────────────────────
-- Every column is defaulted, so existing rows keep their meaning: a row written
-- before this migration is a GENERIC_POST in DRAFT, which is what it was.

ALTER TABLE selena_registry.content_items
  ADD COLUMN content_kind selena_registry.content_kind DEFAULT 'GENERIC_POST' NOT NULL,
  ADD COLUMN content_channel_id uuid REFERENCES selena_registry.content_channels(id),
  ADD COLUMN workflow_stage selena_registry.content_workflow_stage DEFAULT 'DRAFT' NOT NULL;

-- A YouTube video is content for a channel. Without one there is nothing the
-- draft is for, and `content_channels` only admits DRAFT_ONLY channels, so this
-- also carries the publication-mode requirement without restating it.
ALTER TABLE selena_registry.content_items
  ADD CONSTRAINT content_items_youtube_requires_channel
  CHECK (content_kind <> 'YOUTUBE_VIDEO' OR content_channel_id IS NOT NULL);

CREATE INDEX content_items_kind_stage_idx
  ON selena_registry.content_items (brand_id, content_kind, workflow_stage);

-- ── generation_runs ─────────────────────────────────────────────────────────
-- Provider output is untrusted until it passes the transferred contract. A run
-- that produced invalid output is recorded as a FAILED run with a normalized
-- code and no output; there is no state in which unvalidated output is stored.

CREATE TABLE selena_registry.generation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id text NOT NULL REFERENCES public.organization(id),
  brand_id text NOT NULL REFERENCES public.brands(id),
  kind selena_registry.generation_run_kind NOT NULL,
  status selena_registry.generation_run_status NOT NULL,
  adapter_id text NOT NULL CHECK (adapter_id IN ('fixture', 'gemini')),
  -- Recorded even when no call was made, so a run says which provider it would
  -- have reached rather than leaving that to be inferred from the adapter name.
  provider text NOT NULL CHECK (provider IN ('none', 'gemini')),
  model text,
  prompt_version text NOT NULL,
  schema_version text NOT NULL,
  pipeline_version text NOT NULL,
  -- Hashes, not payloads. The input snapshot is what the run was given; storing
  -- it as a digest keeps a prompt and a provider body out of the database while
  -- still making two runs comparable.
  input_snapshot_hash text NOT NULL CHECK (input_snapshot_hash ~ '^[a-f0-9]{64}$'),
  output_hash text CHECK (output_hash IS NULL OR output_hash ~ '^[a-f0-9]{64}$'),
  validated_output jsonb,
  profile_version_id uuid NOT NULL REFERENCES selena_registry.brand_content_profile_versions(id),
  profile_hash text NOT NULL CHECK (profile_hash ~ '^[a-f0-9]{64}$'),
  research_run_id uuid REFERENCES selena_registry.content_research_runs(id),
  research_opportunity_id uuid REFERENCES selena_registry.content_research_opportunities(id),
  -- Which draft the run was for. An IDEAS run has none, because the draft is
  -- what selecting one of its ideas creates; a script run always has one. A
  -- failed script run therefore still says which draft it failed on, and an
  -- idempotency key can be checked against the request it was used for rather
  -- than only against the brand.
  content_item_id uuid REFERENCES selena_registry.content_items(id),
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) > 0),
  correlation_id uuid NOT NULL,
  requested_call_count integer DEFAULT 0 NOT NULL CHECK (requested_call_count >= 0),
  actual_call_count integer DEFAULT 0 NOT NULL CHECK (actual_call_count >= 0),
  -- Cost is nullable rather than zero-defaulted: "we did not spend" and "we do
  -- not know what this cost" are different facts, and Stage 1 only ever records
  -- the first.
  estimated_cost_micros bigint CHECK (estimated_cost_micros IS NULL OR estimated_cost_micros >= 0),
  actual_cost_micros bigint CHECK (actual_cost_micros IS NULL OR actual_cost_micros >= 0),
  -- Normalized codes only, for the same reason the research registry constrains
  -- its failure reasons: this is a field a provider string could reach.
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT generation_runs_completed_after_start CHECK (completed_at >= started_at),
  -- A completed run has output and no error; a failed run has an error and no
  -- output. Anything else is a record that cannot be read either way.
  CONSTRAINT generation_runs_outcome_consistent CHECK (
    (status = 'COMPLETED' AND validated_output IS NOT NULL AND output_hash IS NOT NULL AND error_code IS NULL)
    OR (status = 'FAILED' AND validated_output IS NULL AND output_hash IS NULL AND error_code IS NOT NULL)
  ),
  CONSTRAINT generation_runs_calls_within_request CHECK (actual_call_count <= requested_call_count),
  CONSTRAINT generation_runs_item_matches_kind CHECK (
    (kind = 'IDEAS' AND content_item_id IS NULL)
    OR (kind <> 'IDEAS' AND content_item_id IS NOT NULL)
  ),
  -- Stage 1 spends nothing, and the schema says so rather than the code alone.
  -- Written against the counters rather than against the provider name: the
  -- application records every Stage 1 run as provider 'none', so a disjunct on
  -- the name is always true and constrains nothing.
  CONSTRAINT generation_runs_stage1_no_spend CHECK (
    actual_call_count = 0 AND COALESCE(actual_cost_micros, 0) = 0
  )
);
CREATE UNIQUE INDEX generation_runs_brand_idempotency_unique
  ON selena_registry.generation_runs (brand_id, idempotency_key);
CREATE INDEX generation_runs_brand_idx ON selena_registry.generation_runs (brand_id, created_at DESC);
CREATE INDEX generation_runs_opportunity_idx
  ON selena_registry.generation_runs (research_opportunity_id, created_at DESC);
CREATE INDEX generation_runs_org_idx ON selena_registry.generation_runs (organization_id);
CREATE INDEX generation_runs_item_idx
  ON selena_registry.generation_runs (content_item_id, created_at DESC);

-- ── which idea a draft is ───────────────────────────────────────────────────
-- Identity by position in the run rather than by title: a title is editable and
-- need not be unique, so resolving a draft back to its idea by name can silently
-- find the wrong one and hash the wrong evidence into the version.

ALTER TABLE selena_registry.content_items
  ADD COLUMN selected_idea_index integer CHECK (selected_idea_index IS NULL OR selected_idea_index BETWEEN 0 AND 5),
  ADD COLUMN idea_generation_run_id uuid REFERENCES selena_registry.generation_runs(id);

ALTER TABLE selena_registry.content_items
  ADD CONSTRAINT content_items_idea_selection_complete CHECK (
    (selected_idea_index IS NULL AND idea_generation_run_id IS NULL)
    OR (selected_idea_index IS NOT NULL AND idea_generation_run_id IS NOT NULL)
  );

-- One draft per idea, so an ordinary retry of a selection finds the existing
-- draft instead of creating a second one for the same idea.
CREATE UNIQUE INDEX content_items_idea_selection_unique
  ON selena_registry.content_items (idea_generation_run_id, selected_idea_index)
  WHERE idea_generation_run_id IS NOT NULL;

-- ── content_versions: structure and lineage ─────────────────────────────────
-- Existing rows are legacy.text/v1 with selena.content/v1 hashes. Nothing here
-- recomputes a stored hash: an approval was given against a digest, and changing
-- the digest afterwards would rewrite what was approved.

ALTER TABLE selena_registry.content_versions
  ADD COLUMN format_version text DEFAULT 'legacy.text/v1' NOT NULL,
  ADD COLUMN structured_body jsonb,
  ADD COLUMN project_profile_version_id uuid REFERENCES selena_registry.brand_content_profile_versions(id),
  ADD COLUMN research_run_id uuid REFERENCES selena_registry.content_research_runs(id),
  ADD COLUMN generation_run_id uuid REFERENCES selena_registry.generation_runs(id),
  ADD COLUMN hash_version text DEFAULT 'selena.content/v1' NOT NULL;

ALTER TABLE selena_registry.content_versions
  ADD CONSTRAINT content_versions_format_known
  CHECK (format_version IN ('legacy.text/v1', 'content.youtube-video/v1')),
  ADD CONSTRAINT content_versions_hash_version_known
  CHECK (hash_version IN ('selena.content/v1', 'content.workflow/v2'));

-- The two shapes are kept apart at the boundary rather than by convention. A
-- structured version must carry its document and its profile lineage and must be
-- hashed as V2; a legacy version must carry none of it and stay V1. A row that
-- is half of each would be a version nobody can verify.
ALTER TABLE selena_registry.content_versions
  ADD CONSTRAINT content_versions_structure_matches_format CHECK (
    (
      format_version = 'legacy.text/v1'
      AND hash_version = 'selena.content/v1'
      AND structured_body IS NULL
      AND project_profile_version_id IS NULL
      AND research_run_id IS NULL
      AND generation_run_id IS NULL
    )
    OR (
      format_version = 'content.youtube-video/v1'
      AND hash_version = 'content.workflow/v2'
      AND structured_body IS NOT NULL
      AND jsonb_typeof(structured_body) = 'object'
      AND structured_body ->> 'schema' = 'content.youtube-video/v1'
      AND project_profile_version_id IS NOT NULL
      AND research_run_id IS NOT NULL
      -- A structured version is produced by a generation run. Without one it is
      -- a document with no account of where it came from.
      AND generation_run_id IS NOT NULL
    )
  );

CREATE INDEX content_versions_generation_run_idx
  ON selena_registry.content_versions (generation_run_id);

-- ── editorial_approvals ─────────────────────────────────────────────────────
-- Editorial review is not publishing approval. This table deliberately has no
-- channel_account_id: the existing selena_registry.approvals table is what a
-- release manifest reads, and giving this one the same shape would eventually
-- let an editorial decision be mistaken for permission to publish.

CREATE TABLE selena_registry.editorial_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id text NOT NULL REFERENCES public.organization(id),
  brand_id text NOT NULL REFERENCES public.brands(id),
  content_version_id uuid NOT NULL REFERENCES selena_registry.content_versions(id),
  decision selena_registry.editorial_decision NOT NULL,
  -- The four hashes an editorial decision is about. A decision that does not
  -- name what it was given is not reviewable later.
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  profile_hash text NOT NULL CHECK (profile_hash ~ '^[a-f0-9]{64}$'),
  evidence_hash text NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
  asset_bundle_hash text NOT NULL CHECK (asset_bundle_hash ~ '^[a-f0-9]{64}$'),
  reason text CHECK (reason IS NULL OR length(btrim(reason)) > 0),
  decided_by text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  -- Rejecting or asking for changes without saying why leaves the author with a
  -- verdict and no next step.
  CONSTRAINT editorial_approvals_reason_required CHECK (
    decision = 'APPROVED' OR reason IS NOT NULL
  )
);
CREATE INDEX editorial_approvals_version_idx
  ON selena_registry.editorial_approvals (content_version_id, created_at DESC);
CREATE INDEX editorial_approvals_brand_idx
  ON selena_registry.editorial_approvals (brand_id, created_at DESC);
CREATE INDEX editorial_approvals_org_idx ON selena_registry.editorial_approvals (organization_id);

-- ── release fail-closed for YOUTUBE_VIDEO ───────────────────────────────────
-- Specification 9.4. The rule is a condition rather than a flat refusal so it
-- relaxes on its own when a real path exists, and the condition has to name both
-- halves the specification names: an allowlisted YouTube channel account AND a
-- YouTube publication adapter.
--
-- 0033 restricts binding providers to 'postiz' and 'blotato', which constrains
-- which provider NAMES may appear — not which platform a binding serves. An
-- ordinary postiz binding attached to a YouTube channel account therefore says
-- nothing about YouTube publication, and a gate that accepted it would open on
-- a routing decision nobody made about YouTube at all.
--
-- So the predicate names the adapter. No such provider value is admitted by
-- 0033's CHECK today, which is what holds the gate shut; introducing one is a
-- deliberate migration, exactly as 0033 intended.

-- 0021 gave selena_schema_owner a SELECT policy on content_versions but not on
-- content_items, so a SECURITY DEFINER function owned by that role could read the
-- version and see nothing of the item. Without this the guard below reads a NULL
-- kind for every row and waves it through: a gate whose own lookup is blocked
-- fails open, which is the worst way for a gate to fail.
CREATE POLICY content_items_schema_owner_select ON selena_registry.content_items
  FOR SELECT TO selena_schema_owner USING (true);

CREATE FUNCTION selena_release.reject_unsupported_youtube_release() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  is_youtube boolean;
  found boolean;
BEGIN
  -- The version's own format is read first, and the item's kind second. A
  -- content_version admits no UPDATE and no DELETE from any runtime role, so
  -- format_version is a statement that cannot be edited after the fact;
  -- content_kind is a column the ordinary web runtime may UPDATE through
  -- content_items_web_update. A gate that consulted only the mutable one would
  -- be opened by flipping the kind, releasing, and flipping it back — no
  -- operator, no gateway, no new provider value. The kind is kept in the
  -- condition because a YouTube draft whose version is still legacy text is a
  -- YouTube release too.
  SELECT
      version.format_version = 'content.youtube-video/v1'
        OR item.content_kind = 'YOUTUBE_VIDEO',
      true
    INTO is_youtube, found
  FROM selena_registry.content_versions version
  JOIN selena_registry.content_items item ON item.id = version.content_id
  WHERE version.id = NEW.content_version_id;

  -- The foreign key makes a missing version impossible, so reaching here means
  -- the lookup itself was blocked. Refusing is the only safe reading: a gate
  -- that cannot see what it is gating must not decide that it is fine.
  IF NOT COALESCE(found, false) THEN
    RAISE EXCEPTION
      'Selena cannot determine the content kind for this release and refuses to proceed'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- COALESCE to true rather than to false: an unreadable answer is gated, not
  -- waved through.
  IF NOT COALESCE(is_youtube, true) THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM selena_registry.channel_accounts account
    JOIN selena_registry.channel_provider_bindings binding
      ON binding.channel_account_id = account.id
    WHERE account.id = NEW.channel_account_id
      -- The account has to be the one this release is for. Without these two the
      -- gate would open on any tenant's allowlisted YouTube account, which is a
      -- decision another organization made about its own channel.
      AND account.organization_id = NEW.organization_id
      AND account.brand_id = NEW.brand_id
      AND account.platform = 'youtube'
      AND account.allowlisted
      AND account.status = 'ACTIVE'
      -- An inactive binding is not a publication adapter, and a binding for some
      -- other provider is not a YouTube one.
      AND binding.active
      AND binding.provider = 'youtube'
  ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'Selena refuses to release a YOUTUBE_VIDEO content version: no allowlisted YouTube channel account with a publication adapter exists'
    USING ERRCODE = 'raise_exception';
END;
$$;

-- INSERT OR UPDATE, because release_intents is not append-only: 0021 and 0029
-- both grant it UPDATE policies. An intent created against a legacy version and
-- then re-pointed at a YOUTUBE_VIDEO one would otherwise never meet the gate.
CREATE TRIGGER release_intents_youtube_fail_closed
  BEFORE INSERT OR UPDATE ON selena_release.release_intents
  FOR EACH ROW EXECUTE FUNCTION selena_release.reject_unsupported_youtube_release();
CREATE TRIGGER release_manifests_youtube_fail_closed
  BEFORE INSERT OR UPDATE ON selena_release.release_manifests
  FOR EACH ROW EXECUTE FUNCTION selena_release.reject_unsupported_youtube_release();

-- ── row level security ──────────────────────────────────────────────────────

ALTER TABLE selena_registry.generation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE selena_registry.generation_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE selena_registry.editorial_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE selena_registry.editorial_approvals FORCE ROW LEVEL SECURITY;

CREATE POLICY generation_runs_web_select ON selena_registry.generation_runs
  FOR SELECT TO selena_web_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['web']));
CREATE POLICY generation_runs_web_insert ON selena_registry.generation_runs
  FOR INSERT TO selena_web_runtime
  WITH CHECK (
    created_by = current_setting('app.selena_actor_id', true)
    AND selena_registry.can_write_brand(organization_id, brand_id, ARRAY['web'])
    -- Every reference to the new row is schema-qualified. An unqualified name
    -- inside EXISTS resolves against the subquery's own table, which turns a
    -- cross-tenant guard into a comparison of a column with itself.
    AND EXISTS (
      SELECT 1 FROM selena_registry.brand_content_profile_versions version
      WHERE version.id = selena_registry.generation_runs.profile_version_id
        AND version.organization_id = selena_registry.generation_runs.organization_id
        AND version.brand_id = selena_registry.generation_runs.brand_id
        AND version.profile_hash = selena_registry.generation_runs.profile_hash
    )
    AND (
      SELECT decision
      FROM selena_registry.brand_content_profile_decisions decided
      WHERE decided.profile_version_id = selena_registry.generation_runs.profile_version_id
      ORDER BY decided.created_at DESC, decided.id DESC
      LIMIT 1
    ) = 'CONFIRMED'
    AND (
      selena_registry.generation_runs.content_item_id IS NULL
      OR EXISTS (
        SELECT 1 FROM selena_registry.content_items item
        WHERE item.id = selena_registry.generation_runs.content_item_id
          AND item.organization_id = selena_registry.generation_runs.organization_id
          AND item.brand_id = selena_registry.generation_runs.brand_id
      )
    )
    -- The research a generation runs against must be this brand's own.
    AND (
      selena_registry.generation_runs.research_run_id IS NULL
      OR EXISTS (
        SELECT 1 FROM selena_registry.content_research_runs run
        WHERE run.id = selena_registry.generation_runs.research_run_id
          AND run.organization_id = selena_registry.generation_runs.organization_id
          AND run.brand_id = selena_registry.generation_runs.brand_id
          AND run.profile_version_id = selena_registry.generation_runs.profile_version_id
      )
    )
    -- ...and the opportunity must belong to that same run, not merely to the
    -- same brand. Otherwise a generation could cite evidence from a run it was
    -- not based on.
    AND (
      selena_registry.generation_runs.research_opportunity_id IS NULL
      OR EXISTS (
        SELECT 1 FROM selena_registry.content_research_opportunities opportunity
        WHERE opportunity.id = selena_registry.generation_runs.research_opportunity_id
          AND opportunity.organization_id = selena_registry.generation_runs.organization_id
          AND opportunity.brand_id = selena_registry.generation_runs.brand_id
          AND opportunity.run_id = selena_registry.generation_runs.research_run_id
      )
    )
  );
CREATE POLICY generation_runs_web_update_denied ON selena_registry.generation_runs
  FOR UPDATE TO selena_web_runtime USING (false) WITH CHECK (false);
CREATE POLICY generation_runs_web_delete_denied ON selena_registry.generation_runs
  FOR DELETE TO selena_web_runtime USING (false);

CREATE POLICY editorial_approvals_web_select ON selena_registry.editorial_approvals
  FOR SELECT TO selena_web_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['web']));
CREATE POLICY editorial_approvals_web_insert ON selena_registry.editorial_approvals
  FOR INSERT TO selena_web_runtime
  WITH CHECK (
    decided_by = current_setting('app.selena_actor_id', true)
    AND selena_registry.can_write_brand(organization_id, brand_id, ARRAY['web'])
    -- Approving is an owner act. Asking for changes or rejecting is not: a
    -- reviewer who can only say yes is not a reviewer.
    AND (
      selena_registry.editorial_approvals.decision <> 'APPROVED'
      OR selena_registry.can_human_approve(
        selena_registry.editorial_approvals.organization_id,
        selena_registry.editorial_approvals.brand_id
      )
    )
    AND EXISTS (
      SELECT 1 FROM selena_registry.content_versions version
      WHERE version.id = selena_registry.editorial_approvals.content_version_id
        AND version.organization_id = selena_registry.editorial_approvals.organization_id
        AND version.brand_id = selena_registry.editorial_approvals.brand_id
        -- The decision names the digest it was given. A decision recorded against
        -- a different hash than the version carries is a decision about something
        -- else.
        AND version.content_hash = selena_registry.editorial_approvals.content_hash
    )
  );
CREATE POLICY editorial_approvals_web_update_denied ON selena_registry.editorial_approvals
  FOR UPDATE TO selena_web_runtime USING (false) WITH CHECK (false);
CREATE POLICY editorial_approvals_web_delete_denied ON selena_registry.editorial_approvals
  FOR DELETE TO selena_web_runtime USING (false);

-- The lineage columns this migration added to content_versions are governed by
-- 0021's insert policy, whose whole check is can_write_brand. The single-column
-- foreign keys prove those rows exist and nothing more, so a session could write
-- its own brand's immutable, V2-hashed version while citing another
-- organization's research run — and the V2 digest covers exactly those ids, so
-- an editorial decision would then be bound to a lineage that is not this
-- brand's.
--
-- generation_runs_web_insert above already enforces these three relationships.
-- This is the same enforcement on the sibling table, which was an omission
-- rather than a decision.
DROP POLICY content_versions_web_insert ON selena_registry.content_versions;
CREATE POLICY content_versions_web_insert ON selena_registry.content_versions
  FOR INSERT TO selena_web_runtime
  WITH CHECK (
    selena_registry.can_write_brand(organization_id, brand_id, ARRAY['web'])
    -- Every reference to the new row is schema-qualified: an unqualified name
    -- inside EXISTS resolves against the subquery's own table.
    --
    -- A version belongs to a draft, and the draft has to be this brand's. Version
    -- numbers are unique per draft, so writing into another brand's draft also
    -- takes the number that draft's own next write needs.
    AND EXISTS (
      SELECT 1 FROM selena_registry.content_items item
      WHERE item.id = selena_registry.content_versions.content_id
        AND item.organization_id = selena_registry.content_versions.organization_id
        AND item.brand_id = selena_registry.content_versions.brand_id
    )
    AND (
      selena_registry.content_versions.project_profile_version_id IS NULL
      OR EXISTS (
        SELECT 1 FROM selena_registry.brand_content_profile_versions version
        WHERE version.id = selena_registry.content_versions.project_profile_version_id
          AND version.organization_id = selena_registry.content_versions.organization_id
          AND version.brand_id = selena_registry.content_versions.brand_id
      )
    )
    AND (
      selena_registry.content_versions.research_run_id IS NULL
      OR EXISTS (
        SELECT 1 FROM selena_registry.content_research_runs run
        WHERE run.id = selena_registry.content_versions.research_run_id
          AND run.organization_id = selena_registry.content_versions.organization_id
          AND run.brand_id = selena_registry.content_versions.brand_id
      )
    )
    AND (
      selena_registry.content_versions.generation_run_id IS NULL
      OR EXISTS (
        SELECT 1 FROM selena_registry.generation_runs generation
        WHERE generation.id = selena_registry.content_versions.generation_run_id
          AND generation.organization_id = selena_registry.content_versions.organization_id
          AND generation.brand_id = selena_registry.content_versions.brand_id
      )
    )
  );

-- content_items carries lineage of its own now, and 0021's insert and update
-- policies are a bare can_write_brand. The single-column foreign keys prove the
-- referenced rows exist and nothing more, so a session could hang another
-- brand's generation run or content channel on its own item — and the idea a
-- script's evidence is drawn from is resolved through exactly those two columns.
DROP POLICY content_items_web_insert ON selena_registry.content_items;
CREATE POLICY content_items_web_insert ON selena_registry.content_items
  FOR INSERT TO selena_web_runtime
  WITH CHECK (
    selena_registry.can_write_brand(organization_id, brand_id, ARRAY['web'])
    AND (
      selena_registry.content_items.content_channel_id IS NULL
      OR EXISTS (
        SELECT 1 FROM selena_registry.content_channels channel
        WHERE channel.id = selena_registry.content_items.content_channel_id
          AND channel.organization_id = selena_registry.content_items.organization_id
          AND channel.brand_id = selena_registry.content_items.brand_id
      )
    )
    AND (
      selena_registry.content_items.idea_generation_run_id IS NULL
      OR EXISTS (
        SELECT 1 FROM selena_registry.generation_runs generation
        WHERE generation.id = selena_registry.content_items.idea_generation_run_id
          AND generation.organization_id = selena_registry.content_items.organization_id
          AND generation.brand_id = selena_registry.content_items.brand_id
      )
    )
  );
DROP POLICY content_items_web_update ON selena_registry.content_items;
CREATE POLICY content_items_web_update ON selena_registry.content_items
  FOR UPDATE TO selena_web_runtime
  USING (selena_registry.can_write_brand(organization_id, brand_id, ARRAY['web']))
  WITH CHECK (
    selena_registry.can_write_brand(organization_id, brand_id, ARRAY['web'])
    AND (
      selena_registry.content_items.content_channel_id IS NULL
      OR EXISTS (
        SELECT 1 FROM selena_registry.content_channels channel
        WHERE channel.id = selena_registry.content_items.content_channel_id
          AND channel.organization_id = selena_registry.content_items.organization_id
          AND channel.brand_id = selena_registry.content_items.brand_id
      )
    )
    AND (
      selena_registry.content_items.idea_generation_run_id IS NULL
      OR EXISTS (
        SELECT 1 FROM selena_registry.generation_runs generation
        WHERE generation.id = selena_registry.content_items.idea_generation_run_id
          AND generation.organization_id = selena_registry.content_items.organization_id
          AND generation.brand_id = selena_registry.content_items.brand_id
      )
    )
  );

-- What a draft is is not an editable field. The release guard reads it, the
-- CHECK that a YouTube video names a channel is written against it, and the
-- creation surfaces filter on it; a column three rules depend on should not be
-- one an ordinary UPDATE can turn over. The guard no longer depends on this
-- being true, which is why this is a second lock rather than the only one.
CREATE FUNCTION selena_registry.reject_content_kind_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.content_kind IS DISTINCT FROM OLD.content_kind THEN
    RAISE EXCEPTION
      'Selena refuses to change the kind of an existing content item'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER content_items_kind_immutable
  BEFORE UPDATE ON selena_registry.content_items
  FOR EACH ROW EXECUTE FUNCTION selena_registry.reject_content_kind_change();

CREATE TRIGGER generation_runs_append_only
  BEFORE UPDATE OR DELETE ON selena_registry.generation_runs
  FOR EACH ROW EXECUTE FUNCTION selena_audit.reject_immutable_mutation();
CREATE TRIGGER editorial_approvals_append_only
  BEFORE UPDATE OR DELETE ON selena_registry.editorial_approvals
  FOR EACH ROW EXECUTE FUNCTION selena_audit.reject_immutable_mutation();

GRANT USAGE ON TYPE selena_registry.content_kind TO selena_web_runtime;
GRANT USAGE ON TYPE selena_registry.content_workflow_stage TO selena_web_runtime;
GRANT USAGE ON TYPE selena_registry.generation_run_kind TO selena_web_runtime;
GRANT USAGE ON TYPE selena_registry.generation_run_status TO selena_web_runtime;
GRANT USAGE ON TYPE selena_registry.editorial_decision TO selena_web_runtime;
GRANT SELECT, INSERT ON selena_registry.generation_runs TO selena_web_runtime;
GRANT SELECT, INSERT ON selena_registry.editorial_approvals TO selena_web_runtime;

RESET ROLE;

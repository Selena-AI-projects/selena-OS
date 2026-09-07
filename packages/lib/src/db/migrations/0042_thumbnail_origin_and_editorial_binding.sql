-- Specification section 9. Slice 4 adds thumbnails and editorial approval on top
-- of the tables 0041 created ahead of it. `editorial_approvals` already carries
-- the four hashes a decision is about; what it did not have was any way to check
-- that three of them describe the version as it stands right now.

-- ── generated imagery is not uploaded imagery ───────────────────────────────
-- A reviewer looking at a thumbnail needs to know whether a person supplied it
-- or a generator produced it: the rights and consent questions are different,
-- and only one of the two has a human who can answer them. Defaulted to
-- UPLOADED, because every asset written before this migration arrived through
-- the upload path and that is what the column now says about it.

CREATE TYPE selena_registry.asset_origin AS ENUM ('UPLOADED', 'GENERATED');

ALTER TABLE selena_registry.content_assets
  ADD COLUMN origin selena_registry.asset_origin DEFAULT 'UPLOADED' NOT NULL;

CREATE INDEX content_assets_version_origin_idx
  ON selena_registry.content_assets (content_version_id, origin);

-- ── what an editorial decision is about, computed rather than asserted ──────
-- 0041 bound `content_hash` to the version and left the other three to the
-- caller. A hash a caller supplies is a claim about what it was shown, and the
-- stop condition for this slice is approval against a stale hash — so the three
-- become values the database derives and the policy compares against.
--
-- Both functions are SECURITY DEFINER for the reason 0041 recorded about the
-- release guard: RLS applies to the row-reading inside a function too, and a
-- bundle computed from the rows the *caller* can see is a bundle the caller can
-- change by hiding a row. 0021 already gives selena_schema_owner a read policy
-- on both content_assets and content_versions, so both functions can see every
-- row they are asked about — checked rather than assumed, because a definer
-- function reading a table it has no policy on returns nothing and the caller
-- concludes the answer is empty.

-- Only CLEAN assets are in the bundle. An asset that is still quarantined, still
-- being scanned, or infected is not something a reviewer was shown, and the
-- checklist for this slice says so directly: scanner state CLEAN is the
-- precondition for entering an approval bundle.
--
-- A version with no clean asset hashes to the digest of the empty string rather
-- than to NULL. NULL would make the comparison in the policy unknown, and an
-- unknown answer in a WITH CHECK is a refusal for the wrong reason — worse, it
-- would read as "this version has no bundle" when it may mean "this version's
-- bundle could not be read".
--
-- Ordering is by the digest itself. `content_assets_sha256_format` constrains it
-- to lowercase hex, so every collation orders these identically and the hash
-- does not become a property of the database's locale.
CREATE FUNCTION selena_registry.editorial_asset_bundle_hash(p_content_version_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT encode(
    sha256(convert_to(coalesce(string_agg(asset.sha256, ',' ORDER BY asset.sha256), ''), 'UTF8')),
    'hex'
  )
  FROM selena_registry.content_assets asset
  WHERE asset.content_version_id = p_content_version_id
    AND asset.scan_status = 'CLEAN';
$$;

-- The evidence digest is taken over the stored jsonb rather than over anything
-- the application re-serializes. Postgres renders jsonb canonically — object keys
-- ordered, insignificant whitespace gone — so the same stored value always
-- produces the same bytes, and no second implementation has to agree with a
-- first one about what canonical means.
--
-- The application does not compute this. It asks for it, submits what it was
-- given, and the policy checks the answer still holds; a version that changed in
-- between produces a different digest and the approval is refused.
CREATE FUNCTION selena_registry.editorial_evidence_hash(p_content_version_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT encode(sha256(convert_to(version.evidence::text, 'UTF8')), 'hex')
  FROM selena_registry.content_versions version
  WHERE version.id = p_content_version_id;
$$;

GRANT EXECUTE ON FUNCTION selena_registry.editorial_asset_bundle_hash(uuid) TO selena_web_runtime;
GRANT EXECUTE ON FUNCTION selena_registry.editorial_evidence_hash(uuid) TO selena_web_runtime;

-- ── revocation is an append ─────────────────────────────────────────────────
-- `editorial_approvals` admits no UPDATE and no DELETE, so withdrawing an
-- approval is a new row rather than an edit of the old one. That needs a fourth
-- decision value, and the enum cannot simply gain one here: the insert policy
-- reads `decision`, and Postgres refuses to alter the type of a column a policy
-- depends on. The policy is being replaced anyway, so the type is replaced under
-- it and keeps its name.

-- Everything that reads the column has to let go of it first. Both the policy
-- and the CHECK compare `decision` against a literal, and during the type change
-- that literal still carries the old type — the comparison has no operator and
-- the migration fails on a constraint it is about to rewrite anyway.
DROP POLICY editorial_approvals_web_insert ON selena_registry.editorial_approvals;
ALTER TABLE selena_registry.editorial_approvals
  DROP CONSTRAINT editorial_approvals_reason_required;

CREATE TYPE selena_registry.editorial_decision_next AS ENUM (
  'APPROVED', 'CHANGES_REQUESTED', 'REJECTED', 'REVOKED'
);
ALTER TABLE selena_registry.editorial_approvals
  ALTER COLUMN decision TYPE selena_registry.editorial_decision_next
  USING decision::text::selena_registry.editorial_decision_next;
DROP TYPE selena_registry.editorial_decision;
ALTER TYPE selena_registry.editorial_decision_next RENAME TO editorial_decision;

-- Withdrawing an approval has to say why, for the same reason rejecting does:
-- the author is left with a changed verdict and needs the next step.
ALTER TABLE selena_registry.editorial_approvals
  ADD CONSTRAINT editorial_approvals_reason_required CHECK (
    decision = 'APPROVED' OR reason IS NOT NULL
  );

CREATE POLICY editorial_approvals_web_insert ON selena_registry.editorial_approvals
  FOR INSERT TO selena_web_runtime
  WITH CHECK (
    decided_by = current_setting('app.selena_actor_id', true)
    AND selena_registry.can_write_brand(organization_id, brand_id, ARRAY['web'])
    -- Approving is an owner act, and so is taking an approval back. Asking for
    -- changes or rejecting is not: a reviewer who can only say yes is not a
    -- reviewer.
    AND (
      selena_registry.editorial_approvals.decision NOT IN ('APPROVED', 'REVOKED')
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
        -- A decision can only bind a profile hash if the version names a profile
        -- version, which a structured version always does and a legacy one never
        -- does. Editorial review is for content that carries its lineage.
        AND version.project_profile_version_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM selena_registry.brand_content_profile_versions profile
          WHERE profile.id = version.project_profile_version_id
            AND profile.profile_hash = selena_registry.editorial_approvals.profile_hash
        )
    )
    AND selena_registry.editorial_approvals.evidence_hash
      = selena_registry.editorial_evidence_hash(selena_registry.editorial_approvals.content_version_id)
    AND selena_registry.editorial_approvals.asset_bundle_hash
      = selena_registry.editorial_asset_bundle_hash(selena_registry.editorial_approvals.content_version_id)
    -- Withdrawing an approval that was never given is not a decision about
    -- anything. The prior approval has to be for this same version and the same
    -- content hash, and it has to be the standing one: a version already revoked
    -- cannot be revoked again.
    AND (
      selena_registry.editorial_approvals.decision <> 'REVOKED'
      OR (
        SELECT prior.decision
        FROM selena_registry.editorial_approvals prior
        WHERE prior.content_version_id = selena_registry.editorial_approvals.content_version_id
          AND prior.content_hash = selena_registry.editorial_approvals.content_hash
          AND prior.decision IN ('APPROVED', 'REVOKED')
        ORDER BY prior.created_at DESC, prior.id DESC
        LIMIT 1
      ) = 'APPROVED'
    )
  );

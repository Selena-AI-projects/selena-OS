SET ROLE selena_schema_owner;

-- A brand's content policy had no way to be created, chosen or withdrawn: the
-- table was read in three places and written in none, so every deployment
-- reached the point where a draft needs a policy and stopped there. What was
-- missing is not the row but its lifecycle — which version is in force, and
-- what happened to the one before it.

ALTER TABLE selena_registry.content_policies
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS activated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_by text,
  ADD COLUMN IF NOT EXISTS revoked_reason text;
--> statement-breakpoint

ALTER TABLE selena_registry.content_policies
  DROP CONSTRAINT IF EXISTS content_policies_status_known;
--> statement-breakpoint
ALTER TABLE selena_registry.content_policies
  ADD CONSTRAINT content_policies_status_known CHECK (status IN ('active', 'revoked'));
--> statement-breakpoint

ALTER TABLE selena_registry.content_policies
  DROP CONSTRAINT IF EXISTS content_policies_revocation_complete;
--> statement-breakpoint
ALTER TABLE selena_registry.content_policies
  ADD CONSTRAINT content_policies_revocation_complete CHECK (
    (status = 'active' AND revoked_at IS NULL AND revoked_by IS NULL AND revoked_reason IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL AND revoked_by IS NOT NULL
        AND length(btrim(revoked_reason)) > 0)
  );
--> statement-breakpoint

-- One policy in force per brand. Superseded versions stay as rows: the question
-- "under which policy was this approved" has to stay answerable afterwards.
CREATE UNIQUE INDEX IF NOT EXISTS content_policies_one_active_per_brand
  ON selena_registry.content_policies (brand_id) WHERE status = 'active';
--> statement-breakpoint

-- The definer functions below run as the table's owner, and the table forces
-- row level security, so the owner needs policies of its own to write at all.
CREATE POLICY content_policies_schema_owner_insert ON selena_registry.content_policies
  FOR INSERT TO selena_schema_owner WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY content_policies_schema_owner_update ON selena_registry.content_policies
  FOR UPDATE TO selena_schema_owner USING (true) WITH CHECK (true);
--> statement-breakpoint

CREATE FUNCTION selena_registry.set_content_policy(
  p_brand_id text,
  p_policy_version text,
  p_require_evidence boolean
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, selena_registry
AS $$
DECLARE
  v_organization_id text := current_setting('app.selena_organization_id', true);
  v_actor_id text := current_setting('app.selena_actor_id', true);
  v_current selena_registry.content_policies%ROWTYPE;
  v_id uuid;
BEGIN
  IF NOT pg_has_role(session_user, 'selena_web_runtime', 'member')
    OR v_organization_id IS NULL OR v_actor_id IS NULL
    OR current_setting('app.selena_brand_id', true) IS DISTINCT FROM p_brand_id
    OR NOT selena_registry.can_human_approve(v_organization_id, p_brand_id) THEN
    RAISE EXCEPTION 'Only an interactive owner session for this brand may set its content policy';
  END IF;
  IF length(btrim(COALESCE(p_policy_version, ''))) = 0 THEN
    RAISE EXCEPTION 'A content policy needs a version';
  END IF;

  -- Two owners pressing the same button at once must not produce two policies
  -- in force; the partial unique index would reject the second, less legibly.
  PERFORM pg_advisory_xact_lock(hashtext('content_policy:' || v_organization_id || ':' || p_brand_id));

  SELECT * INTO v_current FROM selena_registry.content_policies
   WHERE brand_id = p_brand_id AND status = 'active';

  -- Asking for what is already in force changes nothing and says so by
  -- returning the same row: a repeated request is not a new version.
  IF FOUND AND v_current.policy_version = p_policy_version
     AND v_current.require_evidence IS NOT DISTINCT FROM p_require_evidence THEN
    RETURN v_current.id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM selena_registry.content_policies
     WHERE brand_id = p_brand_id AND policy_version = p_policy_version
  ) THEN
    RAISE EXCEPTION 'Version % already exists for this brand; a withdrawn version is not reinstated, use a new version',
      p_policy_version;
  END IF;

  IF FOUND THEN
    UPDATE selena_registry.content_policies
       SET status = 'revoked', revoked_at = now(), revoked_by = v_actor_id,
           revoked_reason = 'superseded by ' || p_policy_version, updated_at = now()
     WHERE id = v_current.id;
    PERFORM selena_registry.append_growth_audit(
      v_organization_id, p_brand_id, v_actor_id, 'content.policy_superseded', v_current.id::text,
      jsonb_build_object('policyVersion', v_current.policy_version, 'supersededBy', p_policy_version)
    );
  END IF;

  INSERT INTO selena_registry.content_policies (
    organization_id, brand_id, policy_version, require_evidence, created_by
  ) VALUES (
    v_organization_id, p_brand_id, p_policy_version, COALESCE(p_require_evidence, false), v_actor_id
  ) RETURNING id INTO v_id;

  PERFORM selena_registry.append_growth_audit(
    v_organization_id, p_brand_id, v_actor_id, 'content.policy_set', v_id::text,
    jsonb_build_object('policyVersion', p_policy_version, 'requireEvidence', COALESCE(p_require_evidence, false))
  );
  RETURN v_id;
END;
$$;
--> statement-breakpoint

CREATE FUNCTION selena_registry.revoke_content_policy(
  p_policy_id uuid,
  p_reason text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, selena_registry
AS $$
DECLARE
  v_organization_id text := current_setting('app.selena_organization_id', true);
  v_brand_id text := current_setting('app.selena_brand_id', true);
  v_actor_id text := current_setting('app.selena_actor_id', true);
  v_version text;
BEGIN
  IF NOT pg_has_role(session_user, 'selena_web_runtime', 'member')
    OR v_organization_id IS NULL OR v_brand_id IS NULL OR v_actor_id IS NULL
    OR NOT selena_registry.can_human_approve(v_organization_id, v_brand_id) THEN
    RAISE EXCEPTION 'Only an interactive owner session for this brand may withdraw its content policy';
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) = 0 THEN
    RAISE EXCEPTION 'A withdrawal needs a reason';
  END IF;

  UPDATE selena_registry.content_policies
     SET status = 'revoked', revoked_at = now(), revoked_by = v_actor_id,
         revoked_reason = p_reason, updated_at = now()
   WHERE id = p_policy_id AND organization_id = v_organization_id AND brand_id = v_brand_id
     AND status = 'active'
  RETURNING policy_version INTO v_version;

  IF v_version IS NULL THEN
    RAISE EXCEPTION 'No content policy in force for this brand with that identity';
  END IF;

  PERFORM selena_registry.append_growth_audit(
    v_organization_id, v_brand_id, v_actor_id, 'content.policy_revoked', p_policy_id::text,
    jsonb_build_object('policyVersion', v_version, 'reason', p_reason)
  );
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION selena_registry.set_content_policy(text, text, boolean) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION selena_registry.revoke_content_policy(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION selena_registry.set_content_policy(text, text, boolean) TO selena_web_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION selena_registry.revoke_content_policy(uuid, text) TO selena_web_runtime;
--> statement-breakpoint

-- The projection asks for the policy in force; before this it would have taken
-- a withdrawn one as current, because every row looked alike.
GRANT SELECT ON selena_registry.content_policies TO selena_registry_worker_runtime;

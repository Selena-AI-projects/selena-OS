SET ROLE selena_schema_owner;

-- ───────────────────────── return channel: OS → Aether ─────────────────────────
--
-- The forward path (Aether → OS) ends when a draft becomes a release and the
-- gateway records its verdict. Until now that verdict stayed in OS: the Aether
-- task that produced the draft never learned whether it was published, refused,
-- failed, or rejected by the owner — the author saw "sent" forever (audit P1-3).
--
-- This is the OS half of the return channel: a transactional outbox that a
-- worker drains and posts back to Aether, filled by two triggers at the moment
-- a draft reaches a terminal verdict. It mirrors the inbound side's discipline —
-- the worker reaches the outbox through functions only, never the table.

CREATE TABLE selena_registry.aether_outcome_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- Wire idempotency key: the receiver dedupes on this, so a redelivery after a
  -- lease expiry or a crash lands once.
  event_id uuid DEFAULT gen_random_uuid() NOT NULL,
  content_version_id uuid NOT NULL REFERENCES selena_registry.content_versions(id),
  outcome text NOT NULL CHECK (outcome IN ('PUBLISHED', 'REFUSED', 'FAILED', 'REJECTED')),
  organization_id text NOT NULL REFERENCES public.organization(id),
  brand_id text NOT NULL REFERENCES public.brands(id),
  -- Where it goes back to: the originating Aether project and the material it was.
  aether_project_id uuid NOT NULL,
  aggregate_id uuid NOT NULL,
  task_id uuid,
  content_kind text,
  material_version integer NOT NULL,
  -- Carried only when meaningful: the provider's reference on PUBLISHED, and a
  -- category (never free text or content) on FAILED.
  reference text,
  detail text,
  trace_id uuid,
  occurred_at timestamptz DEFAULT now() NOT NULL,
  status text DEFAULT 'PENDING' NOT NULL CHECK (status IN ('PENDING', 'LEASED', 'DELIVERED', 'DEAD')),
  available_at timestamptz DEFAULT now() NOT NULL,
  lease_owner text,
  lease_expires_at timestamptz,
  attempt_count integer DEFAULT 0 NOT NULL CHECK (attempt_count >= 0),
  max_attempts integer DEFAULT 8 NOT NULL CHECK (max_attempts > 0),
  last_error text,
  delivered_at timestamptz,
  dead_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT aether_outcome_detail_shape CHECK (detail IS NULL OR detail ~ '^[A-Za-z0-9_.-]{1,128}$')
);
-- One terminal verdict of a kind per material version — a verdict recorded over
-- several attempt transitions enqueues once.
CREATE UNIQUE INDEX aether_outcome_outbox_version_outcome_unique
  ON selena_registry.aether_outcome_outbox (content_version_id, outcome);
CREATE UNIQUE INDEX aether_outcome_outbox_event_id_unique
  ON selena_registry.aether_outcome_outbox (event_id);
CREATE INDEX aether_outcome_outbox_claim_idx
  ON selena_registry.aether_outcome_outbox (status, available_at, lease_expires_at);

-- Resolve the Aether target from a content version and enqueue one outcome.
-- SECURITY DEFINER so the triggers can read the registry and the version's
-- disclosure regardless of which runtime caused the verdict. Content authored
-- in the Control Room (no Aether origin) has nothing to return, so it is
-- skipped. Idempotent through the unique index.
CREATE FUNCTION selena_registry.enqueue_aether_outcome(
  p_content_version_id uuid,
  p_outcome text,
  p_reference text,
  p_detail text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, selena_registry
AS $$
DECLARE
  v_org text;
  v_brand text;
  v_version integer;
  v_project uuid;
  v_trace uuid;
  v_aggregate uuid;
  v_task uuid;
  v_kind text;
  v_source text;
BEGIN
  SELECT v.organization_id, v.brand_id, v.version,
         NULLIF(v.disclosure #>> '{origin,project_id}', '')::uuid,
         NULLIF(v.disclosure #>> '{origin,trace_id}', '')::uuid,
         i.external_ref, i.brief_ref, i.kind, i.external_source
    INTO v_org, v_brand, v_version, v_project, v_trace, v_aggregate, v_task, v_kind, v_source
  FROM selena_registry.content_versions v
  JOIN selena_registry.content_items i ON i.id = v.content_id
  WHERE v.id = p_content_version_id;

  -- No Aether origin (Control Room content) or no routable target: nothing to return.
  IF v_source IS DISTINCT FROM 'aether' OR v_aggregate IS NULL OR v_project IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO selena_registry.aether_outcome_outbox (
    content_version_id, outcome, organization_id, brand_id, aether_project_id,
    aggregate_id, task_id, content_kind, material_version, reference, detail, trace_id
  ) VALUES (
    p_content_version_id, p_outcome, v_org, v_brand, v_project,
    v_aggregate, v_task, v_kind, v_version, p_reference, p_detail, v_trace
  )
  ON CONFLICT (content_version_id, outcome) DO NOTHING;
END;
$$;

-- A publication attempt carries the gateway's verdict. Only the author-terminal
-- ones return; RESERVED / AMBIGUOUS / RECONCILE_REQUIRED / MANUAL_REVIEW are not
-- conclusions and are left for reconciliation. The reference travels on
-- PUBLISHED, the error category (not its detail text) on FAILED.
CREATE FUNCTION selena_registry.tg_aether_outcome_from_attempt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, selena_registry
AS $$
DECLARE
  v_outcome text;
  v_content_version_id uuid;
BEGIN
  IF NEW.status IN ('ACCEPTED', 'CONFIRMED') THEN
    v_outcome := 'PUBLISHED';
  ELSIF NEW.status = 'NOT_SENT' THEN
    v_outcome := 'REFUSED';
  ELSIF NEW.status = 'DEFINITIVE_FAILURE' THEN
    v_outcome := 'FAILED';
  ELSE
    RETURN NEW;
  END IF;

  SELECT content_version_id INTO v_content_version_id
  FROM selena_release.release_manifests WHERE id = NEW.release_manifest_id;
  IF v_content_version_id IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM selena_registry.enqueue_aether_outcome(
    v_content_version_id,
    v_outcome,
    CASE WHEN v_outcome = 'PUBLISHED' THEN NEW.provider_reference_id END,
    CASE WHEN v_outcome = 'FAILED' THEN NEW.error_classification END
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER aether_outcome_from_attempt
  AFTER INSERT ON selena_release.publication_attempts
  FOR EACH ROW EXECUTE FUNCTION selena_registry.tg_aether_outcome_from_attempt();

-- An owner rejection ends the draft before it ever becomes a release, so it
-- never reaches a publication attempt. The reason stays in the Control Room; the
-- author learns only that it was rejected.
CREATE FUNCTION selena_registry.tg_aether_outcome_from_rejection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, selena_registry
AS $$
BEGIN
  PERFORM selena_registry.enqueue_aether_outcome(NEW.content_version_id, 'REJECTED', NULL, NULL);
  RETURN NEW;
END;
$$;

CREATE TRIGGER aether_outcome_from_rejection
  AFTER INSERT ON selena_registry.approvals
  FOR EACH ROW WHEN (NEW.decision = 'REJECTED')
  EXECUTE FUNCTION selena_registry.tg_aether_outcome_from_rejection();

-- The worker drains the outbox through these functions and never touches the
-- table: claim leases the oldest due row, and the two marks close it. Identity
-- is the registry worker's own — the same one the projection worker sets.
CREATE FUNCTION selena_registry.claim_next_aether_outcome(p_lease_seconds integer)
RETURNS TABLE (
  id uuid, event_id uuid, outcome text, aether_project_id uuid, aggregate_id uuid,
  task_id uuid, content_kind text, material_version integer, reference text,
  detail text, trace_id uuid, occurred_at timestamptz, attempt_count integer,
  max_attempts integer, lease_owner text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, selena_registry
AS $$
DECLARE
  v_owner text := gen_random_uuid()::text;
BEGIN
  IF NOT pg_has_role(session_user, 'selena_registry_worker_runtime', 'member')
    OR current_setting('app.selena_service_identity', true) IS DISTINCT FROM 'registry_worker'
    OR current_setting('app.selena_actor_id', true) IS DISTINCT FROM 'service:registry-worker'
    OR current_setting('app.selena_auth_type', true) IS DISTINCT FROM 'service' THEN
    RAISE EXCEPTION 'Only the registry worker may claim Aether outcome events';
  END IF;
  RETURN QUERY
  UPDATE selena_registry.aether_outcome_outbox o
  SET status = 'LEASED',
      lease_owner = v_owner,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      attempt_count = o.attempt_count + 1
  WHERE o.id = (
    SELECT c.id FROM selena_registry.aether_outcome_outbox c
    WHERE c.status IN ('PENDING', 'LEASED')
      AND c.available_at <= now()
      AND (c.lease_expires_at IS NULL OR c.lease_expires_at <= now())
    ORDER BY c.available_at, c.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING o.id, o.event_id, o.outcome, o.aether_project_id, o.aggregate_id,
            o.task_id, o.content_kind, o.material_version, o.reference,
            o.detail, o.trace_id, o.occurred_at, o.attempt_count, o.max_attempts, o.lease_owner;
END;
$$;

CREATE FUNCTION selena_registry.record_aether_outcome_delivered(p_id uuid, p_lease_owner text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, selena_registry
AS $$
BEGIN
  IF NOT pg_has_role(session_user, 'selena_registry_worker_runtime', 'member')
    OR current_setting('app.selena_service_identity', true) IS DISTINCT FROM 'registry_worker'
    OR current_setting('app.selena_actor_id', true) IS DISTINCT FROM 'service:registry-worker'
    OR current_setting('app.selena_auth_type', true) IS DISTINCT FROM 'service' THEN
    RAISE EXCEPTION 'Only the registry worker may mark Aether outcome events';
  END IF;
  UPDATE selena_registry.aether_outcome_outbox
  SET status = 'DELIVERED', delivered_at = now(), lease_owner = NULL, lease_expires_at = NULL, last_error = NULL
  WHERE id = p_id AND lease_owner = p_lease_owner AND status = 'LEASED';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Aether outcome event is not leased by this owner';
  END IF;
END;
$$;

-- A reached max_attempts becomes a dead letter; otherwise it is released with a
-- doubling back-off capped at an hour, the same shape the inbound deferral uses.
CREATE FUNCTION selena_registry.retry_or_dead_letter_aether_outcome(p_id uuid, p_lease_owner text, p_detail text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, selena_registry
AS $$
BEGIN
  IF NOT pg_has_role(session_user, 'selena_registry_worker_runtime', 'member')
    OR current_setting('app.selena_service_identity', true) IS DISTINCT FROM 'registry_worker'
    OR current_setting('app.selena_actor_id', true) IS DISTINCT FROM 'service:registry-worker'
    OR current_setting('app.selena_auth_type', true) IS DISTINCT FROM 'service' THEN
    RAISE EXCEPTION 'Only the registry worker may mark Aether outcome events';
  END IF;
  UPDATE selena_registry.aether_outcome_outbox o
  SET status = CASE WHEN o.attempt_count >= o.max_attempts THEN 'DEAD' ELSE 'PENDING' END,
      dead_at = CASE WHEN o.attempt_count >= o.max_attempts THEN now() ELSE NULL END,
      available_at = CASE WHEN o.attempt_count >= o.max_attempts THEN o.available_at
                          ELSE now() + make_interval(secs => least(3600, 30 * power(2, o.attempt_count))) END,
      lease_owner = NULL,
      lease_expires_at = NULL,
      last_error = left(p_detail, 500)
  WHERE o.id = p_id AND o.lease_owner = p_lease_owner AND o.status = 'LEASED';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Aether outcome event is not leased by this owner';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION selena_registry.enqueue_aether_outcome(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION selena_registry.tg_aether_outcome_from_attempt() FROM PUBLIC;
REVOKE ALL ON FUNCTION selena_registry.tg_aether_outcome_from_rejection() FROM PUBLIC;
REVOKE ALL ON FUNCTION selena_registry.claim_next_aether_outcome(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION selena_registry.record_aether_outcome_delivered(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION selena_registry.retry_or_dead_letter_aether_outcome(uuid, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION selena_registry.claim_next_aether_outcome(integer) TO selena_registry_worker_runtime;
GRANT EXECUTE ON FUNCTION selena_registry.record_aether_outcome_delivered(uuid, text) TO selena_registry_worker_runtime;
GRANT EXECUTE ON FUNCTION selena_registry.retry_or_dead_letter_aether_outcome(uuid, text, text) TO selena_registry_worker_runtime;

-- The worker reaches the outbox through the functions above, never the table —
-- the same invariant the inbound inbox keeps.
DO $$
BEGIN
  IF has_table_privilege('selena_registry_worker_runtime', 'selena_registry.aether_outcome_outbox', 'INSERT')
    OR has_table_privilege('selena_registry_worker_runtime', 'selena_registry.aether_outcome_outbox', 'UPDATE')
    OR has_table_privilege('selena_registry_worker_runtime', 'selena_registry.aether_outcome_outbox', 'DELETE')
    OR has_table_privilege('selena_registry_worker_runtime', 'selena_registry.aether_outcome_outbox', 'SELECT') THEN
    RAISE EXCEPTION 'The registry worker reaches the outcome outbox through functions only';
  END IF;
  IF has_function_privilege('selena_web_runtime', 'selena_registry.claim_next_aether_outcome(integer)', 'EXECUTE')
    OR has_function_privilege('selena_gateway_runtime', 'selena_registry.claim_next_aether_outcome(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Draining the outcome outbox belongs to the registry worker alone';
  END IF;
END $$;

RESET ROLE;

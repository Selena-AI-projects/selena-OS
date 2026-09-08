-- Durable provider budgets and a call ledger that survives every restart.
--
-- The process-scoped ProviderCallLedger starts at zero on each deploy, so the
-- ceiling it is compared against can never be reached across a deployment —
-- Stage 1's own comment calls it decoration and names this migration's tables
-- as the prerequisite for any live-call authorization. Money may only move
-- after a RESERVED row exists here, written inside one transaction under an
-- advisory lock, against a budget an interactive owner set. No budget row, no
-- cost estimate, or an unreachable ledger means the call does not happen.

CREATE TYPE selena_registry.budget_window AS ENUM ('DAY', 'MONTH');
--> statement-breakpoint
CREATE TYPE selena_registry.provider_call_status AS ENUM (
  'RESERVED', 'DISPATCHED', 'SETTLED', 'FAILED', 'EXPIRED'
);
--> statement-breakpoint

CREATE TABLE selena_registry.provider_budgets (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL REFERENCES "public"."organization"("id"),
  "brand_id" text NOT NULL REFERENCES "public"."brands"("id"),
  "provider_id" text NOT NULL CHECK ("provider_id" ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  "window_kind" selena_registry.budget_window NOT NULL,
  "ceiling_calls" integer NOT NULL CHECK ("ceiling_calls" > 0),
  "ceiling_cost_micros" bigint NOT NULL CHECK ("ceiling_cost_micros" >= 0),
  "set_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX provider_budgets_lookup_idx
  ON selena_registry.provider_budgets ("brand_id", "provider_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX provider_budgets_org_idx ON selena_registry.provider_budgets ("organization_id");
--> statement-breakpoint
ALTER TABLE selena_registry.provider_budgets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE selena_registry.provider_budgets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE TABLE selena_registry.provider_call_ledger (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL REFERENCES "public"."organization"("id"),
  "brand_id" text NOT NULL REFERENCES "public"."brands"("id"),
  "provider_id" text NOT NULL CHECK ("provider_id" ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  "purpose" text NOT NULL CHECK (length(btrim("purpose")) BETWEEN 1 AND 60),
  "idempotency_key" text NOT NULL CHECK (length(btrim("idempotency_key")) BETWEEN 1 AND 200),
  "status" selena_registry.provider_call_status DEFAULT 'RESERVED' NOT NULL,
  "estimated_calls" integer NOT NULL CHECK ("estimated_calls" > 0),
  "estimated_cost_micros" bigint NOT NULL CHECK ("estimated_cost_micros" >= 0),
  "actual_calls" integer CHECK ("actual_calls" >= 0),
  "actual_cost_micros" bigint CHECK ("actual_cost_micros" >= 0),
  "error_code" text,
  "correlation_id" uuid,
  "reserved_by" text NOT NULL,
  "reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
  "dispatched_at" timestamp with time zone,
  "settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX provider_call_ledger_key_unique
  ON selena_registry.provider_call_ledger ("organization_id", "brand_id", "provider_id", "idempotency_key");
--> statement-breakpoint
CREATE INDEX provider_call_ledger_window_idx
  ON selena_registry.provider_call_ledger ("brand_id", "provider_id", "reserved_at");
--> statement-breakpoint
CREATE INDEX provider_call_ledger_org_idx ON selena_registry.provider_call_ledger ("organization_id");
--> statement-breakpoint
ALTER TABLE selena_registry.provider_call_ledger ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE selena_registry.provider_call_ledger FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Reading is brand-scoped for the web runtime; writing goes only through the
-- definer functions below, so the web role gets no INSERT or UPDATE policy at
-- all, and budgets may be inserted only by an interactive owner.
CREATE POLICY provider_budgets_web_select ON selena_registry.provider_budgets
  FOR SELECT TO selena_web_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['web']));
--> statement-breakpoint
CREATE POLICY provider_budgets_web_insert ON selena_registry.provider_budgets
  FOR INSERT TO selena_web_runtime
  WITH CHECK (
    selena_registry.can_write_brand(organization_id, brand_id, ARRAY['web'])
    AND selena_registry.can_human_approve(organization_id, brand_id)
    AND set_by = current_setting('app.selena_actor_id', true)
  );
--> statement-breakpoint
CREATE POLICY provider_budgets_web_update_denied ON selena_registry.provider_budgets
  FOR UPDATE TO selena_web_runtime USING (false) WITH CHECK (false);
--> statement-breakpoint
CREATE POLICY provider_budgets_web_delete_denied ON selena_registry.provider_budgets
  FOR DELETE TO selena_web_runtime USING (false);
--> statement-breakpoint
CREATE TRIGGER provider_budgets_append_only
  BEFORE UPDATE OR DELETE ON selena_registry.provider_budgets
  FOR EACH ROW EXECUTE FUNCTION selena_audit.reject_immutable_mutation();
--> statement-breakpoint

CREATE POLICY provider_call_ledger_web_select ON selena_registry.provider_call_ledger
  FOR SELECT TO selena_web_runtime
  USING (selena_registry.can_access_brand(organization_id, brand_id, ARRAY['web']));
--> statement-breakpoint
CREATE POLICY provider_call_ledger_schema_owner_insert ON selena_registry.provider_call_ledger
  FOR INSERT TO selena_schema_owner WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY provider_call_ledger_schema_owner_update ON selena_registry.provider_call_ledger
  FOR UPDATE TO selena_schema_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY provider_budgets_schema_owner_insert ON selena_registry.provider_budgets
  FOR INSERT TO selena_schema_owner WITH CHECK (true);
--> statement-breakpoint

-- A settlement may move a row forward, never rewrite its identity or history.
CREATE FUNCTION selena_registry.enforce_provider_call_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'provider_call_ledger rows are never deleted';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.brand_id IS DISTINCT FROM OLD.brand_id
    OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
    OR NEW.purpose IS DISTINCT FROM OLD.purpose
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.estimated_calls IS DISTINCT FROM OLD.estimated_calls
    OR NEW.estimated_cost_micros IS DISTINCT FROM OLD.estimated_cost_micros
    OR NEW.reserved_by IS DISTINCT FROM OLD.reserved_by
    OR NEW.reserved_at IS DISTINCT FROM OLD.reserved_at THEN
    RAISE EXCEPTION 'a provider call reservation is immutable; only its status may advance';
  END IF;
  IF NOT (
    (OLD.status = 'RESERVED' AND NEW.status IN ('DISPATCHED', 'FAILED', 'EXPIRED'))
    OR (OLD.status = 'DISPATCHED' AND NEW.status IN ('SETTLED', 'FAILED'))
  ) THEN
    RAISE EXCEPTION 'illegal provider call transition % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER provider_call_ledger_transitions
  BEFORE UPDATE OR DELETE ON selena_registry.provider_call_ledger
  FOR EACH ROW EXECUTE FUNCTION selena_registry.enforce_provider_call_transition();
--> statement-breakpoint

-- The only door to a reservation. Runs in the caller's transaction, under an
-- advisory lock per (brand, provider), so two concurrent reserves cannot both
-- squeeze under the ceiling. Reservations count as spent until they expire.
CREATE FUNCTION selena_registry.reserve_provider_call(
  p_brand_id text,
  p_provider_id text,
  p_purpose text,
  p_idempotency_key text,
  p_estimated_calls integer,
  p_estimated_cost_micros bigint,
  p_correlation_id uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, selena_registry
AS $$
DECLARE
  v_organization_id text := current_setting('app.selena_organization_id', true);
  v_actor_id text := current_setting('app.selena_actor_id', true);
  v_budget selena_registry.provider_budgets%ROWTYPE;
  v_window_start timestamp with time zone;
  v_spent_calls bigint;
  v_spent_cost bigint;
  v_existing uuid;
  v_id uuid;
BEGIN
  IF NOT pg_has_role(session_user, 'selena_web_runtime', 'member')
    OR v_organization_id IS NULL OR v_actor_id IS NULL
    OR current_setting('app.selena_brand_id', true) IS DISTINCT FROM p_brand_id
    OR NOT selena_registry.can_write_brand(v_organization_id, p_brand_id, ARRAY['web']) THEN
    RAISE EXCEPTION 'PROVIDER_RESERVE_FORBIDDEN: an authenticated brand session is required';
  END IF;
  IF p_estimated_calls IS NULL OR p_estimated_calls <= 0
    OR p_estimated_cost_micros IS NULL OR p_estimated_cost_micros < 0 THEN
    RAISE EXCEPTION 'UNKNOWN_COST_BLOCKED: a reservation needs an estimated call count and cost';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('provider_budget:' || p_brand_id || ':' || p_provider_id));

  SELECT id INTO v_existing FROM selena_registry.provider_call_ledger
   WHERE organization_id = v_organization_id AND brand_id = p_brand_id
     AND provider_id = p_provider_id AND idempotency_key = p_idempotency_key
   LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  SELECT * INTO v_budget FROM selena_registry.provider_budgets
   WHERE organization_id = v_organization_id AND brand_id = p_brand_id
     AND provider_id = p_provider_id
   ORDER BY created_at DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROVIDER_BUDGET_MISSING: the owner has not set a budget for % on this brand', p_provider_id;
  END IF;

  v_window_start := date_trunc(CASE v_budget.window_kind WHEN 'DAY' THEN 'day' ELSE 'month' END, now());
  SELECT
    COALESCE(SUM(COALESCE(actual_calls, estimated_calls)), 0),
    COALESCE(SUM(COALESCE(actual_cost_micros, estimated_cost_micros)), 0)
    INTO v_spent_calls, v_spent_cost
    FROM selena_registry.provider_call_ledger
   WHERE organization_id = v_organization_id AND brand_id = p_brand_id
     AND provider_id = p_provider_id
     AND reserved_at >= v_window_start
     AND status <> 'EXPIRED';

  IF v_spent_calls + p_estimated_calls > v_budget.ceiling_calls THEN
    RAISE EXCEPTION 'PROVIDER_QUOTA_EXCEEDED: % of % calls already committed this %',
      v_spent_calls, v_budget.ceiling_calls, lower(v_budget.window_kind::text);
  END IF;
  IF v_spent_cost + p_estimated_cost_micros > v_budget.ceiling_cost_micros THEN
    RAISE EXCEPTION 'PROVIDER_QUOTA_EXCEEDED: budgeted cost for % is exhausted this %',
      p_provider_id, lower(v_budget.window_kind::text);
  END IF;

  INSERT INTO selena_registry.provider_call_ledger (
    organization_id, brand_id, provider_id, purpose, idempotency_key,
    estimated_calls, estimated_cost_micros, correlation_id, reserved_by
  ) VALUES (
    v_organization_id, p_brand_id, p_provider_id, btrim(p_purpose), btrim(p_idempotency_key),
    p_estimated_calls, p_estimated_cost_micros, p_correlation_id, v_actor_id
  ) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
--> statement-breakpoint

CREATE FUNCTION selena_registry.settle_provider_call(
  p_id uuid,
  p_status selena_registry.provider_call_status,
  p_actual_calls integer,
  p_actual_cost_micros bigint,
  p_error_code text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, selena_registry
AS $$
DECLARE
  v_organization_id text := current_setting('app.selena_organization_id', true);
  v_row selena_registry.provider_call_ledger%ROWTYPE;
BEGIN
  IF NOT pg_has_role(session_user, 'selena_web_runtime', 'member') OR v_organization_id IS NULL THEN
    RAISE EXCEPTION 'PROVIDER_SETTLE_FORBIDDEN: an authenticated session is required';
  END IF;
  SELECT * INTO v_row FROM selena_registry.provider_call_ledger
   WHERE id = p_id AND organization_id = v_organization_id
     AND brand_id = current_setting('app.selena_brand_id', true);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROVIDER_CALL_NOT_FOUND: no reservation % for this brand', p_id;
  END IF;
  UPDATE selena_registry.provider_call_ledger
     SET status = p_status,
         actual_calls = COALESCE(p_actual_calls, actual_calls),
         actual_cost_micros = COALESCE(p_actual_cost_micros, actual_cost_micros),
         error_code = p_error_code,
         dispatched_at = CASE WHEN p_status = 'DISPATCHED' THEN now() ELSE dispatched_at END,
         settled_at = CASE WHEN p_status IN ('SETTLED', 'FAILED', 'EXPIRED') THEN now() ELSE settled_at END
   WHERE id = p_id;
END;
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION selena_registry.reserve_provider_call(text, text, text, text, integer, bigint, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION selena_registry.settle_provider_call(uuid, selena_registry.provider_call_status, integer, bigint, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION selena_registry.reserve_provider_call(text, text, text, text, integer, bigint, uuid) TO selena_web_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION selena_registry.settle_provider_call(uuid, selena_registry.provider_call_status, integer, bigint, text) TO selena_web_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON selena_registry.provider_budgets TO selena_web_runtime;
--> statement-breakpoint
GRANT SELECT ON selena_registry.provider_call_ledger TO selena_web_runtime;
--> statement-breakpoint
GRANT USAGE ON TYPE selena_registry.budget_window TO selena_web_runtime;
--> statement-breakpoint
GRANT USAGE ON TYPE selena_registry.provider_call_status TO selena_web_runtime;

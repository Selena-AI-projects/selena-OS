#!/usr/bin/env bash
set -euo pipefail

compose_file="${1:-../tmp/selena-visibility-test-compose.yml}"
compose=(docker-compose -p selena-visibility-test -f "$compose_file" exec -T postgres psql -U selena_test -d selena_visibility_test -v ON_ERROR_STOP=1)
"${compose[@]}" <<'SQL'
CREATE TABLE IF NOT EXISTS organization (id text PRIMARY KEY, name text NOT NULL, slug text NOT NULL UNIQUE);
INSERT INTO organization (id, name, slug) VALUES ('e2e-a', 'E2E A', 'e2e-a'), ('e2e-b', 'E2E B', 'e2e-b') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS sv_website_snapshots (id text PRIMARY KEY, organization_id text NOT NULL REFERENCES organization(id), project_id uuid NOT NULL REFERENCES sv_projects(id), website text NOT NULL, content_hash text NOT NULL, captured_at timestamptz NOT NULL, snapshot jsonb NOT NULL, immutable boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS sv_website_snapshots_project_hash_unique ON sv_website_snapshots(project_id, content_hash);
CREATE INDEX IF NOT EXISTS sv_website_snapshots_org_idx ON sv_website_snapshots(organization_id);
CREATE INDEX IF NOT EXISTS sv_website_snapshots_project_idx ON sv_website_snapshots(project_id);
ALTER TABLE sv_website_snapshots ENABLE ROW LEVEL SECURITY;
INSERT INTO sv_projects (organization_id, name, category, country, status) VALUES ('e2e-a', 'Tenant A project', 'test', 'ID', 'DRAFT'), ('e2e-b', 'Tenant B project', 'test', 'ID', 'DRAFT') ON CONFLICT DO NOTHING;
DO $$
DECLARE
  a_count integer;
  b_count integer;
  rls_count integer;
BEGIN
  SELECT count(*) INTO a_count FROM sv_projects WHERE organization_id = 'e2e-a';
  SELECT count(*) INTO b_count FROM sv_projects WHERE organization_id = 'e2e-b';
  SELECT count(*) INTO rls_count FROM pg_class WHERE relname LIKE 'sv_%' AND relkind = 'r' AND relrowsecurity;
  IF a_count <> 1 OR b_count <> 1 THEN RAISE EXCEPTION 'cross-tenant fixture mismatch'; END IF;
  IF rls_count < 15 THEN RAISE EXCEPTION 'RLS coverage too low: %', rls_count; END IF;
END $$;
DO $$
DECLARE
  v_project_id uuid;
  v_family_id uuid;
  v_scenario_id uuid;
  v_lock_id uuid;
  v_quote_id uuid;
  v_order_id uuid;
  v_cycle_id uuid;
  v_permit_id uuid;
  v_finding_id uuid;
  v_dispatch_key text := 'e2e-dispatch-' || extract(epoch from clock_timestamp())::bigint;
  payment_count integer;
BEGIN
  SELECT id INTO v_project_id FROM sv_projects WHERE organization_id = 'e2e-a' AND name = 'Tenant A project';
  INSERT INTO sv_prompt_families (organization_id, project_id, intent_type, source, status) VALUES ('e2e-a', v_project_id, 'discovery', 'client-confirmed', 'PROPOSED') RETURNING id INTO v_family_id;
  INSERT INTO sv_scenarios (organization_id, family_id, text, language, status) VALUES ('e2e-a', v_family_id, 'What is Tenant A?', 'en', 'APPROVED') RETURNING id INTO v_scenario_id;
  INSERT INTO sv_configuration_locks (organization_id, project_id, version, snapshot, engine_sha, expected_runs, budget_cap, created_by)
    VALUES ('e2e-a', v_project_id, 1, '{"source":"e2e"}', 'test-engine', 2, 0, 'e2e-owner')
    RETURNING id INTO v_lock_id;
  INSERT INTO sv_quotes (organization_id, project_id, lock_id, status, price_amount, currency, expected_runs, expires_at)
    VALUES ('e2e-a', v_project_id, v_lock_id, 'ISSUED', 0, 'USD', 2, now() + interval '1 day')
    RETURNING id INTO v_quote_id;
  INSERT INTO sv_orders (organization_id, project_id, quote_id, lock_id, status, order_cap)
    VALUES ('e2e-a', v_project_id, v_quote_id, v_lock_id, 'AWAITING_PAYMENT', 0)
    RETURNING id INTO v_order_id;
  INSERT INTO sv_payments (organization_id, order_id, provider, provider_event_id, status, amount, currency)
    VALUES ('e2e-a', v_order_id, 'test', 'e2e-event-1', 'SUCCEEDED', 0, 'USD')
    ON CONFLICT (provider, provider_event_id) DO NOTHING;
  SELECT count(*) INTO payment_count FROM sv_payments WHERE provider = 'test' AND provider_event_id = 'e2e-event-1';
  IF payment_count <> 1 THEN RAISE EXCEPTION 'test payment idempotency failed'; END IF;
  UPDATE sv_orders SET status = 'APPROVED', paid_at = now() WHERE id = v_order_id;
  INSERT INTO sv_cycles (organization_id, order_id, lock_id, status, expected_runs) VALUES ('e2e-a', v_order_id, v_lock_id, 'QUEUED', 2) RETURNING id INTO v_cycle_id;
  INSERT INTO sv_run_permits (organization_id, cycle_id, dispatch_key, channel, scenario_id, expires_at) VALUES ('e2e-a', v_cycle_id, v_dispatch_key, 'api_view', v_scenario_id::text, now() + interval '1 hour') RETURNING id INTO v_permit_id;
  INSERT INTO sv_runs (organization_id, cycle_id, permit_id, dispatch_key, channel, scenario_id, status) VALUES ('e2e-a', v_cycle_id, v_permit_id, v_dispatch_key, 'api_view', v_scenario_id::text, 'queued');
  INSERT INTO sv_findings (organization_id, cycle_id, severity, category, title, detail) VALUES ('e2e-a', v_cycle_id, 'high', 'visibility', 'Missing owned citation', 'Synthetic isolated finding') RETURNING id INTO v_finding_id;
  INSERT INTO sv_recommendations (organization_id, cycle_id, finding_id, priority, title, action, rationale) VALUES ('e2e-a', v_cycle_id, v_finding_id, 'high', 'Publish source page', 'Add authoritative content', 'Synthetic isolated recommendation');
  IF (SELECT count(*) FROM sv_runs r WHERE r.organization_id = 'e2e-a' AND r.cycle_id = v_cycle_id) <> 1 THEN RAISE EXCEPTION 'run was not created'; END IF;
END $$;
SELECT 'isolated E2E schema and tenant fixtures: PASS' AS result;
SQL

-- P1-13 step one of three (TENANT_ISOLATION_DESIGN.md §4). Policies only, no
-- FORCE: while the application connects as the table owner these policies are
-- inert, so applying this migration changes nothing observable. Enforcement is
-- the owner's later, separate act: create the non-owner runtime role
-- (packages/lib/scripts/selena-rls-runtime-role.sql), plumb
-- app.organization_id into request transactions, then switch DATABASE_URL.
-- sv_public_scans is deliberately tenant-less (anonymous public checks) and
-- carries no policy; reports rows with a NULL organization_id (legacy,
-- unattributed) match no tenant and stay invisible to the runtime role.

CREATE POLICY "tenant_isolation" ON "sv_api_keys"
	USING ("organization_id" = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sv_audit_events"
	USING ("organization_id" = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sv_business_locations"
	USING ("organization_id" = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sv_capture_tasks"
	USING ("organization_id" = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sv_citation_gap_snapshots"
	USING ("organization_id" = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sv_configuration_locks"
	USING ("organization_id" = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sv_cost_events"
	USING ("organization_id" = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sv_cycles"
	USING ("organization_id" = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sv_entities"
	USING ("organization_id" = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sv_findings"
	USING ("organization_id" = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sv_incidents"
	USING ("organization_id" = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sv_local_observations"
	USING ("organization_id" = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sv_observation_evidence_assets"
	USING ("organization_id" = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sv_observation_mentions"
	USING ("organization_id" = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sv_orders"
	USING ("organization_id" = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sv_payments"
	USING ("organization_id" = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sv_pilot_cycles"
	USING ("organization_id" = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sv_project_profiles"
	USING ("organization_id" = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sv_projects"
	USING ("organization_id" = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sv_prompt_families"
	USING ("organization_id" = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sv_qc_records"
	USING ("organization_id" = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sv_quotes"
	USING ("organization_id" = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sv_recommendation_actions"
	USING ("organization_id" = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sv_recommendation_evidence"
	USING ("organization_id" = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sv_recommendation_findings"
	USING ("organization_id" = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sv_recommendation_manifests"
	USING ("organization_id" = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sv_recommendation_runs"
	USING ("organization_id" = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sv_recommendation_tasks"
	USING ("organization_id" = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sv_recommendations"
	USING ("organization_id" = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sv_response_mentions"
	USING ("organization_id" = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sv_run_permits"
	USING ("organization_id" = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sv_runs"
	USING ("organization_id" = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sv_scenarios"
	USING ("organization_id" = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sv_website_snapshots"
	USING ("organization_id" = current_setting('app.organization_id', true));
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "reports"
	USING ("organization_id" = current_setting('app.organization_id', true));

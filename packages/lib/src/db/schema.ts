import { sql } from "drizzle-orm";
import {
	boolean,
	index,
	integer,
	json,
	jsonb,
	numeric,
	pgEnum,
	pgSchema,
	pgTable,
	smallint,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
// `organization` is referenced by the brands FK below; the re-export makes it
// (and the rest of the auth schema) visible to `import * as schema` consumers.
import { organization } from "./schema-auth";

// Better-auth tables & relations — re-exported so `import * as schema` sees everything.
// Source file is auto-generated; run `pnpm run generate:auth-schema` to refresh.
export * from "./schema-auth";

// ============================================================================
// Application tables
// ============================================================================

export const reportStatusEnum = pgEnum("report_status", ["pending", "processing", "completed", "failed"]);

export const brands = pgTable(
	"brands",
	{
		id: text("id").primaryKey().notNull(),
		name: text("name").notNull(),
		website: text("website").notNull(),
		additionalDomains: text("additional_domains").array().notNull().default([]),
		aliases: text("aliases").array().notNull().default([]),
		enabled: boolean("enabled").default(true).notNull(),
		onboarded: boolean("onboarded").default(false).notNull(),
		delayOverrideHours: integer("delay_override_hours"),
		enabledModels: text("enabled_models").array(),
		// Hard tenancy scope. Every brand belongs to exactly one better-auth
		// organization; org membership (the `member` table) is the access-control
		// mechanism — see apps/web/src/lib/auth/helpers.ts. Historically `brand.id`
		// equalled `organization.id`; the 0010 backfill makes that mapping explicit
		// so cloud entitlements/metering/enforcement can join on it.
		organizationId: text("organization_id")
			.references(() => organization.id)
			.notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => ({
		organizationIdIdx: index("brands_organization_id_idx").on(table.organizationId),
	}),
).enableRLS();

export const prompts = pgTable(
	"prompts",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		brandId: text("brand_id")
			.references(() => brands.id)
			.notNull(),
		value: text("value").notNull(),
		enabled: boolean("enabled").default(true).notNull(),
		/**
		 * Premium models this prompt is tracked on, grounded: one org premium slot
		 * per entry (see PREMIUM_MODELS). Empty = standard tracking only.
		 */
		premiumModels: text("premium_models").array().notNull().default([]),
		tags: text("tags").array().notNull().default([]),
		systemTags: text("system_tags").array().notNull().default([]),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => ({
		brandIdIdx: index("prompts_brand_id_idx").on(table.brandId),
		brandIdEnabledIdx: index("prompts_brand_id_enabled_idx").on(table.brandId, table.enabled),
	}),
).enableRLS();

export const competitors = pgTable("competitors", {
	id: uuid("id").defaultRandom().primaryKey().notNull(),
	brandId: text("brand_id")
		.references(() => brands.id)
		.notNull(),
	name: text("name").notNull(),
	domains: text("domains").array().notNull().default([]),
	aliases: text("aliases").array().notNull().default([]),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.defaultNow()
		.$onUpdate(() => new Date())
		.notNull(),
}).enableRLS();

export const promptRuns = pgTable(
	"prompt_runs",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		promptId: uuid("prompt_id")
			.references(() => prompts.id)
			.notNull(),
		brandId: text("brand_id")
			.references(() => brands.id)
			.notNull(),
		model: text("model").notNull(),
		provider: text("provider"),
		version: text("version").notNull(),
		webSearchEnabled: boolean("web_search_enabled").notNull(),
		rawOutput: json("raw_output").notNull(),
		webQueries: text("web_queries").array().notNull().default([]),
		brandMentioned: boolean("brand_mentioned").notNull(),
		competitorsMentioned: text("competitors_mentioned").array().notNull().default([]),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({
		promptIdCreatedAtIdx: index("prompt_runs_prompt_id_created_at_idx").on(table.promptId, table.createdAt),
		createdAtIdx: index("prompt_runs_created_at_idx").on(table.createdAt),
		webSearchCreatedAtIdx: index("prompt_runs_web_search_created_at_idx").on(table.webSearchEnabled, table.createdAt),
		webSearchModelCreatedAtIdx: index("prompt_runs_web_search_model_created_at_idx").on(
			table.webSearchEnabled,
			table.model,
			table.createdAt,
		),
		providerIdx: index("prompt_runs_provider_idx").on(table.provider),
		modelCreatedAtIdx: index("prompt_runs_model_created_at_idx").on(table.model, table.createdAt),
	}),
).enableRLS();

export const citations = pgTable(
	"citations",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		promptRunId: uuid("prompt_run_id")
			.references(() => promptRuns.id)
			.notNull(),
		promptId: uuid("prompt_id")
			.references(() => prompts.id)
			.notNull(),
		brandId: text("brand_id")
			.references(() => brands.id)
			.notNull(),
		model: text("model").notNull(),
		url: text("url").notNull(),
		domain: text("domain").notNull(),
		title: text("title"),
		citationIndex: smallint("citation_index").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
	},
	(table) => ({
		brandAnalyticsIdx: index("idx_citations_brand_analytics").on(
			table.brandId,
			table.createdAt,
			table.url,
			table.domain,
			table.title,
			table.promptId,
			table.model,
		),
		promptCreatedIdx: index("citations_prompt_id_created_at_idx").on(table.promptId, table.createdAt),
		domainIdx: index("citations_domain_idx").on(table.domain),
	}),
).enableRLS();

export const reports = pgTable(
	"reports",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		brandName: text("brand_name").notNull(),
		brandWebsite: text("brand_website").notNull(),
		status: reportStatusEnum().notNull().default("pending"),
		progress: integer("progress").notNull().default(0),
		rawOutput: json("raw_output"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => ({
		createdAtIdx: index("reports_created_at_idx").on(table.createdAt),
	}),
).enableRLS();

// One row per generated Opportunities report, per brand — append-only history
// (every generation is kept, not overwritten). The page reads the latest row and
// regenerates only when it's stale; see apps/web/src/server/opportunities.ts.
export const brandOpportunities = pgTable(
	"brand_opportunities",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		brandId: text("brand_id")
			.references(() => brands.id)
			.notNull(),
		/** The full enriched opportunities report the page renders (OpportunitiesReport JSON). */
		report: json("report").notNull(),
		/** Model/provider that generated it, when known. */
		model: text("model"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({
		brandCreatedIdx: index("brand_opportunities_brand_id_created_at_idx").on(table.brandId, table.createdAt),
	}),
).enableRLS();

export type BrandOpportunity = typeof brandOpportunities.$inferSelect;
export type NewBrandOpportunity = typeof brandOpportunities.$inferInsert;

export type Brand = typeof brands.$inferSelect;
export type NewBrand = typeof brands.$inferInsert;

export type Prompt = typeof prompts.$inferSelect;
export type NewPrompt = typeof prompts.$inferInsert;

export type Competitor = typeof competitors.$inferSelect;
export type NewCompetitor = typeof competitors.$inferInsert;

export type PromptRun = typeof promptRuns.$inferSelect;
export type NewPromptRun = typeof promptRuns.$inferInsert;

export type BrandWithPrompts = Brand & {
	prompts: Prompt[];
	competitors: Competitor[];
};

export type CitationRecord = typeof citations.$inferSelect;
export type NewCitationRecord = typeof citations.$inferInsert;

export type Report = typeof reports.$inferSelect;
export type NewReport = typeof reports.$inferInsert;

export const SYSTEM_TAGS = {
	BRANDED: "branded",
	UNBRANDED: "unbranded",
} as const;

export type SystemTag = (typeof SYSTEM_TAGS)[keyof typeof SYSTEM_TAGS];

/**
 * Cloud billing/entitlement state we own per organization (as opposed to the
 * better-auth-managed `subscription` table). One optional row per org:
 * - entitlementOverrides: sparse custom-plan overrides (see
 *   entitlementOverridesSchema in @workspace/config/entitlements) — the
 *   config-only lever for custom plans
 * - premiumAddonQuantity: purchased extra premium slots, synced from Stripe
 *   subscription items by the billing webhook
 * Absent row = no overrides, no add-on. Unused outside cloud.
 */
export const organizationSettings = pgTable("organization_settings", {
	organizationId: text("organization_id")
		.primaryKey()
		.notNull()
		.references(() => organization.id),
	entitlementOverrides: jsonb("entitlement_overrides"),
	premiumAddonQuantity: integer("premium_addon_quantity").notNull().default(0),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.defaultNow()
		.$onUpdate(() => new Date())
		.notNull(),
}).enableRLS();

export type OrganizationSettings = typeof organizationSettings.$inferSelect;

/**
 * Billing-grade usage attribution: one row per provider call the
 * worker makes, so every run is attributable to an org with an estimated
 * cost. Written in every mode (self-hosted operators get the same spend
 * visibility); estimated costs come from the tunable table in
 * src/usage/cost.ts and are validated against provider invoices, not treated
 * as ground truth.
 */
export const usageEvents = pgTable(
	"usage_events",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		organizationId: text("organization_id").notNull(),
		brandId: text("brand_id").notNull(),
		promptId: uuid("prompt_id"),
		eventType: text("event_type").notNull(),
		provider: text("provider"),
		model: text("model"),
		webSearchEnabled: boolean("web_search_enabled").notNull().default(false),
		units: integer("units").notNull().default(1),
		estimatedCostUsd: numeric("estimated_cost_usd", { precision: 12, scale: 6 }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({
		orgCreatedIdx: index("usage_events_org_created_idx").on(table.organizationId, table.createdAt),
	}),
).enableRLS();

export type UsageEvent = typeof usageEvents.$inferSelect;

// AI Visibility client domain. These tables are intentionally additive:
// Elmo brands/prompts/prompt_runs remain the measurement engine's source of
// truth, while these records provide immutable commercial configuration and
// order-scoped client workflow around it.
export const svProjectStatusEnum = pgEnum("sv_project_status", ["DRAFT", "ACTIVE", "ARCHIVED"]);
export const svScenarioStatusEnum = pgEnum("sv_scenario_status", ["PROPOSED", "APPROVED", "REJECTED"]);
export const svQuoteStatusEnum = pgEnum("sv_quote_status", ["DRAFT", "ISSUED", "EXPIRED", "ACCEPTED", "CANCELLED"]);
export const svOrderStatusEnum = pgEnum("sv_order_status", [
	"DRAFT",
	"CONFIGURING",
	"QUOTED",
	"AWAITING_PAYMENT",
	"PAID_REVIEW_REQUIRED",
	"APPROVED",
	"QUEUED",
	"RUNNING",
	"ANALYZING",
	"QC_REQUIRED",
	"READY",
	"DELIVERED",
	"PAYMENT_FAILED",
	"PREFLIGHT_BLOCKED",
	"BUDGET_BLOCKED",
	"PROVIDER_BLOCKED",
	"CARDINALITY_INCIDENT",
	"PARTIAL_FAILURE",
	"CANCELLED",
	"REFUND_REVIEW",
]);
export const svCycleStatusEnum = pgEnum("sv_cycle_status", [
	"CREATED",
	"APPROVED",
	"QUEUED",
	"RUNNING",
	"ANALYZING",
	"QC_REQUIRED",
	"READY",
	"STOPPED",
	"FAILED",
	"CARDINALITY_INCIDENT",
]);
export const svScanStatusEnum = pgEnum("sv_scan_status", ["PENDING", "COMPLETED", "FAILED"]);
export const svFindingStatusEnum = pgEnum("sv_finding_status", ["OPEN", "ACCEPTED", "DISMISSED"]);
export const svPaymentStatusEnum = pgEnum("sv_payment_status", ["PENDING", "SUCCEEDED", "FAILED", "CANCELLED"]);
export const svApiKeys = pgTable(
	"sv_api_keys",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		name: text("name").notNull(),
		keyHash: text("key_hash").notNull().unique(),
		permissions: text("permissions").array().notNull().default([]),
		expiresAt: timestamp("expires_at", { withTimezone: true }),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
		createdBy: text("created_by").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({
		orgIdx: index("sv_api_keys_org_idx").on(table.organizationId),
		activeIdx: index("sv_api_keys_active_idx").on(table.organizationId, table.revokedAt),
	}),
).enableRLS();

export const svProjects = pgTable(
	"sv_projects",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		name: text("name").notNull(),
		category: text("category").notNull(),
		country: text("country").notNull(),
		region: text("region"),
		languages: text("languages").array().notNull().default([]),
		status: svProjectStatusEnum().notNull().default("DRAFT"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({
		orgIdx: index("sv_projects_org_idx").on(table.organizationId),
		orgNameUnique: uniqueIndex("sv_projects_org_name_unique").on(table.organizationId, table.name),
	}),
).enableRLS();

export const svPromptFamilies = pgTable(
	"sv_prompt_families",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		projectId: uuid("project_id")
			.notNull()
			.references(() => svProjects.id),
		intentType: text("intent_type").notNull(),
		source: text("source").notNull(),
		status: svScenarioStatusEnum().notNull().default("PROPOSED"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({ projectIdx: index("sv_prompt_families_project_idx").on(table.projectId) }),
).enableRLS();

export const svScenarios = pgTable(
	"sv_scenarios",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		familyId: uuid("family_id")
			.notNull()
			.references(() => svPromptFamilies.id),
		text: text("text").notNull(),
		language: text("language").notNull(),
		status: svScenarioStatusEnum().notNull().default("PROPOSED"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({
		familyIdx: index("sv_scenarios_family_idx").on(table.familyId),
		orgIdx: index("sv_scenarios_org_idx").on(table.organizationId),
	}),
).enableRLS();

export const svConfigurationLocks = pgTable(
	"sv_configuration_locks",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		projectId: uuid("project_id")
			.notNull()
			.references(() => svProjects.id),
		version: integer("version").notNull(),
		snapshot: jsonb("snapshot").notNull(),
		engineSha: text("engine_sha").notNull(),
		expectedRuns: integer("expected_runs").notNull(),
		budgetCap: numeric("budget_cap", { precision: 12, scale: 6 }).notNull(),
		createdBy: text("created_by").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({ projectVersionIdx: index("sv_locks_project_version_idx").on(table.projectId, table.version) }),
).enableRLS();

export const svQuotes = pgTable(
	"sv_quotes",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		projectId: uuid("project_id")
			.notNull()
			.references(() => svProjects.id),
		lockId: uuid("lock_id")
			.notNull()
			.references(() => svConfigurationLocks.id),
		status: svQuoteStatusEnum().notNull().default("DRAFT"),
		priceAmount: numeric("price_amount", { precision: 12, scale: 2 }).notNull(),
		currency: text("currency").notNull(),
		expectedRuns: integer("expected_runs").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({
		orgIdx: index("sv_quotes_org_idx").on(table.organizationId),
		projectIdx: index("sv_quotes_project_idx").on(table.projectId),
	}),
).enableRLS();

export const svOrders = pgTable(
	"sv_orders",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		projectId: uuid("project_id")
			.notNull()
			.references(() => svProjects.id),
		quoteId: uuid("quote_id")
			.notNull()
			.references(() => svQuotes.id),
		lockId: uuid("lock_id")
			.notNull()
			.references(() => svConfigurationLocks.id),
		status: svOrderStatusEnum().notNull().default("DRAFT"),
		orderCap: numeric("order_cap", { precision: 12, scale: 6 }).notNull(),
		paidAt: timestamp("paid_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({
		orgIdx: index("sv_orders_org_idx").on(table.organizationId),
		statusIdx: index("sv_orders_status_idx").on(table.status),
	}),
).enableRLS();

export const svCycles = pgTable(
	"sv_cycles",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		orderId: uuid("order_id")
			.notNull()
			.references(() => svOrders.id),
		lockId: uuid("lock_id")
			.notNull()
			.references(() => svConfigurationLocks.id),
		status: svCycleStatusEnum().notNull().default("CREATED"),
		expectedRuns: integer("expected_runs").notNull(),
		createdRuns: integer("created_runs").notNull().default(0),
		completedRuns: integer("completed_runs").notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({
		orderIdx: index("sv_cycles_order_idx").on(table.orderId),
		orgIdx: index("sv_cycles_org_idx").on(table.organizationId),
	}),
).enableRLS();

export const svPublicScans = pgTable(
	"sv_public_scans",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		projectId: uuid("project_id").references(() => svProjects.id),
		website: text("website").notNull(),
		status: svScanStatusEnum().notNull().default("PENDING"),
		result: jsonb("result"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => ({
		projectIdx: index("sv_public_scans_project_idx").on(table.projectId),
		createdIdx: index("sv_public_scans_created_idx").on(table.createdAt),
	}),
).enableRLS();
export const svPayments = pgTable(
	"sv_payments",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		orderId: uuid("order_id")
			.notNull()
			.references(() => svOrders.id),
		provider: text("provider").notNull().default("test"),
		providerEventId: text("provider_event_id").notNull(),
		status: svPaymentStatusEnum().notNull().default("PENDING"),
		amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
		currency: text("currency").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({
		eventUnique: uniqueIndex("sv_payments_provider_event_unique").on(table.provider, table.providerEventId),
		orgIdx: index("sv_payments_org_idx").on(table.organizationId),
	}),
).enableRLS();
export const svFindings = pgTable(
	"sv_findings",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		cycleId: uuid("cycle_id")
			.notNull()
			.references(() => svCycles.id),
		severity: text("severity").notNull(),
		category: text("category").notNull(),
		title: text("title").notNull(),
		detail: text("detail").notNull(),
		status: svFindingStatusEnum().notNull().default("OPEN"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({
		cycleIdx: index("sv_findings_cycle_idx").on(table.cycleId),
		orgIdx: index("sv_findings_org_idx").on(table.organizationId),
	}),
).enableRLS();
export const svRecommendations = pgTable(
	"sv_recommendations",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		cycleId: uuid("cycle_id")
			.notNull()
			.references(() => svCycles.id),
		findingId: uuid("finding_id").references(() => svFindings.id),
		priority: text("priority").notNull(),
		title: text("title").notNull(),
		action: text("action").notNull(),
		rationale: text("rationale").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({
		cycleIdx: index("sv_recommendations_cycle_idx").on(table.cycleId),
		orgIdx: index("sv_recommendations_org_idx").on(table.organizationId),
	}),
).enableRLS();
export const svProjectProfiles = pgTable(
	"sv_project_profiles",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		projectId: uuid("project_id")
			.notNull()
			.references(() => svProjects.id),
		brandName: text("brand_name").notNull(),
		primaryDomain: text("primary_domain").notNull(),
		publicProfiles: jsonb("public_profiles").notNull().default([]),
		competitorSnapshot: jsonb("competitor_snapshot").notNull().default([]),
		scenarioSnapshot: jsonb("scenario_snapshot").notNull().default([]),
		confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
		confirmedBy: text("confirmed_by"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({
		projectUnique: uniqueIndex("sv_project_profiles_project_unique").on(table.projectId),
		orgIdx: index("sv_project_profiles_org_idx").on(table.organizationId),
	}),
).enableRLS();
export const svWebsiteSnapshots = pgTable(
	"sv_website_snapshots",
	{
		id: text("id").primaryKey().notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		projectId: uuid("project_id")
			.notNull()
			.references(() => svProjects.id),
		website: text("website").notNull(),
		contentHash: text("content_hash").notNull(),
		capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
		snapshot: jsonb("snapshot").notNull(),
		immutable: boolean("immutable").notNull().default(true),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({
		hashUnique: uniqueIndex("sv_website_snapshots_project_hash_unique").on(table.projectId, table.contentHash),
		orgIdx: index("sv_website_snapshots_org_idx").on(table.organizationId),
		projectIdx: index("sv_website_snapshots_project_idx").on(table.projectId),
	}),
).enableRLS();
export const svRunPermits = pgTable(
	"sv_run_permits",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		cycleId: uuid("cycle_id")
			.notNull()
			.references(() => svCycles.id),
		dispatchKey: text("dispatch_key").notNull(),
		channel: text("channel").notNull(),
		scenarioId: text("scenario_id").notNull(),
		status: text("status").notNull().default("issued"),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		consumedAt: timestamp("consumed_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({
		dispatchUnique: uniqueIndex("sv_run_permits_dispatch_key_unique").on(table.dispatchKey),
		orgCycleIdx: index("sv_run_permits_org_cycle_idx").on(table.organizationId, table.cycleId),
	}),
).enableRLS();
export const svRuns = pgTable(
	"sv_runs",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		cycleId: uuid("cycle_id")
			.notNull()
			.references(() => svCycles.id),
		permitId: uuid("permit_id")
			.notNull()
			.references(() => svRunPermits.id),
		dispatchKey: text("dispatch_key").notNull(),
		channel: text("channel").notNull(),
		scenarioId: text("scenario_id").notNull(),
		status: text("status").notNull().default("queued"),
		rawResponseReference: text("raw_response_reference"),
		canonicalPayload: jsonb("canonical_payload"),
		startedAt: timestamp("started_at", { withTimezone: true }),
		finishedAt: timestamp("finished_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({
		dispatchUnique: uniqueIndex("sv_runs_dispatch_key_unique").on(table.dispatchKey),
		orgCycleIdx: index("sv_runs_org_cycle_idx").on(table.organizationId, table.cycleId),
	}),
).enableRLS();

export const svRecommendationRunStatusEnum = pgEnum("sv_recommendation_run_status", ["RUNNING", "READY", "FAILED"]);
export const svRecommendationRuns = pgTable(
	"sv_recommendation_runs",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		projectId: uuid("project_id")
			.notNull()
			.references(() => svProjects.id),
		idempotencyKey: text("idempotency_key").notNull(),
		datasetId: text("dataset_id").notNull(),
		inputHash: text("input_hash").notNull(),
		rulepackVersion: text("rulepack_version").notNull(),
		status: svRecommendationRunStatusEnum().notNull().default("RUNNING"),
		groundingStatus: text("grounding_status").notNull().default("PENDING"),
		actionPlan: jsonb("action_plan"),
		createdBy: text("created_by").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => ({
		idempotencyUnique: uniqueIndex("sv_recommendation_runs_org_idempotency_unique").on(
			table.organizationId,
			table.idempotencyKey,
		),
		projectIdx: index("sv_recommendation_runs_project_idx").on(table.projectId),
		orgIdx: index("sv_recommendation_runs_org_idx").on(table.organizationId),
	}),
).enableRLS();
export const svRecommendationManifests = pgTable(
	"sv_recommendation_manifests",
	{
		id: text("id").primaryKey().notNull(),
		runId: uuid("run_id")
			.notNull()
			.references(() => svRecommendationRuns.id),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		datasetId: text("dataset_id").notNull(),
		inputHash: text("input_hash").notNull(),
		snapshotIds: text("snapshot_ids").array().notNull().default([]),
		evidenceIds: text("evidence_ids").array().notNull().default([]),
		rulepackVersion: text("rulepack_version").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({
		runUnique: uniqueIndex("sv_recommendation_manifests_run_unique").on(table.runId),
		orgIdx: index("sv_recommendation_manifests_org_idx").on(table.organizationId),
	}),
).enableRLS();
export const svRecommendationEvidence = pgTable(
	"sv_recommendation_evidence",
	{
		id: text("id").notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		runId: uuid("run_id")
			.notNull()
			.references(() => svRecommendationRuns.id),
		snapshotId: text("snapshot_id").notNull(),
		kind: text("kind").notNull(),
		accessClass: text("access_class").notNull(),
		sourceRef: text("source_ref").notNull(),
		capturedAt: text("captured_at").notNull(),
		subject: text("subject").notNull(),
		text: text("text").notNull(),
		metadata: jsonb("metadata").notNull().default({}),
	},
	(table) => ({
		pk: uniqueIndex("sv_recommendation_evidence_run_id_unique").on(table.runId, table.id),
		orgIdx: index("sv_recommendation_evidence_org_idx").on(table.organizationId),
	}),
).enableRLS();
export const svRecommendationFindings = pgTable(
	"sv_recommendation_findings",
	{
		id: text("id").notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		runId: uuid("run_id")
			.notNull()
			.references(() => svRecommendationRuns.id),
		category: text("category").notNull(),
		statement: text("statement").notNull(),
		evidenceIds: text("evidence_ids").array().notNull(),
		confidence: text("confidence").notNull(),
		confidenceScore: numeric("confidence_score", { precision: 5, scale: 4 }).notNull(),
		severity: text("severity").notNull(),
		unknown: boolean("unknown").notNull(),
		ruleId: text("rule_id").notNull(),
	},
	(table) => ({
		pk: uniqueIndex("sv_recommendation_findings_run_id_unique").on(table.runId, table.id),
		orgIdx: index("sv_recommendation_findings_org_idx").on(table.organizationId),
	}),
).enableRLS();
export const svRecommendationActions = pgTable(
	"sv_recommendation_actions",
	{
		id: text("id").notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		runId: uuid("run_id")
			.notNull()
			.references(() => svRecommendationRuns.id),
		findingId: text("finding_id").notNull(),
		title: text("title").notNull(),
		action: text("action").notNull(),
		rationale: text("rationale").notNull(),
		evidenceIds: text("evidence_ids").array().notNull(),
		priority: text("priority").notNull(),
		effort: text("effort").notNull(),
		confidence: text("confidence").notNull(),
		blocked: boolean("blocked").notNull(),
		blockReason: text("block_reason"),
	},
	(table) => ({
		pk: uniqueIndex("sv_recommendation_actions_run_id_unique").on(table.runId, table.id),
		orgIdx: index("sv_recommendation_actions_org_idx").on(table.organizationId),
	}),
).enableRLS();
export const svRecommendationTasks = pgTable(
	"sv_recommendation_tasks",
	{
		id: text("id").notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		runId: uuid("run_id")
			.notNull()
			.references(() => svRecommendationRuns.id),
		recommendationId: text("recommendation_id").notNull(),
		title: text("title").notNull(),
		horizon: text("horizon").notNull(),
		owner: text("owner").notNull(),
		steps: text("steps").array().notNull(),
		evidenceIds: text("evidence_ids").array().notNull(),
		verificationPlan: text("verification_plan").array().notNull(),
	},
	(table) => ({
		pk: uniqueIndex("sv_recommendation_tasks_run_id_unique").on(table.runId, table.id),
		orgIdx: index("sv_recommendation_tasks_org_idx").on(table.organizationId),
	}),
).enableRLS();

// Selena OS Content Control Plane. These schemas are intentionally private:
// browser code never receives a database credential or Data API access to them.
export const selenaRegistrySchema = pgSchema("selena_registry");
export const selenaReleaseSchema = pgSchema("selena_release");
export const selenaAuditSchema = pgSchema("selena_audit");
export const selenaIngestRawSchema = pgSchema("selena_ingest_raw");
export const selenaPerformanceSchema = pgSchema("selena_performance");

export const scrContentStatusEnum = selenaRegistrySchema.enum("content_status", [
	"DRAFT",
	"IN_REVIEW",
	"APPROVED",
	"RELEASED",
	"ARCHIVED",
]);
export const scrAssetScanStatusEnum = selenaRegistrySchema.enum("asset_scan_status", [
	"QUARANTINED",
	"SCANNING",
	"CLEAN",
	"REJECTED",
]);
export const scrApprovalDecisionEnum = selenaRegistrySchema.enum("approval_decision", [
	"APPROVED",
	"REJECTED",
	"REVOKED",
]);
export const scrReleaseManifestStatusEnum = selenaReleaseSchema.enum("manifest_status", [
	"READY",
	"INVALIDATED",
	"DISPATCHED",
	"CANCELLED",
	"EXPIRED",
]);
export const scrReleaseIntentStatusEnum = selenaReleaseSchema.enum("release_intent_status", [
	"QUEUED",
	"DISPATCHING",
	"BLOCKED",
	"CANCELLED",
	"CANCEL_REQUESTED",
	"SUCCEEDED",
	"UNKNOWN",
	"FAILED",
]);
export const scrOutboxEventStatusEnum = selenaReleaseSchema.enum("outbox_event_status", [
	"PENDING",
	"LEASED",
	"DELIVERED",
	"DEAD_LETTER",
	"CANCELLED",
]);
export const scrPublicationAttemptStatusEnum = selenaReleaseSchema.enum("publication_attempt_status", [
	"RESERVED",
	"NOT_SENT",
	"ACCEPTED",
	"DEFINITIVE_FAILURE",
	"AMBIGUOUS",
	"RECONCILE_REQUIRED",
	"CONFIRMED",
	"MANUAL_REVIEW",
]);
export const scrIncidentStatusEnum = selenaAuditSchema.enum("incident_status", ["OPEN", "INVESTIGATING", "RESOLVED"]);
export const scrMetricQualityEnum = selenaPerformanceSchema.enum("metric_quality", [
	"COMPLETE",
	"PARTIAL",
	"STALE",
	"QUARANTINED",
]);
export const scrKillSwitchScopeEnum = selenaRegistrySchema.enum("kill_switch_scope", ["GLOBAL", "BRAND", "ACCOUNT"]);
export const scrReleaseEnvironmentEnum = selenaRegistrySchema.enum("release_environment", [
	"PRODUCTION",
	"STAGING",
	"DRY_RUN",
]);

export const scrContentPolicies = selenaRegistrySchema
	.table(
		"content_policies",
		{
			id: uuid("id").defaultRandom().primaryKey().notNull(),
			organizationId: text("organization_id")
				.notNull()
				.references(() => organization.id),
			brandId: text("brand_id")
				.notNull()
				.references(() => brands.id),
			policyVersion: text("policy_version").notNull(),
			requireEvidence: boolean("require_evidence").notNull().default(false),
			createdBy: text("created_by").notNull(),
			createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
			updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
		},
		(table) => ({
			brandVersionUnique: uniqueIndex("scr_content_policies_brand_version_unique").on(
				table.brandId,
				table.policyVersion,
			),
			orgIdx: index("scr_content_policies_org_idx").on(table.organizationId),
		}),
	)
	.enableRLS();

export const scrChannelAccounts = selenaRegistrySchema
	.table(
		"channel_accounts",
		{
			id: uuid("id").defaultRandom().primaryKey().notNull(),
			organizationId: text("organization_id")
				.notNull()
				.references(() => organization.id),
			brandId: text("brand_id")
				.notNull()
				.references(() => brands.id),
			platform: text("platform").notNull(),
			providerAccountRef: text("provider_account_ref").notNull(),
			providerIntegrationId: text("provider_integration_id"),
			status: text("status").notNull().default("ACTIVE"),
			allowlisted: boolean("allowlisted").notNull().default(true),
			createdBy: text("created_by").notNull(),
			createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
			updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
		},
		(table) => ({
			brandIdx: index("scr_channel_accounts_brand_idx").on(table.brandId),
			orgIdx: index("scr_channel_accounts_org_idx").on(table.organizationId),
			brandPlatformRefUnique: uniqueIndex("scr_channel_accounts_brand_platform_ref_unique").on(
				table.brandId,
				table.platform,
				table.providerAccountRef,
			),
		}),
	)
	.enableRLS();

export const scrGrowthProjectBindings = selenaRegistrySchema
	.table(
		"growth_project_bindings",
		{
			id: uuid("id").defaultRandom().primaryKey().notNull(),
			organizationId: text("organization_id")
				.notNull()
				.references(() => organization.id),
			brandId: text("brand_id")
				.notNull()
				.references(() => brands.id),
			aetherProjectId: uuid("aether_project_id").notNull(),
			aetherBusinessKey: text("aether_business_key").notNull(),
			sourceEnvironment: text("source_environment").notNull(),
			confirmedBy: text("confirmed_by").notNull(),
			confirmedAt: timestamp("confirmed_at", { withTimezone: true }).defaultNow().notNull(),
			revokedAt: timestamp("revoked_at", { withTimezone: true }),
			revokedBy: text("revoked_by"),
			revokeReason: text("revoke_reason"),
		},
		(table) => ({
			activeUnique: uniqueIndex("scr_growth_project_bindings_active_unique")
				.on(table.aetherProjectId, table.sourceEnvironment)
				.where(sql`revoked_at is null`),
			brandIdx: index("scr_growth_project_bindings_brand_idx").on(table.brandId),
			orgIdx: index("scr_growth_project_bindings_org_idx").on(table.organizationId),
		}),
	)
	.enableRLS();

export const scrChannelProviderBindings = selenaRegistrySchema
	.table(
		"channel_provider_bindings",
		{
			id: uuid("id").defaultRandom().primaryKey().notNull(),
			organizationId: text("organization_id")
				.notNull()
				.references(() => organization.id),
			brandId: text("brand_id")
				.notNull()
				.references(() => brands.id),
			channelAccountId: uuid("channel_account_id")
				.notNull()
				.references(() => scrChannelAccounts.id),
			provider: text("provider").notNull(),
			environment: scrReleaseEnvironmentEnum("environment").notNull(),
			active: boolean("active").notNull().default(false),
			createdBy: text("created_by").notNull(),
			createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
			updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
		},
		(table) => ({
			activeUnique: uniqueIndex("scr_channel_provider_bindings_active_unique")
				.on(table.channelAccountId, table.environment)
				.where(sql`active`),
			providerUnique: uniqueIndex("scr_channel_provider_bindings_provider_unique").on(
				table.channelAccountId,
				table.environment,
				table.provider,
			),
			brandIdx: index("scr_channel_provider_bindings_brand_idx").on(table.brandId, table.environment),
			orgIdx: index("scr_channel_provider_bindings_org_idx").on(table.organizationId),
		}),
	)
	.enableRLS();

export const scrContentItems = selenaRegistrySchema
	.table(
		"content_items",
		{
			id: uuid("id").defaultRandom().primaryKey().notNull(),
			organizationId: text("organization_id")
				.notNull()
				.references(() => organization.id),
			brandId: text("brand_id")
				.notNull()
				.references(() => brands.id),
			title: text("title").notNull(),
			status: scrContentStatusEnum().notNull().default("DRAFT"),
			kind: text("kind"),
			externalSource: text("external_source"),
			externalRef: uuid("external_ref"),
			briefRef: uuid("brief_ref"),
			createdBy: text("created_by").notNull(),
			createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
			updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
		},
		(table) => ({
			brandIdx: index("scr_content_items_brand_idx").on(table.brandId),
			orgIdx: index("scr_content_items_org_idx").on(table.organizationId),
		}),
	)
	.enableRLS();

export const scrContentVersions = selenaRegistrySchema
	.table(
		"content_versions",
		{
			id: uuid("id").defaultRandom().primaryKey().notNull(),
			organizationId: text("organization_id")
				.notNull()
				.references(() => organization.id),
			brandId: text("brand_id")
				.notNull()
				.references(() => brands.id),
			contentId: uuid("content_id")
				.notNull()
				.references(() => scrContentItems.id),
			version: integer("version").notNull(),
			body: text("body").notNull(),
			ctaUrl: text("cta_url").notNull(),
			claims: jsonb("claims").notNull().default([]),
			evidence: jsonb("evidence").notNull().default([]),
			disclosure: jsonb("disclosure").notNull().default({}),
			policyVersion: text("policy_version").notNull(),
			contentHash: text("content_hash").notNull(),
			evidenceExpiresAt: timestamp("evidence_expires_at", { withTimezone: true }),
			immutable: boolean("immutable").notNull().default(true),
			createdBy: text("created_by").notNull(),
			createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		},
		(table) => ({
			contentVersionUnique: uniqueIndex("scr_content_versions_content_version_unique").on(
				table.contentId,
				table.version,
			),
			contentIdx: index("scr_content_versions_content_idx").on(table.contentId, table.createdAt),
			brandIdx: index("scr_content_versions_brand_idx").on(table.brandId),
			orgIdx: index("scr_content_versions_org_idx").on(table.organizationId),
		}),
	)
	.enableRLS();

export const scrContentAssets = selenaRegistrySchema
	.table(
		"content_assets",
		{
			id: uuid("id").defaultRandom().primaryKey().notNull(),
			organizationId: text("organization_id")
				.notNull()
				.references(() => organization.id),
			brandId: text("brand_id")
				.notNull()
				.references(() => brands.id),
			contentVersionId: uuid("content_version_id")
				.notNull()
				.references(() => scrContentVersions.id),
			storageBucket: text("storage_bucket").notNull().default("selena-quarantine"),
			storageKey: text("storage_key").notNull(),
			objectVersionId: text("object_version_id"),
			originalFilename: text("original_filename").notNull(),
			sha256: text("sha256").notNull(),
			mimeType: text("mime_type").notNull(),
			detectedMimeType: text("detected_mime_type"),
			sizeBytes: integer("size_bytes").notNull(),
			scanStatus: scrAssetScanStatusEnum("scan_status").notNull().default("QUARANTINED"),
			scanProviderEventRef: text("scan_provider_event_ref"),
			scanStartedAt: timestamp("scan_started_at", { withTimezone: true }),
			scanCompletedAt: timestamp("scan_completed_at", { withTimezone: true }),
			scanAttempts: integer("scan_attempts").notNull().default(0),
			scanAvailableAt: timestamp("scan_available_at", { withTimezone: true }).notNull().defaultNow(),
			scanLeaseExpiresAt: timestamp("scan_lease_expires_at", { withTimezone: true }),
			scanLeaseToken: uuid("scan_lease_token"),
			scanError: text("scan_error"),
			scannerVersion: text("scanner_version"),
			rejectionReason: text("rejection_reason"),
			rightsExpiresAt: timestamp("rights_expires_at", { withTimezone: true }),
			consentExpiresAt: timestamp("consent_expires_at", { withTimezone: true }),
			verifiedAt: timestamp("verified_at", { withTimezone: true }),
			immutable: boolean("immutable").notNull().default(true),
			createdBy: text("created_by").notNull(),
			createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		},
		(table) => ({
			versionHashUnique: uniqueIndex("scr_content_assets_version_hash_unique").on(table.contentVersionId, table.sha256),
			versionIdx: index("scr_content_assets_version_idx").on(table.contentVersionId),
			orgIdx: index("scr_content_assets_org_idx").on(table.organizationId),
		}),
	)
	.enableRLS();

export const scrApprovals = selenaRegistrySchema
	.table(
		"approvals",
		{
			id: uuid("id").defaultRandom().primaryKey().notNull(),
			organizationId: text("organization_id")
				.notNull()
				.references(() => organization.id),
			brandId: text("brand_id")
				.notNull()
				.references(() => brands.id),
			contentVersionId: uuid("content_version_id")
				.notNull()
				.references(() => scrContentVersions.id),
			channelAccountId: uuid("channel_account_id")
				.notNull()
				.references(() => scrChannelAccounts.id),
			decision: scrApprovalDecisionEnum().notNull(),
			bindingHash: text("binding_hash").notNull(),
			contentHash: text("content_hash").notNull(),
			assetBundleHash: text("asset_bundle_hash").notNull(),
			policyVersion: text("policy_version").notNull(),
			disclosureHash: text("disclosure_hash").notNull(),
			approverId: text("approver_id").notNull(),
			reason: text("reason"),
			expiresAt: timestamp("expires_at", { withTimezone: true }),
			createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		},
		(table) => ({
			versionAccountIdx: index("scr_approvals_version_account_idx").on(
				table.contentVersionId,
				table.channelAccountId,
				table.createdAt,
			),
			brandIdx: index("scr_approvals_brand_idx").on(table.brandId),
			orgIdx: index("scr_approvals_org_idx").on(table.organizationId),
		}),
	)
	.enableRLS();

export const scrReleaseManifests = selenaReleaseSchema
	.table(
		"release_manifests",
		{
			id: uuid("id").defaultRandom().primaryKey().notNull(),
			organizationId: text("organization_id")
				.notNull()
				.references(() => organization.id),
			brandId: text("brand_id")
				.notNull()
				.references(() => brands.id),
			contentVersionId: uuid("content_version_id")
				.notNull()
				.references(() => scrContentVersions.id),
			approvalId: uuid("approval_id")
				.notNull()
				.references(() => scrApprovals.id),
			channelAccountId: uuid("channel_account_id")
				.notNull()
				.references(() => scrChannelAccounts.id),
			platform: text("platform").notNull(),
			manifest: jsonb("manifest").notNull(),
			manifestHash: text("manifest_hash").notNull(),
			signatureAlgorithm: text("signature_algorithm").notNull(),
			signingKeyVersion: text("signing_key_version").notNull(),
			signature: text("signature").notNull(),
			status: scrReleaseManifestStatusEnum().notNull().default("READY"),
			expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
			createdBy: text("created_by").notNull(),
			createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		},
		(table) => ({
			approvalAccountUnique: uniqueIndex("scr_release_manifests_approval_account_unique").on(
				table.approvalId,
				table.channelAccountId,
			),
			brandIdx: index("scr_release_manifests_brand_idx").on(table.brandId, table.createdAt),
			orgIdx: index("scr_release_manifests_org_idx").on(table.organizationId),
		}),
	)
	.enableRLS();

export const scrReleaseIntents = selenaReleaseSchema
	.table(
		"release_intents",
		{
			id: uuid("id").defaultRandom().primaryKey().notNull(),
			organizationId: text("organization_id")
				.notNull()
				.references(() => organization.id),
			brandId: text("brand_id")
				.notNull()
				.references(() => brands.id),
			contentVersionId: uuid("content_version_id")
				.notNull()
				.references(() => scrContentVersions.id),
			approvalId: uuid("approval_id")
				.notNull()
				.references(() => scrApprovals.id),
			channelAccountId: uuid("channel_account_id")
				.notNull()
				.references(() => scrChannelAccounts.id),
			platform: text("platform").notNull(),
			idempotencyKey: text("idempotency_key").notNull(),
			correlationId: uuid("correlation_id").notNull(),
			status: scrReleaseIntentStatusEnum().notNull().default("QUEUED"),
			notBefore: timestamp("not_before", { withTimezone: true }).defaultNow().notNull(),
			scheduleTimezone: text("schedule_timezone").notNull().default("UTC"),
			cancellationReason: text("cancellation_reason"),
			createdBy: text("created_by").notNull(),
			createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		},
		(table) => ({
			idempotencyScopeUnique: uniqueIndex("release_intents_scope_idempotency_unique").on(
				table.organizationId,
				table.brandId,
				table.channelAccountId,
				table.idempotencyKey,
			),
			approvalAccountUnique: uniqueIndex("release_intents_approval_account_unique").on(
				table.approvalId,
				table.channelAccountId,
			),
			brandStatusIdx: index("release_intents_brand_status_idx").on(table.brandId, table.status, table.createdAt),
		}),
	)
	.enableRLS();

export const scrReleaseOutboxEvents = selenaReleaseSchema
	.table(
		"outbox_events",
		{
			id: uuid("id").defaultRandom().primaryKey().notNull(),
			organizationId: text("organization_id")
				.notNull()
				.references(() => organization.id),
			brandId: text("brand_id")
				.notNull()
				.references(() => brands.id),
			releaseIntentId: uuid("release_intent_id")
				.notNull()
				.references(() => scrReleaseIntents.id),
			eventType: text("event_type").notNull(),
			eventVersion: integer("event_version").notNull().default(1),
			idempotencyKey: text("idempotency_key").notNull(),
			status: scrOutboxEventStatusEnum().notNull().default("PENDING"),
			availableAt: timestamp("available_at", { withTimezone: true }).defaultNow().notNull(),
			leaseOwner: text("lease_owner"),
			leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
			attemptCount: integer("attempt_count").notNull().default(0),
			maxAttempts: integer("max_attempts").notNull().default(5),
			lastError: text("last_error"),
			deliveredAt: timestamp("delivered_at", { withTimezone: true }),
			createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		},
		(table) => ({
			intentEventUnique: uniqueIndex("release_outbox_events_intent_event_unique").on(
				table.releaseIntentId,
				table.eventType,
				table.eventVersion,
			),
			idempotencyUnique: uniqueIndex("release_outbox_events_idempotency_unique").on(table.idempotencyKey),
			claimIdx: index("release_outbox_events_claim_idx").on(table.status, table.availableAt, table.leaseExpiresAt),
		}),
	)
	.enableRLS();

export const scrWorkflowDispatches = selenaReleaseSchema
	.table(
		"workflow_dispatches",
		{
			id: uuid("id").defaultRandom().primaryKey().notNull(),
			organizationId: text("organization_id")
				.notNull()
				.references(() => organization.id),
			brandId: text("brand_id")
				.notNull()
				.references(() => brands.id),
			outboxEventId: uuid("outbox_event_id")
				.notNull()
				.references(() => scrReleaseOutboxEvents.id),
			releaseIntentId: uuid("release_intent_id")
				.notNull()
				.references(() => scrReleaseIntents.id),
			correlationId: uuid("correlation_id").notNull(),
			triggerRunId: text("trigger_run_id"),
			idempotencyKey: text("idempotency_key").notNull(),
			status: text("status").notNull().default("QUEUED"),
			attemptCount: integer("attempt_count").notNull().default(0),
			lastError: text("last_error"),
			cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
			createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
			updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
		},
		(table) => ({
			outboxUnique: uniqueIndex("workflow_dispatches_outbox_event_unique").on(table.outboxEventId),
			idempotencyUnique: uniqueIndex("workflow_dispatches_idempotency_unique").on(table.idempotencyKey),
			brandStatusIdx: index("workflow_dispatches_brand_status_idx").on(table.brandId, table.status, table.createdAt),
		}),
	)
	.enableRLS();

export const scrReleaseDispatchReservations = selenaReleaseSchema
	.table(
		"dispatch_reservations",
		{
			id: uuid("id").defaultRandom().primaryKey().notNull(),
			organizationId: text("organization_id")
				.notNull()
				.references(() => organization.id),
			brandId: text("brand_id")
				.notNull()
				.references(() => brands.id),
			releaseManifestId: uuid("release_manifest_id")
				.notNull()
				.references(() => scrReleaseManifests.id),
			channelAccountId: uuid("channel_account_id")
				.notNull()
				.references(() => scrChannelAccounts.id),
			platform: text("platform").notNull(),
			integrationId: text("integration_id").notNull(),
			allowlistReference: text("allowlist_reference").notNull(),
			idempotencyKey: text("idempotency_key").notNull(),
			nonce: text("nonce").notNull(),
			reservedAt: timestamp("reserved_at", { withTimezone: true }).defaultNow().notNull(),
			createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		},
		(table) => ({
			idempotencyScopeUnique: uniqueIndex("release_dispatch_reservations_scope_idempotency_unique").on(
				table.organizationId,
				table.brandId,
				table.channelAccountId,
				table.idempotencyKey,
			),
			nonceUnique: uniqueIndex("release_dispatch_reservations_nonce_unique").on(table.nonce),
			manifestIdx: index("release_dispatch_reservations_manifest_idx").on(table.releaseManifestId, table.reservedAt),
		}),
	)
	.enableRLS();

export const scrPublicationAttempts = selenaReleaseSchema
	.table(
		"publication_attempts",
		{
			id: uuid("id").defaultRandom().primaryKey().notNull(),
			organizationId: text("organization_id")
				.notNull()
				.references(() => organization.id),
			brandId: text("brand_id")
				.notNull()
				.references(() => brands.id),
			reservationId: uuid("reservation_id")
				.notNull()
				.references(() => scrReleaseDispatchReservations.id),
			releaseManifestId: uuid("release_manifest_id")
				.notNull()
				.references(() => scrReleaseManifests.id),
			channelAccountId: uuid("channel_account_id")
				.notNull()
				.references(() => scrChannelAccounts.id),
			platform: text("platform").notNull(),
			integrationId: text("integration_id").notNull(),
			allowlistReference: text("allowlist_reference").notNull(),
			manifestHash: text("manifest_hash").notNull(),
			attemptNumber: integer("attempt_number").notNull(),
			transitionNumber: integer("transition_number").notNull(),
			status: scrPublicationAttemptStatusEnum().notNull(),
			providerRequestId: text("provider_request_id"),
			providerReferenceId: text("provider_reference_id"),
			errorClassification: text("error_classification"),
			errorDetail: text("error_detail"),
			occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
			createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		},
		(table) => ({
			reservationAttemptTransitionUnique: uniqueIndex("publication_attempts_transition_unique").on(
				table.reservationId,
				table.attemptNumber,
				table.transitionNumber,
			),
			providerRequestUnique: uniqueIndex("publication_attempts_provider_request_unique").on(table.providerRequestId),
			reservationIdx: index("publication_attempts_reservation_idx").on(table.reservationId, table.occurredAt),
			brandIdx: index("publication_attempts_brand_idx").on(table.brandId, table.occurredAt),
		}),
	)
	.enableRLS();

export const scrKillSwitches = selenaRegistrySchema
	.table(
		"kill_switches",
		{
			id: uuid("id").defaultRandom().primaryKey().notNull(),
			organizationId: text("organization_id")
				.notNull()
				.references(() => organization.id),
			scope: scrKillSwitchScopeEnum().notNull(),
			brandId: text("brand_id").references(() => brands.id),
			channelAccountId: uuid("channel_account_id").references(() => scrChannelAccounts.id),
			active: boolean("active").notNull().default(false),
			reason: text("reason").notNull(),
			changedBy: text("changed_by").notNull(),
			createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
			updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
		},
		(table) => ({
			scopeIdx: index("scr_kill_switches_scope_idx").on(table.organizationId, table.scope, table.active),
			orgIdx: index("scr_kill_switches_org_idx").on(table.organizationId),
		}),
	)
	.enableRLS();

export const scrIncidents = selenaAuditSchema
	.table(
		"incidents",
		{
			id: uuid("id").defaultRandom().primaryKey().notNull(),
			organizationId: text("organization_id")
				.notNull()
				.references(() => organization.id),
			brandId: text("brand_id")
				.notNull()
				.references(() => brands.id),
			publicationAttemptId: uuid("publication_attempt_id").references(() => scrPublicationAttempts.id),
			severity: text("severity").notNull(),
			code: text("code").notNull(),
			summary: text("summary").notNull(),
			status: scrIncidentStatusEnum().notNull().default("OPEN"),
			detectedBy: text("detected_by").notNull(),
			createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
			resolvedAt: timestamp("resolved_at", { withTimezone: true }),
		},
		(table) => ({
			brandIdx: index("scr_incidents_brand_idx").on(table.brandId, table.status),
			orgIdx: index("scr_incidents_org_idx").on(table.organizationId),
		}),
	)
	.enableRLS();

export const scrAuditEvents = selenaAuditSchema
	.table(
		"audit_events",
		{
			id: uuid("id").defaultRandom().primaryKey().notNull(),
			organizationId: text("organization_id")
				.notNull()
				.references(() => organization.id),
			brandId: text("brand_id").references(() => brands.id),
			actorId: text("actor_id").notNull(),
			action: text("action").notNull(),
			aggregateType: text("aggregate_type").notNull(),
			aggregateId: text("aggregate_id").notNull(),
			previousHash: text("previous_hash"),
			eventHash: text("event_hash").notNull(),
			metadata: jsonb("metadata").notNull().default({}),
			createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		},
		(table) => ({
			brandIdx: index("scr_audit_events_brand_idx").on(table.brandId, table.createdAt),
			orgIdx: index("scr_audit_events_org_idx").on(table.organizationId, table.createdAt),
		}),
	)
	.enableRLS();

export const scrRawPlatformSnapshots = selenaIngestRawSchema
	.table(
		"raw_platform_snapshots",
		{
			id: uuid("id").defaultRandom().primaryKey().notNull(),
			organizationId: text("organization_id")
				.notNull()
				.references(() => organization.id),
			brandId: text("brand_id")
				.notNull()
				.references(() => brands.id),
			channelAccountId: uuid("channel_account_id")
				.notNull()
				.references(() => scrChannelAccounts.id),
			provider: text("provider").notNull(),
			checkpoint: text("checkpoint").notNull(),
			requestKey: text("request_key").notNull(),
			windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
			windowEndedAt: timestamp("window_ended_at", { withTimezone: true }).notNull(),
			capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
			payload: jsonb("payload").notNull(),
			payloadSha256: text("payload_sha256").notNull(),
			createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		},
		(table) => ({
			requestUnique: uniqueIndex("raw_platform_snapshots_request_unique").on(table.channelAccountId, table.requestKey),
			accountCheckpointIdx: index("raw_platform_snapshots_account_checkpoint_idx").on(
				table.channelAccountId,
				table.checkpoint,
				table.capturedAt,
			),
		}),
	)
	.enableRLS();

export const scrMetricSnapshots = selenaPerformanceSchema
	.table(
		"metric_snapshots",
		{
			id: uuid("id").defaultRandom().primaryKey().notNull(),
			organizationId: text("organization_id")
				.notNull()
				.references(() => organization.id),
			brandId: text("brand_id")
				.notNull()
				.references(() => brands.id),
			publicationAttemptId: uuid("publication_attempt_id")
				.notNull()
				.references(() => scrPublicationAttempts.id),
			rawSnapshotId: uuid("raw_snapshot_id").references(() => scrRawPlatformSnapshots.id),
			platform: text("platform").notNull(),
			observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
			dataCutoffAt: timestamp("data_cutoff_at", { withTimezone: true }).notNull(),
			definitionVersion: text("definition_version").notNull(),
			quality: scrMetricQualityEnum().notNull(),
			values: jsonb("values").notNull(),
			revisionOfId: uuid("revision_of_id"),
			createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		},
		(table) => ({
			publicationAttemptIdx: index("metric_snapshots_publication_attempt_idx").on(
				table.publicationAttemptId,
				table.observedAt,
			),
			rawSnapshotIdx: index("metric_snapshots_raw_snapshot_idx").on(table.rawSnapshotId),
			orgIdx: index("scr_metric_snapshots_org_idx").on(table.organizationId),
		}),
	)
	.enableRLS();

export const scrTrackingEvents = selenaPerformanceSchema
	.table(
		"tracking_events",
		{
			id: uuid("id").defaultRandom().primaryKey().notNull(),
			organizationId: text("organization_id")
				.notNull()
				.references(() => organization.id),
			brandId: text("brand_id")
				.notNull()
				.references(() => brands.id),
			publicationAttemptId: uuid("publication_attempt_id").references(() => scrPublicationAttempts.id),
			correlationId: uuid("correlation_id"),
			eventType: text("event_type").notNull(),
			visitorHash: text("visitor_hash"),
			attributionClass: text("attribution_class").notNull(),
			occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
			metadata: jsonb("metadata").notNull().default({}),
			createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		},
		(table) => ({
			publicationAttemptIdx: index("tracking_events_publication_attempt_idx").on(
				table.publicationAttemptId,
				table.occurredAt,
			),
			orgIdx: index("scr_tracking_events_org_idx").on(table.organizationId),
		}),
	)
	.enableRLS();

export type SvProject = typeof svProjects.$inferSelect;
export type NewSvProject = typeof svProjects.$inferInsert;
export type SvScenario = typeof svScenarios.$inferSelect;
export type SvQuote = typeof svQuotes.$inferSelect;
export type SvOrder = typeof svOrders.$inferSelect;
export type SvCycle = typeof svCycles.$inferSelect;
export type SvApiKey = typeof svApiKeys.$inferSelect;

// Encrypted overrides for credential environment variables, keyed by the env-var
// name they stand in for. Separate table, strictest access.
export const secrets = pgTable("secrets", {
	name: text("name").primaryKey().notNull(),
	encryptedValue: text("encrypted_value").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.defaultNow()
		.$onUpdate(() => new Date())
		.notNull(),
}).enableRLS();

import {
	type AnyPgColumn,
	boolean,
	index,
	integer,
	json,
	jsonb,
	numeric,
	pgEnum,
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
		systemId: text("system_id"),
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
		systemId: text("system_id"),
		status: text("status").notNull().default("queued"),
		validity: text("validity"),
		invalidReason: text("invalid_reason"),
		costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
		costBasis: text("cost_basis"),
		tokenInput: integer("token_input"),
		tokenOutput: integer("token_output"),
		system: text("system"),
		model: text("model"),
		language: text("language"),
		region: text("region"),
		mention: boolean("mention"),
		position: smallint("position"),
		ownedCitation: boolean("owned_citation"),
		citations: jsonb("citations"),
		competitors: jsonb("competitors"),
		factualErrors: jsonb("factual_errors"),
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

// §9.2: an overflow or stop is isolated and recorded, never silently absorbed
// — a safeguard whose firing leaves no trace is indistinguishable from one
// that never fired.
export const svIncidents = pgTable(
	"sv_incidents",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		orderId: uuid("order_id").references(() => svOrders.id),
		cycleId: uuid("cycle_id").references(() => svCycles.id),
		kind: text("kind").notNull(),
		severity: text("severity").notNull().default("high"),
		detail: text("detail").notNull(),
		dispatchKey: text("dispatch_key"),
		status: text("status").notNull().default("OPEN"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		resolvedAt: timestamp("resolved_at", { withTimezone: true }),
	},
	(table) => ({
		orgCreatedIdx: index("sv_incidents_org_created_idx").on(table.organizationId, table.createdAt),
		orderIdx: index("sv_incidents_order_idx").on(table.orderId),
	}),
).enableRLS();

// §10.2: the append-only spend ledger. One row per charge, each declaring
// whether the amount is the provider's actual figure or our estimate; cap
// alerts read sums from here rather than trusting run rows to be complete.
export const svCostEvents = pgTable(
	"sv_cost_events",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		cycleId: uuid("cycle_id")
			.notNull()
			.references(() => svCycles.id),
		runId: uuid("run_id").references(() => svRuns.id),
		provider: text("provider").notNull(),
		amountUsd: numeric("amount_usd", { precision: 12, scale: 6 }).notNull(),
		basis: text("basis").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({
		orgCycleIdx: index("sv_cost_events_org_cycle_idx").on(table.organizationId, table.cycleId),
		runIdx: index("sv_cost_events_run_idx").on(table.runId),
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

// Local AI discovery (RC7): entity hierarchies and business locations are
// client-confirmed configuration only — the backend never resolves them
// against Google surfaces.
export const svEntityKindEnum = pgEnum("sv_entity_kind", ["MASTER_BRAND", "SUBBRAND", "CONCEPT", "LOCATION_BRAND"]);
export const svParentRelationEnum = pgEnum("sv_parent_relation", [
	"SUBBRAND_OF",
	"CONCEPT_WITHIN",
	"LOCATION_OF",
	"UNSPECIFIED",
]);
export const svEntityConfirmationEnum = pgEnum("sv_entity_confirmation", [
	"PROPOSED",
	"CLIENT_CONFIRMED",
	"ANALYST_CONFIRMED",
	"REJECTED",
]);
export const svGeoPrecisionEnum = pgEnum("sv_geo_precision", ["CITY", "ADDRESS", "COORDINATE", "UNKNOWN"]);
export const svReferenceOriginEnum = pgEnum("sv_reference_origin", ["USER_PROVIDED", "PUBLIC_SITE", "ANALYST_ENTERED"]);
export const svLocationRoleEnum = pgEnum("sv_location_role", ["PRIMARY", "SECONDARY", "WITHIN"]);
export const svLocationConfirmationEnum = pgEnum("sv_location_confirmation", ["PROPOSED", "CONFIRMED", "REJECTED"]);
export const svEntities = pgTable(
	"sv_entities",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		projectId: uuid("project_id")
			.notNull()
			.references(() => svProjects.id),
		parentEntityId: uuid("parent_entity_id").references((): AnyPgColumn => svEntities.id),
		entityKind: svEntityKindEnum("entity_kind").notNull(),
		parentRelation: svParentRelationEnum("parent_relation"),
		confirmationStatus: svEntityConfirmationEnum("confirmation_status").notNull().default("PROPOSED"),
		name: text("name").notNull(),
		aliases: text("aliases").array().notNull().default([]),
		prelaunch: boolean("prelaunch").notNull().default(false),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({ orgProjectIdx: index("sv_entities_org_project_idx").on(table.organizationId, table.projectId) }),
).enableRLS();
export const svBusinessLocations = pgTable(
	"sv_business_locations",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		entityId: uuid("entity_id")
			.notNull()
			.references(() => svEntities.id),
		displayName: text("display_name").notNull(),
		countryCode: text("country_code").notNull(),
		adminArea: text("admin_area"),
		locality: text("locality"),
		addressText: text("address_text"),
		timezone: text("timezone"),
		latitude: numeric("latitude", { precision: 9, scale: 6 }),
		longitude: numeric("longitude", { precision: 9, scale: 6 }),
		geoPrecision: svGeoPrecisionEnum("geo_precision").notNull().default("UNKNOWN"),
		// Opaque user-supplied strings kept for human cross-checking only: the RC7
		// MANUAL_ONLY policy forbids the backend from ever resolving them through
		// Google Maps / Places, so they must never feed an external lookup.
		googleMapsUrlReference: text("google_maps_url_reference"),
		googlePlaceIdReference: text("google_place_id_reference"),
		referenceOrigin: svReferenceOriginEnum("reference_origin").notNull().default("USER_PROVIDED"),
		locationRole: svLocationRoleEnum("location_role").notNull().default("PRIMARY"),
		confirmationStatus: svLocationConfirmationEnum("confirmation_status").notNull().default("PROPOSED"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({
		entityIdx: index("sv_business_locations_entity_idx").on(table.entityId),
		orgIdx: index("sv_business_locations_org_idx").on(table.organizationId),
	}),
).enableRLS();

// RC7 manual pilot (Phase E): every record below is produced by a human
// observer and reviewed by a human — nothing here is reachable from pg-boss
// queues, run permits, or provider execution paths.
export const svCaptureTaskStatusEnum = pgEnum("sv_capture_task_status", [
	"PENDING_CAPTURE",
	"AWAITING_MANUAL_CAPTURE",
	"SUBMITTED_FOR_REVIEW",
	"ACCEPTED",
	"REJECTED",
	"NEEDS_CORRECTION",
	"INSUFFICIENT_EVIDENCE",
	"SURFACE_UNAVAILABLE",
]);
export const svOrderingStateEnum = pgEnum("sv_ordering_state", ["EXPLICIT_ORDER", "UNORDERED", "UNKNOWN"]);
export const svMentionRoleEnum = pgEnum("sv_mention_role", ["TARGET", "PARENT", "CHILD", "COMPETITOR", "OTHER"]);
export const svMatchStatusEnum = pgEnum("sv_match_status", ["EXACT_ALIAS", "REVIEWED_MATCH", "UNRESOLVED"]);
export const svPilotCycles = pgTable(
	"sv_pilot_cycles",
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
		status: text("status").notNull().default("CREATED"),
		expectedObservations: integer("expected_observations").notNull(),
		createdObservations: integer("created_observations").notNull().default(0),
		captureProtocolVersion: text("capture_protocol_version").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({
		orgIdx: index("sv_pilot_cycles_org_idx").on(table.organizationId),
		projectIdx: index("sv_pilot_cycles_project_idx").on(table.projectId),
	}),
).enableRLS();
export const svCaptureTasks = pgTable(
	"sv_capture_tasks",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		pilotCycleId: uuid("pilot_cycle_id")
			.notNull()
			.references(() => svPilotCycles.id),
		scenarioId: uuid("scenario_id")
			.notNull()
			.references(() => svScenarios.id),
		contextHash: text("context_hash").notNull(),
		contextSnapshot: jsonb("context_snapshot").notNull(),
		repeatIndex: integer("repeat_index").notNull(),
		queryTextSnapshot: text("query_text_snapshot").notNull(),
		targetEntityIdsSnapshot: jsonb("target_entity_ids_snapshot").notNull().default([]),
		status: svCaptureTaskStatusEnum().notNull().default("PENDING_CAPTURE"),
		idempotencyKey: text("idempotency_key"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({
		matrixUnique: uniqueIndex("sv_capture_tasks_matrix_unique").on(
			table.pilotCycleId,
			table.scenarioId,
			table.contextHash,
			table.repeatIndex,
		),
		idempotencyUnique: uniqueIndex("sv_capture_tasks_org_idempotency_unique").on(
			table.organizationId,
			table.idempotencyKey,
		),
		orgIdx: index("sv_capture_tasks_org_idx").on(table.organizationId),
	}),
).enableRLS();
export const svLocalObservations = pgTable(
	"sv_local_observations",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		captureTaskId: uuid("capture_task_id")
			.notNull()
			.references(() => svCaptureTasks.id),
		capturedBy: text("captured_by").notNull(),
		capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
		submittedAt: timestamp("submitted_at", { withTimezone: true }).defaultNow().notNull(),
		reviewedBy: text("reviewed_by"),
		reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
		reviewStatus: text("review_status").notNull().default("SUBMITTED_FOR_REVIEW"),
		validity: text("validity"),
		invalidReason: text("invalid_reason"),
		orderingState: svOrderingStateEnum().notNull().default("UNKNOWN"),
		transcript: text("transcript").notNull(),
		queryText: text("query_text").notNull(),
		contentSha256: text("content_sha256").notNull(),
		// Corrections are versioned records superseding the original, never
		// in-place overwrites — the superseded observation stays auditable.
		version: integer("version").notNull().default(1),
		supersedesObservationId: uuid("supersedes_observation_id").references((): AnyPgColumn => svLocalObservations.id),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({
		taskUnique: uniqueIndex("sv_local_observations_task_unique").on(table.captureTaskId),
		orgIdx: index("sv_local_observations_org_idx").on(table.organizationId),
	}),
).enableRLS();
export const svObservationMentions = pgTable(
	"sv_observation_mentions",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		observationId: uuid("observation_id")
			.notNull()
			.references(() => svLocalObservations.id),
		rawMentionText: text("raw_mention_text").notNull(),
		matchedEntityId: uuid("matched_entity_id").references(() => svEntities.id),
		mentionRole: svMentionRoleEnum().notNull(),
		matchStatus: svMatchStatusEnum().notNull(),
		matchConfidence: numeric("match_confidence", { precision: 5, scale: 4 }),
		explicitPosition: integer("explicit_position"),
		orderingBasis: text("ordering_basis"),
		factualError: boolean("factual_error").notNull().default(false),
		evidenceLocator: text("evidence_locator"),
	},
	(table) => ({
		observationIdx: index("sv_observation_mentions_observation_idx").on(table.observationId),
		orgIdx: index("sv_observation_mentions_org_idx").on(table.organizationId),
	}),
).enableRLS();
export const svObservationEvidenceAssets = pgTable(
	"sv_observation_evidence_assets",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		observationId: uuid("observation_id")
			.notNull()
			.references(() => svLocalObservations.id),
		assetType: text("asset_type").notNull(),
		mimeType: text("mime_type").notNull(),
		sizeBytes: integer("size_bytes").notNull(),
		sha256: text("sha256").notNull(),
		sequenceIndex: integer("sequence_index").notNull(),
		// Opaque locator supplied by the human uploader. The server never fetches
		// it: dereferencing would be an external call, which the RC7 MANUAL_ONLY
		// policy forbids for this surface.
		privateObjectReference: text("private_object_reference").notNull(),
		uploadedBy: text("uploaded_by").notNull(),
		capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({
		observationIdx: index("sv_observation_evidence_assets_observation_idx").on(table.observationId),
		orgIdx: index("sv_observation_evidence_assets_org_idx").on(table.organizationId),
	}),
).enableRLS();
export const svAuditEvents = pgTable(
	"sv_audit_events",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		actorId: text("actor_id").notNull(),
		event: text("event").notNull(),
		subjectKind: text("subject_kind").notNull(),
		subjectId: text("subject_id").notNull(),
		details: jsonb("details").notNull().default({}),
		at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({ orgAtIdx: index("sv_audit_events_org_at_idx").on(table.organizationId, table.at) }),
).enableRLS();

// Human expert sign-off per order (assertExpertVerified's storage): decision
// is free text validated in code ("approved" | "rejected") so new review
// outcomes never need a migration.
export const svQcRecords = pgTable(
	"sv_qc_records",
	{
		id: uuid("id").defaultRandom().primaryKey().notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id),
		orderId: uuid("order_id")
			.notNull()
			.references(() => svOrders.id),
		cycleId: uuid("cycle_id").references(() => svCycles.id),
		reviewer: text("reviewer").notNull(),
		reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull(),
		scope: text("scope").notNull(),
		decision: text("decision").notNull(),
		notes: text("notes"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => ({ orgOrderIdx: index("sv_qc_records_org_order_idx").on(table.organizationId, table.orderId) }),
).enableRLS();

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

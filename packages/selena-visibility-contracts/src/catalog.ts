import { z } from "zod";

export const SELENA_CATALOG_VERSION = "selena-catalog-rc6-v1" as const;
export const SELENA_SELLER_LEGAL_ENTITY = "Selena Systems LLC" as const;
export const SELENA_CHECKOUT_METADATA = {
	sellerLegalEntity: SELENA_SELLER_LEGAL_ENTITY,
	sellerStatus: "temporary_owner_approved_pending_kyc",
	currency: "USD",
	livePayments: "off",
} as const;

export const visitorSurfaces = ["ChatGPT", "Gemini", "Perplexity"] as const;
export const apiModelIds = [
	"anthropic/claude-haiku-4.5",
	"deepseek/deepseek-v3.2",
	"qwen/qwen3.5-9b",
	"mistralai/mistral-small-2603",
	"x-ai/grok-4.5",
] as const;
export type ApiModelId = (typeof apiModelIds)[number];
export const channels = ["VISITOR_VIEW", "API_VIEW"] as const;
export type SelenaChannel = (typeof channels)[number];

export const planIds = ["visitor-local", "full-ai-landscape", "expert-verified", "growth-90-days"] as const;
export type SelenaPlanId = (typeof planIds)[number];
export type BillingInterval = "month" | "one_time" | "ninety_days";

export type SelenaPlan = {
	planId: SelenaPlanId;
	name: string;
	billingInterval: BillingInterval;
	price: number;
	currency: "USD";
	channelScope: readonly SelenaChannel[];
	systems: readonly string[];
	languageLimit: number;
	scenarioLimit: number | null;
	/** Questions accepted in a single measurement; null = negotiated scope. */
	questionLimitPerMeasurement: number | null;
	repeatCount: number | null;
	includedFeatures: readonly string[];
	excludedFeatures: readonly string[];
	verificationLevel: "automated" | "awaiting_expert_review" | "expert_verified";
	laborHours: number;
	providerBudgetCap: number;
	retryPolicy: "one_technical_invalid";
	purchaseMode: "self_service" | "manual_approval_contact_sales";
	activationGates: readonly string[];
};

const commonGates = ["admin_approval", "providers_off", "maintenance_off"] as const;

export const SELENA_CATALOG: Readonly<Record<SelenaPlanId, SelenaPlan>> = {
	"visitor-local": {
		planId: "visitor-local",
		name: "Visitor Local",
		billingInterval: "month",
		price: 49,
		currency: "USD",
		channelScope: ["VISITOR_VIEW"],
		systems: [...visitorSurfaces],
		languageLimit: 1,
		scenarioLimit: 100,
		questionLimitPerMeasurement: 25,
		repeatCount: 1,
		includedFeatures: [
			"1 organization",
			"1 site",
			"1 brand",
			"1 city or district",
			"300 planned answers",
			"competitors",
			"mentions",
			"positions",
			"citations",
			"public website scan",
			"approved public business/review signals",
			"dashboard",
			"CSV",
			"automatic recommendations",
		],
		excludedFeatures: [
			"five API View models",
			"manual analyst review",
			"Expert Verified",
			"Connected Analytics by default",
		],
		verificationLevel: "automated",
		laborHours: 0,
		providerBudgetCap: 12,
		retryPolicy: "one_technical_invalid",
		purchaseMode: "self_service",
		activationGates: [...commonGates],
	},
	"full-ai-landscape": {
		planId: "full-ai-landscape",
		name: "Full AI Landscape",
		billingInterval: "month",
		price: 79,
		currency: "USD",
		channelScope: ["VISITOR_VIEW", "API_VIEW"],
		systems: [...visitorSurfaces, ...apiModelIds],
		languageLimit: 2,
		scenarioLimit: 100,
		questionLimitPerMeasurement: 25,
		repeatCount: 1,
		includedFeatures: [
			"all 8 systems",
			"separate Visitor/API views",
			"divergence",
			"800 planned answers",
			"expanded source map",
			"Evidence Ledger",
			"PDF/XLSX/CSV when available",
		],
		excludedFeatures: ["manual analyst review", "Expert Verified"],
		verificationLevel: "automated",
		laborHours: 0,
		providerBudgetCap: 28,
		retryPolicy: "one_technical_invalid",
		purchaseMode: "self_service",
		activationGates: [...commonGates],
	},
	"expert-verified": {
		planId: "expert-verified",
		name: "Expert Verified",
		billingInterval: "one_time",
		price: 399,
		currency: "USD",
		channelScope: ["VISITOR_VIEW", "API_VIEW"],
		systems: [...visitorSurfaces, ...apiModelIds],
		languageLimit: 2,
		scenarioLimit: 50,
		questionLimitPerMeasurement: 25,
		repeatCount: 5,
		includedFeatures: [
			"25 questions across up to 2 languages",
			"2000 planned answers",
			"deep review of the top 10 priorities",
			"Evidence Ledger",
			"PDF/XLSX/CSV",
			"Recommendation Engine",
			"manual semantic/citation/factual QC",
			"5–10 approved recommendations",
			"2–3 analyst hours",
		],
		excludedFeatures: ["Expert Verified label before QC record"],
		verificationLevel: "awaiting_expert_review",
		laborHours: 3,
		providerBudgetCap: 48,
		retryPolicy: "one_technical_invalid",
		purchaseMode: "self_service",
		activationGates: [...commonGates, "expert_qc_record"],
	},
	"growth-90-days": {
		planId: "growth-90-days",
		name: "Growth 90 Days",
		billingInterval: "ninety_days",
		price: 2490,
		currency: "USD",
		channelScope: ["VISITOR_VIEW", "API_VIEW"],
		systems: [...visitorSurfaces, ...apiModelIds],
		languageLimit: 0,
		scenarioLimit: null,
		questionLimitPerMeasurement: null,
		repeatCount: null,
		includedFeatures: [
			"Expert Verified baseline",
			"Visitor/API divergence",
			"Public Data",
			"Uploaded Evidence",
			"optional Connected Analytics",
			"GSC/GBP/Instagram Insights when connected",
			"personal Action Plan",
			"up to 10 implementation hours",
			"8–12 lead expert hours",
			"90-day monitoring",
			"same Configuration Lock remeasurement",
			"second recommendation iteration",
			"final presentation",
		],
		excludedFeatures: ["automatic self-service checkout", "unlocked scope assumptions"],
		verificationLevel: "awaiting_expert_review",
		laborHours: 22,
		providerBudgetCap: 0,
		retryPolicy: "one_technical_invalid",
		purchaseMode: "manual_approval_contact_sales",
		activationGates: [
			...commonGates,
			"locked_custom_scope",
			"cycle_count",
			"provider_cost_cap",
			"margin_floor",
			"admin_approval",
		],
	},
};

export const planCatalogSchema = z.object({
	planId: z.enum(planIds),
	languages: z.array(z.string().min(2)).min(1).max(2),
	languageScenarios: z.number().int().positive(),
	repeats: z.number().int().positive(),
	systems: z.array(z.string().min(1)).min(1),
	providerCostCap: z.number().nonnegative(),
	laborCapHours: z.number().nonnegative(),
	adminApproved: z.boolean().default(false),
	growthScopeLocked: z.boolean().default(false),
});
export type CatalogScope = z.infer<typeof planCatalogSchema>;

export function plannedAnswers(scope: Pick<CatalogScope, "languageScenarios" | "systems" | "repeats">): number {
	return scope.languageScenarios * scope.systems.length * scope.repeats;
}

/**
 * The plan's monthly answer allowance — the number the pricing page quotes
 * (100 scenarios × 3 systems = 300, and so on). Null when the plan sets no
 * scenario or repeat bound (Growth), meaning the allowance is negotiated,
 * not computed.
 */
export function monthlyAnswerAllowance(planId: SelenaPlanId): number | null {
	const plan = SELENA_CATALOG[planId];
	if (plan.scenarioLimit === null || plan.repeatCount === null) return null;
	return plan.scenarioLimit * plan.systems.length * plan.repeatCount;
}

export function getPlan(planId: SelenaPlanId): SelenaPlan {
	return SELENA_CATALOG[planId];
}

export function validateCatalogScope(input: CatalogScope): SelenaPlan {
	const plan = getPlan(input.planId);
	if (plan.planId !== "growth-90-days" && input.languages.length > plan.languageLimit)
		throw new Error("LANGUAGE_LIMIT_EXCEEDED");
	if (plan.scenarioLimit !== null && input.languageScenarios > plan.scenarioLimit)
		throw new Error("SCENARIO_LIMIT_EXCEEDED");
	if (plan.repeatCount !== null && input.repeats !== plan.repeatCount) throw new Error("REPEAT_COUNT_MISMATCH");
	if (input.planId === "growth-90-days" && !input.growthScopeLocked) throw new Error("GROWTH_SCOPE_REQUIRED");
	if (input.planId === "growth-90-days" && input.providerCostCap <= 0) throw new Error("GROWTH_PROVIDER_CAP_REQUIRED");
	if (!input.adminApproved && input.planId === "growth-90-days") throw new Error("GROWTH_ADMIN_APPROVAL_REQUIRED");
	if (input.systems.length !== plan.systems.length || input.systems.some((system) => !plan.systems.includes(system)))
		throw new Error("SYSTEM_SCOPE_MISMATCH");
	return plan;
}

export type OrderLockSnapshot = {
	catalogVersion: string;
	plan: SelenaPlan;
	scope: CatalogScope;
	plannedAnswers: number;
	modelIds: readonly string[];
	configurationLockHash: string;
	pricing: { amount: number; currency: "USD"; taxMode: string; refundPolicyVersion: string };
	retryReserve: number;
	checkoutMetadata: typeof SELENA_CHECKOUT_METADATA;
};

export function createOrderLock(
	scope: CatalogScope,
	pricing: OrderLockSnapshot["pricing"],
	configurationLockHash: string,
): OrderLockSnapshot {
	const plan = validateCatalogScope(scope);
	return {
		catalogVersion: SELENA_CATALOG_VERSION,
		plan,
		scope: structuredClone(scope),
		plannedAnswers: plannedAnswers(scope),
		modelIds: [...apiModelIds],
		configurationLockHash,
		pricing: structuredClone(pricing),
		retryReserve: 1,
		checkoutMetadata: { ...SELENA_CHECKOUT_METADATA },
	};
}

export function orderLockHash(lock: OrderLockSnapshot): string {
	const input = JSON.stringify(lock);
	let hash = 2166136261;
	for (let index = 0; index < input.length; index += 1) hash = Math.imul(hash ^ input.charCodeAt(index), 16777619);
	return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function assertHardCaps(input: {
	createdRuns: number;
	expectedRuns: number;
	estimatedCost: number;
	providerCostCap: number;
	orderCap: number;
	retryUsed: number;
	retryReserve: number;
}): void {
	if (input.createdRuns >= input.expectedRuns) throw new Error("CARDINALITY_BLOCKED");
	if (input.estimatedCost > input.providerCostCap) throw new Error("PROVIDER_CAP_BLOCKED");
	if (input.estimatedCost > input.orderCap) throw new Error("ORDER_CAP_BLOCKED");
	if (input.retryUsed > input.retryReserve) throw new Error("RETRY_RESERVE_EXCEEDED");
}

export function assertDispatchModes(maintenanceEnabled: boolean, directDispatchEnabled: boolean): void {
	if (maintenanceEnabled && directDispatchEnabled) throw new Error("DISPATCH_MODE_CONFLICT");
}

export function assertExpertVerified(hasQcRecord: boolean): void {
	if (!hasQcRecord) throw new Error("EXPERT_QC_REQUIRED");
}
export function isApiViewWebSearchEnabled(): false {
	return false;
}

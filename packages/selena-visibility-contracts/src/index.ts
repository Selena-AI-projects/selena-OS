import { z } from "zod";

export const orderStatuses = [
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
] as const;
export type OrderStatus = (typeof orderStatuses)[number];

export const systemChannels = ["VISITOR", "API"] as const;
export type SystemChannel = (typeof systemChannels)[number];

export const runStatuses = ["PENDING", "RUNNING", "SUCCEEDED", "INVALID", "FAILED", "OVERFLOW", "STOPPED"] as const;
export type RunStatus = (typeof runStatuses)[number];

export const runRequestSchema = z.object({
	orderId: z.string().uuid(),
	scenarioId: z.string().uuid(),
	systemId: z.string().min(1),
	channel: z.enum(systemChannels),
	repeatIndex: z.number().int().nonnegative(),
	configurationVersion: z.number().int().positive(),
});
export type RunRequest = z.infer<typeof runRequestSchema>;

export function dispatchKey(input: RunRequest): string {
	return [input.orderId, input.scenarioId, input.systemId, input.repeatIndex, input.configurationVersion].join(":");
}

export function assertCardinality(createdRuns: number, expectedRuns: number): void {
	if (!Number.isInteger(createdRuns) || !Number.isInteger(expectedRuns) || expectedRuns < 0 || createdRuns < 0) {
		throw new Error("CARDINALITY_INVALID");
	}
	if (createdRuns >= expectedRuns) throw new Error("CARDINALITY_BLOCKED");
}

export const preflightResultSchema = z.object({
	orderId: z.string().uuid(),
	ok: z.boolean(),
	checks: z.array(
		z.object({ code: z.string(), ok: z.boolean(), details: z.record(z.string(), z.unknown()).optional() }),
	),
	expectedRuns: z.number().int().nonnegative(),
	worstCaseCost: z.object({
		amount: z.number().nonnegative(),
		currency: z.string().length(3),
		basis: z.enum(["estimated", "actual"]),
	}),
});
export type PreflightResult = z.infer<typeof preflightResultSchema>;

export const projectCreateSchema = z.object({
	name: z.string().trim().min(1).max(160),
	category: z.string().trim().min(1).max(120),
	country: z.string().trim().min(2).max(2),
	region: z.string().trim().max(160).optional(),
	languages: z
		.array(z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/))
		.min(1)
		.max(10),
});
export type ProjectCreate = z.infer<typeof projectCreateSchema>;

export const scenarioDecisionSchema = z
	.object({
		approvedScenarioIds: z.array(z.string().uuid()).default([]),
		rejectedScenarioIds: z.array(z.string().uuid()).default([]),
	})
	.refine(
		(value) => !value.approvedScenarioIds.some((id) => value.rejectedScenarioIds.includes(id)),
		"Scenario cannot be approved and rejected",
	);
export type ScenarioDecision = z.infer<typeof scenarioDecisionSchema>;

export const quoteCreateSchema = z.object({
	scenarioIds: z.array(z.string().uuid()).min(1),
	systems: z.array(z.object({ id: z.string().min(1), channel: z.enum(systemChannels) })).min(1),
	repeats: z.number().int().min(1).max(100),
});
export type QuoteCreate = z.infer<typeof quoteCreateSchema>;

export function expectedRuns(input: QuoteCreate): number {
	return input.scenarioIds.length * input.systems.length * input.repeats;
}

export const quotePricingSchema = z.object({
	baseAmount: z.number().nonnegative(),
	perRunAmount: z.number().nonnegative(),
	qcAmount: z.number().nonnegative(),
	marginRate: z.number().min(0).max(10),
	currency: z.string().length(3),
});
export type QuotePricing = z.infer<typeof quotePricingSchema>;

export function calculateQuote(input: QuoteCreate, pricing: QuotePricing) {
	const runs = expectedRuns(input);
	const subtotal = pricing.baseAmount + runs * pricing.perRunAmount + pricing.qcAmount;
	return {
		expectedRuns: runs,
		amount: Number((subtotal * (1 + pricing.marginRate)).toFixed(2)),
		currency: pricing.currency,
	};
}
export * from "./recommendation";
export * from "./payment";
export * from "./catalog";
export * from "./local-discovery";

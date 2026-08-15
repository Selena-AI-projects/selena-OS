import { z } from "zod";

export const accessClasses = ["PUBLIC", "CONNECTED", "UPLOADED"] as const;
export const evidenceKinds = ["AI_RESPONSE", "WEBSITE", "SEARCH", "MAPS", "REVIEW", "SOCIAL", "UPLOADED"] as const;
export const priorityLevels = ["NOW", "NEXT", "LATER"] as const;
export const confidenceLevels = ["HIGH", "MEDIUM", "LOW", "UNKNOWN"] as const;

export const evidenceItemSchema = z.object({
	id: z.string().min(1),
	tenantId: z.string().min(1),
	snapshotId: z.string().min(1),
	kind: z.enum(evidenceKinds),
	accessClass: z.enum(accessClasses),
	sourceRef: z.string().min(1),
	capturedAt: z.string().min(1),
	subject: z.string().min(1),
	text: z.string(),
	metadata: z.record(z.string(), z.unknown()).default({}),
});
export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

export const sourceSnapshotSchema = z.object({
	id: z.string().min(1),
	tenantId: z.string().min(1),
	source: z.string().min(1),
	capturedAt: z.string().min(1),
	contentHash: z.string().min(1),
	metadata: z.record(z.string(), z.unknown()).default({}),
});
export type SourceSnapshot = z.infer<typeof sourceSnapshotSchema>;

export const inputManifestSchema = z.object({
	id: z.string().min(1),
	tenantId: z.string().min(1),
	datasetId: z.string().min(1),
	evidenceIds: z.array(z.string().min(1)).min(1),
	snapshotIds: z.array(z.string().min(1)),
	rulepackVersion: z.string().min(1),
	createdAt: z.string().min(1),
	immutable: z.literal(true),
});
export type InputManifest = z.infer<typeof inputManifestSchema>;

export const findingSchema = z.object({
	id: z.string().min(1),
	tenantId: z.string().min(1),
	manifestId: z.string().min(1),
	category: z.string().min(1),
	statement: z.string().min(1),
	evidenceIds: z.array(z.string().min(1)).min(1),
	confidence: z.enum(confidenceLevels),
	confidenceScore: z.number().min(0).max(1),
	severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]),
	unknown: z.boolean(),
	ruleId: z.string().min(1),
});
export type RecommendationFinding = z.infer<typeof findingSchema>;

export const recommendationSchema = z.object({
	id: z.string().min(1),
	tenantId: z.string().min(1),
	findingId: z.string().min(1),
	manifestId: z.string().min(1),
	title: z.string().min(1),
	action: z.string().min(1),
	rationale: z.string().min(1),
	evidenceIds: z.array(z.string().min(1)).min(1),
	priority: z.enum(priorityLevels),
	effort: z.enum(["S", "M", "L"]),
	confidence: z.enum(confidenceLevels),
	blocked: z.boolean(),
	blockReason: z.string().optional(),
});
export type Recommendation = z.infer<typeof recommendationSchema>;

export const actionPlanTaskSchema = z.object({
	id: z.string().min(1),
	recommendationId: z.string().min(1),
	title: z.string().min(1),
	horizon: z.enum(["0_30_DAYS", "31_90_DAYS", "90_PLUS_DAYS"]),
	owner: z.string().min(1),
	steps: z.array(z.string().min(1)).min(1),
	evidenceIds: z.array(z.string().min(1)).min(1),
	verificationPlan: z.array(z.string().min(1)).min(1),
});
export type ActionPlanTask = z.infer<typeof actionPlanTaskSchema>;

export const actionPlanSchema = z.object({
	tenantId: z.string().min(1),
	manifestId: z.string().min(1),
	findings: z.array(findingSchema),
	recommendations: z.array(recommendationSchema),
	tasks: z.array(actionPlanTaskSchema),
});
export type ActionPlan = z.infer<typeof actionPlanSchema>;

export const forbiddenClaimPatterns = [
	/guarantee/i,
	/will rank/i,
	/guaranteed visibility/i,
	/increase sales/i,
	/increase revenue/i,
	/ensure recommendation/i,
];
export function containsForbiddenClaim(text: string): boolean {
	return forbiddenClaimPatterns.some((pattern) => pattern.test(text));
}

export function stableId(prefix: string, value: string): string {
	let hash = 2166136261;
	for (const char of value) {
		hash ^= char.charCodeAt(0);
		hash = Math.imul(hash, 16777619);
	}
	return `${prefix}_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

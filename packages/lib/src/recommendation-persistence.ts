import { and, asc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { buildActionPlan, buildManifest, validateGrounding } from "./recommendation-engine";
import * as schema from "./db/schema";
import type { ActionPlan, EvidenceItem, InputManifest } from "@workspace/selena-visibility-contracts";

type Db = NodePgDatabase<typeof schema>;
export type RecommendationContext = {
	actorId: string;
	tenantId: string;
	role: "owner" | "member" | "viewer";
	authType: "session" | "api_key";
	permissions: string[];
};

function inputHash(datasetId: string, evidence: EvidenceItem[], rulepackVersion: string): string {
	return JSON.stringify({
		datasetId,
		rulepackVersion,
		evidence: evidence.map(({ id, tenantId, snapshotId, sourceRef, capturedAt, subject, text, metadata }) => ({
			id,
			tenantId,
			snapshotId,
			sourceRef,
			capturedAt,
			subject,
			text,
			metadata,
		})),
	});
}

function writeGuard(ctx: RecommendationContext) {
	if (ctx.role === "viewer") throw new Error("RECOMMENDATION_WRITE_FORBIDDEN");
}

export function createRecommendationRepositories(db: Db) {
	const assertProject = async (ctx: RecommendationContext, projectId: string) => {
		const [project] = await db
			.select({ id: schema.svProjects.id })
			.from(schema.svProjects)
			.where(and(eq(schema.svProjects.id, projectId), eq(schema.svProjects.organizationId, ctx.tenantId)))
			.limit(1);
		if (!project) throw new Error("RECOMMENDATION_PROJECT_NOT_FOUND");
	};
	const getRun = async (ctx: RecommendationContext, runId: string) => {
		const [run] = await db
			.select()
			.from(schema.svRecommendationRuns)
			.where(
				and(eq(schema.svRecommendationRuns.id, runId), eq(schema.svRecommendationRuns.organizationId, ctx.tenantId)),
			)
			.limit(1);
		if (!run) throw new Error("RECOMMENDATION_RUN_NOT_FOUND");
		return run;
	};
	return {
		create: async (
			ctx: RecommendationContext,
			input: {
				projectId: string;
				datasetId: string;
				idempotencyKey: string;
				evidence: EvidenceItem[];
				rulepackVersion?: string;
				actionPlan?: ActionPlan;
				manifest?: InputManifest;
			},
		) => {
			writeGuard(ctx);
			await assertProject(ctx, input.projectId);
			const version = input.rulepackVersion ?? "ai-website-v1";
			if (input.evidence.some((item) => item.tenantId !== ctx.tenantId))
				throw new Error("RECOMMENDATION_CROSS_TENANT_EVIDENCE");
			const hash = inputHash(input.datasetId, input.evidence, version);
			const existing = await db
				.select()
				.from(schema.svRecommendationRuns)
				.where(
					and(
						eq(schema.svRecommendationRuns.organizationId, ctx.tenantId),
						eq(schema.svRecommendationRuns.idempotencyKey, input.idempotencyKey),
					),
				)
				.limit(1);
			if (existing[0]) {
				if (existing[0].inputHash !== hash) throw new Error("RECOMMENDATION_IMMUTABLE_INPUT_MISMATCH");
				return existing[0];
			}
			const manifest = input.manifest ?? buildManifest(ctx.tenantId, input.datasetId, input.evidence, version);
			if (
				manifest.tenantId !== ctx.tenantId ||
				manifest.datasetId !== input.datasetId ||
				manifest.evidenceIds.length !== input.evidence.length
			)
				throw new Error("RECOMMENDATION_MANIFEST_INPUT_MISMATCH");
			const plan = input.actionPlan ?? buildActionPlan(ctx.tenantId, manifest, input.evidence);
			if (plan.tenantId !== ctx.tenantId || plan.manifestId !== manifest.id)
				throw new Error("RECOMMENDATION_MANIFEST_MISMATCH");
			const groundingErrors = validateGrounding(plan, input.evidence);
			if (groundingErrors.length) throw new Error(`RECOMMENDATION_GROUNDING_FAILED:${groundingErrors.join(",")}`);
			return db.transaction(async (tx) => {
				const [run] = await tx
					.insert(schema.svRecommendationRuns)
					.values({
						organizationId: ctx.tenantId,
						projectId: input.projectId,
						idempotencyKey: input.idempotencyKey,
						datasetId: input.datasetId,
						inputHash: hash,
						rulepackVersion: version,
						status: "READY",
						groundingStatus: "PASS",
						actionPlan: plan,
						createdBy: ctx.actorId,
						completedAt: new Date(),
					})
					.returning();
				await tx
					.insert(schema.svRecommendationManifests)
					.values({
						id: manifest.id,
						runId: run.id,
						organizationId: ctx.tenantId,
						datasetId: manifest.datasetId,
						inputHash: hash,
						snapshotIds: manifest.snapshotIds,
						evidenceIds: manifest.evidenceIds,
						rulepackVersion: manifest.rulepackVersion,
					});
				if (input.evidence.length)
					await tx
						.insert(schema.svRecommendationEvidence)
						.values(
							input.evidence.map((item) => ({
								...item,
								runId: run.id,
								organizationId: ctx.tenantId,
								metadata: item.metadata,
							})),
						);
				if (plan.findings.length)
					await tx
						.insert(schema.svRecommendationFindings)
						.values(
							plan.findings.map((item) => ({
								id: item.id,
								organizationId: ctx.tenantId,
								runId: run.id,
								category: item.category,
								statement: item.statement,
								evidenceIds: item.evidenceIds,
								confidence: item.confidence,
								confidenceScore: String(item.confidenceScore),
								severity: item.severity,
								unknown: item.unknown,
								ruleId: item.ruleId,
							})),
						);
				if (plan.recommendations.length)
					await tx
						.insert(schema.svRecommendationActions)
						.values(
							plan.recommendations.map((item) => ({
								id: item.id,
								organizationId: ctx.tenantId,
								runId: run.id,
								findingId: item.findingId,
								title: item.title,
								action: item.action,
								rationale: item.rationale,
								evidenceIds: item.evidenceIds,
								priority: item.priority,
								effort: item.effort,
								confidence: item.confidence,
								blocked: item.blocked,
								blockReason: item.blockReason,
							})),
						);
				if (plan.tasks.length)
					await tx
						.insert(schema.svRecommendationTasks)
						.values(
							plan.tasks.map((item) => ({
								id: item.id,
								organizationId: ctx.tenantId,
								runId: run.id,
								recommendationId: item.recommendationId,
								title: item.title,
								horizon: item.horizon,
								owner: item.owner,
								steps: item.steps,
								evidenceIds: item.evidenceIds,
								verificationPlan: item.verificationPlan,
							})),
						);
				return run;
			});
		},
		status: getRun,
		findings: async (ctx: RecommendationContext, runId: string) => {
			await getRun(ctx, runId);
			return db
				.select()
				.from(schema.svRecommendationFindings)
				.where(
					and(
						eq(schema.svRecommendationFindings.runId, runId),
						eq(schema.svRecommendationFindings.organizationId, ctx.tenantId),
					),
				)
				.orderBy(asc(schema.svRecommendationFindings.id));
		},
		recommendations: async (ctx: RecommendationContext, runId: string) => {
			await getRun(ctx, runId);
			return db
				.select()
				.from(schema.svRecommendationActions)
				.where(
					and(
						eq(schema.svRecommendationActions.runId, runId),
						eq(schema.svRecommendationActions.organizationId, ctx.tenantId),
					),
				)
				.orderBy(asc(schema.svRecommendationActions.id));
		},
		actionPlan: async (ctx: RecommendationContext, runId: string): Promise<ActionPlan> => {
			const run = await getRun(ctx, runId);
			return (run.actionPlan ?? {}) as ActionPlan;
		},
	};
}

import { createServerFn } from "@tanstack/react-start";
import { db } from "@workspace/lib/db/db";
import { svConfigurationLocks, svOrders } from "@workspace/lib/db/schema";
import {
	type AnswerAnalysis,
	analyzeAnswer,
	summarizeScenarioSet,
} from "@workspace/lib/selena-answer-analysis";
import { createSelenaRepositories, type SelenaRepositoryContext } from "@workspace/lib/selena-visibility-repositories";
import { parseAnalysisSubjects } from "@workspace/selena-visibility-contracts";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth/helpers";
import { resolveSessionAuthContext } from "../lib/selena-auth-context";

// Reads the answers an order produced and reports who they named and what they
// leaned on. The stage is re-runnable on purpose: findings are derived, never
// authored, so recomputing them can only ever restate what the answers say.

const repositories = /* @__PURE__ */ createSelenaRepositories(db);

async function requireAdminContext(): Promise<SelenaRepositoryContext> {
	await requireAdmin();
	return resolveSessionAuthContext();
}

export function readRetainedAnswer(payload: unknown): { text: string; citedUrls?: string[] } | null {
	if (typeof payload !== "object" || payload === null) return null;
	const answer = (payload as Record<string, unknown>).answer;
	if (typeof answer !== "object" || answer === null) return null;
	const record = answer as Record<string, unknown>;
	const text = typeof record.text === "string" ? record.text : "";
	if (text.trim() === "") return null;
	const citedUrls = Array.isArray(record.citedUrls)
		? record.citedUrls.filter((url): url is string => typeof url === "string")
		: undefined;
	return citedUrls ? { text, citedUrls } : { text };
}

export function readStoredAnalysis(payload: unknown): AnswerAnalysis | null {
	if (typeof payload !== "object" || payload === null) return null;
	const analysis = (payload as Record<string, unknown>).analysis;
	if (typeof analysis !== "object" || analysis === null) return null;
	const record = analysis as Record<string, unknown>;
	if (typeof record.brandMentioned !== "boolean" || !Array.isArray(record.mentions)) return null;
	return record as unknown as AnswerAnalysis;
}

/** The whole read: shared by the operator action and the client's results step. */
export async function computeOrderAnalysis(context: SelenaRepositoryContext, orderId: string) {
	const data = { orderId };
	{
		const [order] = await db
			.select({ id: svOrders.id, lockId: svOrders.lockId })
			.from(svOrders)
			.where(and(eq(svOrders.id, data.orderId), eq(svOrders.organizationId, context.tenantId)))
			.limit(1);
		if (!order) throw new Error("Not found: order is outside AuthContext tenant");

		const [lock] = await db
			.select({ snapshot: svConfigurationLocks.snapshot })
			.from(svConfigurationLocks)
			.where(and(eq(svConfigurationLocks.id, order.lockId), eq(svConfigurationLocks.organizationId, context.tenantId)))
			.limit(1);
		// Subjects come from the lock, never from the live profile: the report
		// answers for the configuration the customer paid against.
		const subjects = parseAnalysisSubjects(lock?.snapshot);
		if (!subjects) throw new Error("SELENA_LOCK_SUBJECTS_MISSING");

		const runs = await repositories.runs.listForOrder(context, data.orderId);
		const analyses: AnswerAnalysis[] = [];
		let analyzed = 0;
		let reused = 0;
		let withoutAnswer = 0;

		for (const run of runs) {
			const retained = readRetainedAnswer(run.canonicalPayload);
			if (retained) {
				const analysis = analyzeAnswer({
					text: retained.text,
					brand: subjects.brand,
					competitors: subjects.competitors,
					citedUrls: retained.citedUrls,
				});
				await repositories.runs.saveAnalysis(context, run.id, analysis);
				analyses.push(analysis);
				analyzed += 1;
				continue;
			}
			// Past its retention window the text is gone and its findings are not:
			// an old cycle still reports, it just cannot be re-read.
			const stored = readStoredAnalysis(run.canonicalPayload);
			if (stored) {
				analyses.push(stored);
				reused += 1;
				continue;
			}
			withoutAnswer += 1;
		}

		return {
			orderId: data.orderId,
			runsSeen: runs.length,
			analyzed,
			reused,
			withoutAnswer,
			brand: subjects.brand.name,
			summary: summarizeScenarioSet(analyses, { brandDomain: subjects.brand.domain }),
		};
	}
}

export const analyzeSelenaOrderFn = createServerFn({ method: "POST" })
	.validator(z.object({ orderId: z.string().uuid() }))
	.handler(async ({ data }) => computeOrderAnalysis(await requireAdminContext(), data.orderId));

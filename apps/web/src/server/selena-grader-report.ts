import { createServerFn } from "@tanstack/react-start";
import { db } from "@workspace/lib/db/db";
import { svConfigurationLocks, svCycles, svOrders, svRecommendationRuns, svScenarios, svWebsiteSnapshots } from "@workspace/lib/db/schema";
import {
	type GraderChannel,
	type GraderReport,
	type GraderRunInput,
	buildGraderReport,
} from "@workspace/lib/selena-grader-report";
import { createSelenaRepositories } from "@workspace/lib/selena-visibility-repositories";
import { analyzeAnswer } from "@workspace/lib/selena-answer-analysis";
import { WEBSITE_SIGNAL_RULES } from "@workspace/lib/website-collector";
import { actionPlanSchema, measurementScopeSchema, parseAnalysisSubjects } from "@workspace/selena-visibility-contracts";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { resolveSessionAuthContext } from "../lib/selena-auth-context";
import { readRetainedAnswer, readStoredAnalysis } from "./selena-order-analysis";

const repositories = /* @__PURE__ */ createSelenaRepositories(db);

export type GraderReportView = {
	project: { id: string; name: string; region: string | null; country: string | null };
	inputs: {
		brandName: string;
		primaryDomain: string;
		publicProfiles: string[];
		competitorsConfigured: number;
	} | null;
	planId: string | null;
	measuredAt: string | null;
	cycle: { status: string; expectedRuns: number; completedRuns: number } | null;
	report: GraderReport | null;
	/** The free website audit: every rule with its outcome, plus the plan. */
	freeAudit: {
		websiteUrl: string;
		capturedAt: string;
		checks: { subject: string; ruleId: string; severity: "HIGH" | "MEDIUM" | "LOW"; ok: boolean; unknown: boolean }[];
		actions: { title: string; action: string; priority: string }[];
	} | null;
};

function readString(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * The whole customer-facing report in one read. The client's own session is
 * enough — everything here is their own project's evidence, and tenant
 * scoping is the guard on every query.
 */
export const getSelenaGraderReportFn = createServerFn({ method: "GET" })
	.validator(z.object({ projectId: z.string().uuid() }))
	.handler(async ({ data }): Promise<GraderReportView> => {
		const context = await resolveSessionAuthContext();
		const project = await repositories.projects.get(context, data.projectId);
		if (!project) throw new Error("Not found: project is outside AuthContext tenant");

		const profile = await repositories.profiles.get(context, data.projectId);
		const inputs = profile
			? {
					brandName: profile.brandName,
					primaryDomain: profile.primaryDomain,
					publicProfiles: (Array.isArray(profile.publicProfiles) ? profile.publicProfiles : [])
						.map((entry) => readString((entry as Record<string, unknown>)?.url))
						.filter((url): url is string => url !== null),
					competitorsConfigured: Array.isArray(profile.competitorSnapshot) ? profile.competitorSnapshot.length : 0,
				}
			: null;

		const [websiteSnapshot, recommendationRun] = await Promise.all([
			db
				.select({ website: svWebsiteSnapshots.website, capturedAt: svWebsiteSnapshots.capturedAt })
				.from(svWebsiteSnapshots)
				.where(
					and(eq(svWebsiteSnapshots.projectId, data.projectId), eq(svWebsiteSnapshots.organizationId, context.tenantId)),
				)
				.orderBy(desc(svWebsiteSnapshots.capturedAt))
				.limit(1)
				.then((rows) => rows[0] ?? null),
			db
				.select({ actionPlan: svRecommendationRuns.actionPlan })
				.from(svRecommendationRuns)
				.where(
					and(
						eq(svRecommendationRuns.projectId, data.projectId),
						eq(svRecommendationRuns.organizationId, context.tenantId),
					),
				)
				.orderBy(desc(svRecommendationRuns.createdAt))
				.limit(1)
				.then((rows) => rows[0] ?? null),
		]);
		const parsedPlan = actionPlanSchema.safeParse(recommendationRun?.actionPlan);
		const freeAudit =
			websiteSnapshot && parsedPlan.success
				? {
						websiteUrl: websiteSnapshot.website,
						capturedAt: websiteSnapshot.capturedAt.toISOString(),
						checks: WEBSITE_SIGNAL_RULES.map(([subject, ruleId, , severity]) => {
							const finding = parsedPlan.data.findings.find((item) => item.ruleId === ruleId);
							return { subject, ruleId, severity, ok: !finding, unknown: finding?.unknown ?? false };
						}),
						actions: parsedPlan.data.recommendations
							.filter((item) => !item.blocked)
							.slice(0, 3)
							.map((item) => ({ title: item.title, action: item.action, priority: item.priority })),
					}
				: null;

		const view: GraderReportView = {
			project: {
				id: project.id,
				name: project.name,
				region: readString((project as Record<string, unknown>).region),
				country: readString((project as Record<string, unknown>).country),
			},
			inputs,
			planId: null,
			measuredAt: null,
			cycle: null,
			report: null,
			freeAudit,
		};

		const [order] = await db
			.select({ id: svOrders.id, lockId: svOrders.lockId })
			.from(svOrders)
			.where(and(eq(svOrders.projectId, data.projectId), eq(svOrders.organizationId, context.tenantId)))
			.orderBy(desc(svOrders.createdAt))
			.limit(1);
		if (!order) return view;

		const [lock] = await db
			.select({ snapshot: svConfigurationLocks.snapshot })
			.from(svConfigurationLocks)
			.where(and(eq(svConfigurationLocks.id, order.lockId), eq(svConfigurationLocks.organizationId, context.tenantId)))
			.limit(1);
		const snapshot = (lock?.snapshot ?? null) as Record<string, unknown> | null;
		const subjects = parseAnalysisSubjects(lock?.snapshot);
		const scope = measurementScopeSchema.safeParse(snapshot?.measurementScope);
		view.planId = readString(snapshot?.planId);

		const [cycle] = await db
			.select({
				status: svCycles.status,
				expectedRuns: svCycles.expectedRuns,
				completedRuns: svCycles.completedRuns,
				createdAt: svCycles.createdAt,
			})
			.from(svCycles)
			.where(and(eq(svCycles.orderId, order.id), eq(svCycles.organizationId, context.tenantId)))
			.orderBy(desc(svCycles.createdAt))
			.limit(1);
		if (cycle) {
			view.cycle = { status: cycle.status, expectedRuns: cycle.expectedRuns, completedRuns: cycle.completedRuns };
			view.measuredAt = cycle.createdAt.toISOString();
		}
		if (!subjects) return view;

		const runs = await repositories.runs.listForOrder(context, order.id);

		const scenarioIds = [...new Set(runs.map((run) => run.scenarioId))];
		const scenarioRows =
			scenarioIds.length === 0
				? []
				: await db
						.select({ id: svScenarios.id, text: svScenarios.text, language: svScenarios.language })
						.from(svScenarios)
						.where(and(inArray(svScenarios.id, scenarioIds), eq(svScenarios.organizationId, context.tenantId)));
		const scenarioById = new Map(scenarioRows.map((row) => [row.id, row]));

		// A run that predates systemId stamping still belongs to a channel; the
		// scope names that channel's systems, so a single-system channel can be
		// attributed and anything else stays visibly unattributed.
		const channelSystems = new Map<string, string[]>();
		if (scope.success)
			for (const system of scope.data.systems) {
				const bucket = channelSystems.get(system.channel) ?? [];
				bucket.push(system.systemId);
				channelSystems.set(system.channel, bucket);
			}

		const graderRuns: GraderRunInput[] = runs.map((run) => {
			const scenario = scenarioById.get(run.scenarioId);
			const channel: GraderChannel = run.channel === "API" ? "API" : "VISITOR";
			const fallbackSystems = channelSystems.get(channel) ?? [];
			return {
				runId: run.id,
				systemId: run.systemId ?? (fallbackSystems.length === 1 ? fallbackSystems[0] : "unattributed"),
				channel,
				scenarioId: run.scenarioId,
				scenarioText: scenario?.text ?? "",
				scenarioLanguage: scenario?.language ?? "",
				// A GET must not write: analysis is read from the payload when the
				// admin action already saved it, and recomputed in memory from the
				// retained text otherwise. Persisting stays with the admin POST, so
				// a read-only viewer can always open the report.
				analysis:
					readStoredAnalysis(run.canonicalPayload) ??
					(() => {
						const retained = readRetainedAnswer(run.canonicalPayload);
						return retained
							? analyzeAnswer({
									text: retained.text,
									brand: subjects.brand,
									competitors: subjects.competitors,
									citedUrls: retained.citedUrls,
								})
							: null;
					})(),
			};
		});

		view.report = buildGraderReport({
			runs: graderRuns,
			subjects,
			repeats: scope.success ? scope.data.repeats : null,
		});
		return view;
	});

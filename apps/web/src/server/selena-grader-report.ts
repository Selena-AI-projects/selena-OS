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
import { type SelenaPlanId, monthlyAnswerAllowance, planIds } from "@workspace/selena-visibility-contracts";
import { WEBSITE_SIGNAL_RULES } from "@workspace/lib/website-collector";
import { actionPlanSchema, measurementScopeSchema, parseAnalysisSubjects } from "@workspace/selena-visibility-contracts";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
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
	/** The calendar month's spent answers against the plan's quoted allowance. */
	monthUsage: { used: number; allowance: number } | null;
	cycle: { status: string; expectedRuns: number; completedRuns: number } | null;
	report: GraderReport | null;
	/** The free website audit: every rule with its outcome, plus the plan. */
	freeAudit: {
		websiteUrl: string;
		capturedAt: string;
		checks: { subject: string; ruleId: string; severity: "HIGH" | "MEDIUM" | "LOW"; ok: boolean; unknown: boolean }[];
		actions: { ruleId: string; title: string; action: string; priority: string }[];
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
		const priorityRank: Record<string, number> = { NOW: 0, NEXT: 1, LATER: 2 };
		const ruleByFinding = new Map(parsedPlan.success ? parsedPlan.data.findings.map((f) => [f.id, f.ruleId]) : []);
		const baseRuleIds = new Set(WEBSITE_SIGNAL_RULES.map(([, ruleId]) => ruleId));
		const freeAudit =
			websiteSnapshot && parsedPlan.success
				? {
						websiteUrl: websiteSnapshot.website,
						capturedAt: websiteSnapshot.capturedAt.toISOString(),
						checks: [
							...WEBSITE_SIGNAL_RULES.map(([subject, ruleId, , severity]) => {
								const finding = parsedPlan.data.findings.find((item) => item.ruleId === ruleId);
								return { subject, ruleId, severity, ok: !finding, unknown: finding?.unknown ?? false };
							}),
							// Rules beyond the base table (Maps linkage, AI-crawler access…)
							// only surface as findings when they fail; a passing one leaves
							// no record, so it is not shown rather than claimed as ✓.
							...parsedPlan.data.findings
								.filter((finding) => !baseRuleIds.has(finding.ruleId))
								.map((finding) => ({
									subject: finding.ruleId,
									ruleId: finding.ruleId,
									severity: (finding.severity === "CRITICAL" ? "HIGH" : finding.severity) as "HIGH" | "MEDIUM" | "LOW",
									ok: false,
									unknown: finding.unknown,
								})),
						],
						// The whole plan, most urgent first — a capped list read as "that
						// is everything" when it was not.
						actions: parsedPlan.data.recommendations
							.filter((item) => !item.blocked)
							.sort((left, right) => (priorityRank[left.priority] ?? 9) - (priorityRank[right.priority] ?? 9))
							.map((item) => ({
								ruleId: ruleByFinding.get(item.findingId) ?? "",
								title: item.title,
								action: item.action,
								priority: item.priority,
							})),
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
			monthUsage: null,
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
		const planForAllowance = (planIds as readonly string[]).includes(view.planId ?? "")
			? monthlyAnswerAllowance(view.planId as SelenaPlanId)
			: null;
		if (planForAllowance !== null) {
			const monthStart = new Date();
			monthStart.setUTCDate(1);
			monthStart.setUTCHours(0, 0, 0, 0);
			const [usage] = await db
				.select({ used: sql<number>`coalesce(sum(${svCycles.expectedRuns}), 0)` })
				.from(svCycles)
				.innerJoin(svOrders, eq(svCycles.orderId, svOrders.id))
				.where(
					and(
						eq(svOrders.projectId, data.projectId),
						eq(svOrders.organizationId, context.tenantId),
						gte(svCycles.createdAt, monthStart),
					),
				);
			view.monthUsage = { used: Number(usage?.used ?? 0), allowance: planForAllowance };
		}

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

		const allRuns = await repositories.runs.listForOrder(context, order.id);
		// The report speaks for the newest cycle: mixing runs from an order's
		// earlier cycles would double-count questions and misstate the counts.
		const latestCycleId = (
			await db
				.select({ id: svCycles.id })
				.from(svCycles)
				.where(and(eq(svCycles.orderId, order.id), eq(svCycles.organizationId, context.tenantId)))
				.orderBy(desc(svCycles.createdAt))
				.limit(1)
		)[0]?.id;
		const runs = latestCycleId ? allRuns.filter((run) => run.cycleId === latestCycleId) : allRuns;

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
				captureMode: run.captureMode ?? null,
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

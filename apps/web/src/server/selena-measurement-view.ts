import { createServerFn } from "@tanstack/react-start";
import { db } from "@workspace/lib/db/db";
import { svCycles, svOrders, svPromptFamilies, svScenarios } from "@workspace/lib/db/schema";
import { computeLedgerReport, type LedgerReport } from "@workspace/lib/selena-ledger-metrics";
import { createSelenaRepositories } from "@workspace/lib/selena-visibility-repositories";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { scenarioKindsFrom } from "@/lib/selena-measurement-view";
import { resolveSessionAuthContext } from "../lib/selena-auth-context";

const repositories = /* @__PURE__ */ createSelenaRepositories(db);

export type MeasurementCycleSummary = {
	id: string;
	status: string;
	expectedRuns: number;
	completedRuns: number;
	createdAt: string;
};

export type MeasurementView = {
	cycles: MeasurementCycleSummary[];
	/** The newest cycle's ledger report; null while the project has no cycle. */
	latest: { cycleId: string; report: LedgerReport } | null;
};

/**
 * Step 4 of the cabinet: what the paid measurement observed, straight from the
 * evidence ledger. Branded and non-branded arrive as separate groups, an empty
 * group arrives as UNKNOWN, and no composite score exists anywhere in the
 * payload — the section renders exactly what the ledger can prove.
 */
export const getSelenaMeasurementFn = createServerFn({ method: "GET" })
	.validator(z.object({ projectId: z.string().uuid() }))
	.handler(async ({ data }): Promise<MeasurementView> => {
		const context = await resolveSessionAuthContext();
		const project = await repositories.projects.get(context, data.projectId);
		if (!project) throw new Error("Not found: project is outside AuthContext tenant");

		const cycles = await db
			.select({
				id: svCycles.id,
				status: svCycles.status,
				expectedRuns: svCycles.expectedRuns,
				completedRuns: svCycles.completedRuns,
				createdAt: svCycles.createdAt,
			})
			.from(svCycles)
			.innerJoin(svOrders, eq(svCycles.orderId, svOrders.id))
			.where(and(eq(svOrders.projectId, data.projectId), eq(svCycles.organizationId, context.tenantId)))
			.orderBy(desc(svCycles.createdAt))
			.limit(12);

		if (cycles.length === 0) return { cycles: [], latest: null };

		const [scenarioRows, ledger] = await Promise.all([
			db
				.select({ id: svScenarios.id, intentType: svPromptFamilies.intentType })
				.from(svScenarios)
				.innerJoin(svPromptFamilies, eq(svScenarios.familyId, svPromptFamilies.id))
				.where(and(eq(svPromptFamilies.projectId, data.projectId), eq(svScenarios.organizationId, context.tenantId))),
			repositories.runs.ledgerForCycle(context, cycles[0].id),
		]);

		return {
			cycles: cycles.map((cycle) => ({
				id: cycle.id,
				status: cycle.status,
				expectedRuns: cycle.expectedRuns,
				completedRuns: cycle.completedRuns,
				createdAt: cycle.createdAt.toISOString(),
			})),
			latest: {
				cycleId: cycles[0].id,
				report: computeLedgerReport(ledger.rows, ledger.mentions, scenarioKindsFrom(scenarioRows)),
			},
		};
	});

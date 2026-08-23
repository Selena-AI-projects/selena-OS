import { createServerFn } from "@tanstack/react-start";
import { db } from "@workspace/lib/db/db";
import { svCycles, svOrders } from "@workspace/lib/db/schema";
import { computeCycleDiff, type CycleDiffReport } from "@workspace/lib/selena-cycle-diff";
import { createSelenaRepositories } from "@workspace/lib/selena-visibility-repositories";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { resolveSessionAuthContext } from "../lib/selena-auth-context";

const repositories = createSelenaRepositories(db);

export type CycleCompareResult =
	| { comparable: false; cyclesAvailable: number }
	| {
			comparable: true;
			base: { cycleId: string; createdAt: string };
			compare: { cycleId: string; createdAt: string };
			report: CycleDiffReport;
	  };

/**
 * Step 7 of the cabinet: what changed between the two newest cycles, in which
 * measured runs — never why. Fewer than two cycles is a closed step, answered
 * as such rather than invented.
 */
export const getSelenaCycleCompareFn = createServerFn({ method: "GET" })
	.validator(z.object({ projectId: z.string().uuid() }))
	.handler(async ({ data }): Promise<CycleCompareResult> => {
		const context = await resolveSessionAuthContext();
		const project = await repositories.projects.get(context, data.projectId);
		if (!project) throw new Error("Not found: project is outside AuthContext tenant");

		const cycles = await db
			.select({ id: svCycles.id, createdAt: svCycles.createdAt })
			.from(svCycles)
			.innerJoin(svOrders, eq(svCycles.orderId, svOrders.id))
			.where(and(eq(svOrders.projectId, data.projectId), eq(svCycles.organizationId, context.tenantId)))
			.orderBy(desc(svCycles.createdAt))
			.limit(2);
		if (cycles.length < 2) return { comparable: false, cyclesAvailable: cycles.length };

		const [compare, base] = cycles;
		const [baseLedger, compareLedger] = await Promise.all([
			repositories.runs.ledgerForCycle(context, base.id),
			repositories.runs.ledgerForCycle(context, compare.id),
		]);
		return {
			comparable: true,
			base: { cycleId: base.id, createdAt: base.createdAt.toISOString() },
			compare: { cycleId: compare.id, createdAt: compare.createdAt.toISOString() },
			report: computeCycleDiff(baseLedger, compareLedger),
		};
	});

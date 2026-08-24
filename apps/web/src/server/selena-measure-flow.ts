import { createServerFn } from "@tanstack/react-start";
import { db } from "@workspace/lib/db/db";
import { svCycles, svOrders, svPromptFamilies, svScenarios } from "@workspace/lib/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { isAdmin, requireAuthSession } from "@/lib/auth/helpers";
import { computeOrderAnalysis } from "./selena-order-analysis";
import { resolveSessionAuthContext } from "../lib/selena-auth-context";

// One read behind the client's four-step flow: the questions, the latest
// measurement's progress, and — once it is done — its findings. The screen
// polls this, so the expensive analysis only runs when asked for.

export const getSelenaMeasureFlowFn = createServerFn({ method: "GET" })
	.validator(z.object({ projectId: z.string().uuid(), withSummary: z.boolean().optional() }))
	.handler(async ({ data }) => {
		const session = await requireAuthSession();
		const context = await resolveSessionAuthContext();

		const scenarios = await db
			.select({
				id: svScenarios.id,
				text: svScenarios.text,
				language: svScenarios.language,
				status: svScenarios.status,
			})
			.from(svScenarios)
			.innerJoin(svPromptFamilies, eq(svScenarios.familyId, svPromptFamilies.id))
			.where(and(eq(svPromptFamilies.projectId, data.projectId), eq(svScenarios.organizationId, context.tenantId)))
			.orderBy(svScenarios.createdAt);

		const [order] = await db
			.select({ id: svOrders.id, status: svOrders.status, createdAt: svOrders.createdAt })
			.from(svOrders)
			.where(and(eq(svOrders.projectId, data.projectId), eq(svOrders.organizationId, context.tenantId)))
			.orderBy(desc(svOrders.createdAt))
			.limit(1);

		let measurement: null | {
			orderId: string;
			orderStatus: string;
			expectedRuns: number;
			completedRuns: number;
			cycleStatus: string | null;
		} = null;
		if (order) {
			const [cycle] = await db
				.select({
					status: svCycles.status,
					expectedRuns: svCycles.expectedRuns,
					completedRuns: svCycles.completedRuns,
				})
				.from(svCycles)
				.where(and(eq(svCycles.orderId, order.id), eq(svCycles.organizationId, context.tenantId)))
				.orderBy(desc(svCycles.createdAt))
				.limit(1);
			measurement = {
				orderId: order.id,
				orderStatus: order.status,
				expectedRuns: cycle?.expectedRuns ?? 0,
				completedRuns: cycle?.completedRuns ?? 0,
				cycleStatus: cycle?.status ?? null,
			};
		}

		// The analysis re-reads every retained answer, so the screen asks for it
		// once when the count is full — not on every poll tick.
		const summary =
			data.withSummary && order ? await computeOrderAnalysis(context, order.id).catch(() => null) : null;

		return { canStart: isAdmin(session), scenarios, measurement, summary };
	});

import { createServerFn } from "@tanstack/react-start";
import { db } from "@workspace/lib/db/db";
import { svAuditEvents, svOrderRequests, svProjects, svScenarios } from "@workspace/lib/db/schema";
import { createSelenaRepositories, type SelenaRepositoryContext } from "@workspace/lib/selena-visibility-repositories";
import {
	decideFreeAutoDispatch,
	type FreeAutoDispatchStatus,
	freeAutoDispatchConfigFromEnv,
	promoCodeApplies,
	SELENA_CATALOG,
} from "@workspace/selena-visibility-contracts";
import { and, count, desc, eq, gte, inArray } from "drizzle-orm";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth/helpers";
import { resolveSessionAuthContext } from "../lib/selena-auth-context";
import { prepareSelenaScenarios, startSelenaMeasurement } from "./selena-order-desk";

const repositories = /* @__PURE__ */ createSelenaRepositories(db);

// A request is a lead. The operator reads these on the admin desk and builds
// the paid order there, so the money path keeps its single human gate. The one
// exception is a request a promo code already made free: it may start itself,
// under caps and behind a default-off flag.

export const orderRequestPlanIds = ["visitor-local", "full-ai-landscape"] as const;

const createSchema = z.object({
	projectId: z.string().uuid(),
	planId: z.enum(orderRequestPlanIds),
	contactName: z.string().trim().min(1).max(200),
	contactChannel: z.string().trim().min(3).max(300),
	comment: z.string().trim().max(2000).optional(),
	promoCode: z.string().trim().max(100).optional(),
});

/**
 * A free request can start itself, under caps and behind a default-off flag.
 *
 * The scenarios it approves are the customer's own questions from their own
 * confirmed profile, and the plan is free — so the operator gate here is not
 * protecting a payment, it is only protecting against volume. That is what the
 * caps are for. Anything that goes wrong leaves the request in the inbox as
 * ordinary work: the lead is already saved before this runs, and no failure
 * here is allowed to lose it.
 */
async function autoDispatchFreeRequest(input: {
	context: SelenaRepositoryContext;
	requestId: string;
	projectId: string;
	planId: (typeof orderRequestPlanIds)[number];
	promoApplied: boolean;
}): Promise<{ status: FreeAutoDispatchStatus; expectedRuns: number } | { status: null; reason: string }> {
	const config = freeAutoDispatchConfigFromEnv(process.env);
	const dayStart = new Date();
	dayStart.setUTCHours(0, 0, 0, 0);
	// Deliberately not scoped to this tenant: a promo code that leaks is used
	// from fresh accounts, so a per-tenant ceiling would not bound the spend it
	// causes. The project cap is tenant-scoped by construction.
	const dispatchedToday = async (scope: "everyone" | "project") =>
		Number(
			(
				await db
					.select({ value: count() })
					.from(svOrderRequests)
					.where(
						and(
							eq(svOrderRequests.status, "AUTO_QUEUED"),
							gte(svOrderRequests.createdAt, dayStart),
							...(scope === "project" ? [eq(svOrderRequests.projectId, input.projectId)] : []),
						),
					)
			)[0]?.value ?? 0,
		);
	const capsApply = config.enabled && input.promoApplied;
	const decision = decideFreeAutoDispatch({
		config,
		promoApplied: input.promoApplied,
		dispatchedToday: capsApply ? await dispatchedToday("everyone") : 0,
		dispatchedTodayForProject: capsApply ? await dispatchedToday("project") : 0,
	});
	if (!decision.dispatch) {
		// A cap refusal is a free measurement the customer expected and did not
		// get, so it is recorded; the flag being off is not an event.
		if (capsApply)
			await db.insert(svAuditEvents).values({
				organizationId: input.context.tenantId,
				actorId: input.context.actorId,
				event: "ORDER_REQUEST_AUTO_DISPATCH_REFUSED",
				subjectKind: "sv_order_requests",
				subjectId: input.requestId,
				details: { planId: input.planId, reason: decision.reason },
			});
		return { status: null, reason: decision.reason };
	}

	const plan = SELENA_CATALOG[input.planId];
	const questionCap = (plan.questionLimitPerMeasurement ?? 25) * Math.max(1, plan.languageLimit);
	try {
		const { familyId } = await prepareSelenaScenarios(input.context, input.projectId);
		const proposed = (await repositories.scenarios.list(input.context, familyId))
			.filter((scenario) => scenario.status === "PROPOSED" || scenario.status === "APPROVED")
			.slice(0, questionCap);
		if (proposed.length === 0) throw new Error("SELENA_PROFILE_HAS_NO_QUESTIONS");
		const scenarioIds = proposed.map((scenario) => scenario.id);
		await db
			.update(svScenarios)
			.set({ status: "APPROVED", updatedAt: new Date() })
			.where(and(inArray(svScenarios.id, scenarioIds), eq(svScenarios.organizationId, input.context.tenantId)));

		const started = await startSelenaMeasurement(input.context, {
			projectId: input.projectId,
			planId: input.planId,
			scenarioIds,
			idempotencyKey: `auto-request:${input.requestId}`,
		});
		await db.insert(svAuditEvents).values({
			organizationId: input.context.tenantId,
			actorId: input.context.actorId,
			event: "ORDER_REQUEST_AUTO_DISPATCHED",
			subjectKind: "sv_order_requests",
			subjectId: input.requestId,
			details: {
				planId: input.planId,
				orderId: started.orderId,
				expectedRuns: started.expectedRuns,
				scenarioCount: scenarioIds.length,
				queued: started.queued,
				stoppedAt: started.stoppedAt,
			},
		});
		return { status: "AUTO_QUEUED", expectedRuns: started.expectedRuns };
	} catch (cause) {
		await db.insert(svAuditEvents).values({
			organizationId: input.context.tenantId,
			actorId: input.context.actorId,
			event: "ORDER_REQUEST_AUTO_DISPATCH_FAILED",
			subjectKind: "sv_order_requests",
			subjectId: input.requestId,
			details: { planId: input.planId, error: cause instanceof Error ? cause.message : String(cause) },
		});
		return { status: "AUTO_FAILED", expectedRuns: 0 };
	}
}

export const createSelenaOrderRequestFn = createServerFn({ method: "POST" })
	.validator(createSchema)
	.handler(async ({ data }) => {
		const context = await resolveSessionAuthContext();
		const project = await repositories.projects.get(context, data.projectId);
		if (!project) throw new Error("Not found: project is outside AuthContext tenant");
		const promoApplied = promoCodeApplies(data.promoCode, process.env);
		const [row] = await db
			.insert(svOrderRequests)
			.values({
				organizationId: context.tenantId,
				projectId: data.projectId,
				planId: data.planId,
				contactName: data.contactName,
				contactChannel: data.contactChannel,
				comment: data.comment || null,
				promoCode: data.promoCode?.trim() ? data.promoCode.trim().toUpperCase() : null,
				promoApplied,
			})
			.returning({ id: svOrderRequests.id });

		const auto = await autoDispatchFreeRequest({
			context,
			requestId: row.id,
			projectId: data.projectId,
			planId: data.planId,
			promoApplied,
		});
		if (auto.status)
			await db
				.update(svOrderRequests)
				.set({ status: auto.status, updatedAt: new Date() })
				.where(eq(svOrderRequests.id, row.id));
		return { id: row.id, promoApplied, autoStarted: auto.status === "AUTO_QUEUED" };
	});

export type OrderRequestRow = {
	id: string;
	projectId: string;
	projectName: string;
	planId: string;
	contactName: string;
	contactChannel: string;
	comment: string | null;
	promoCode: string | null;
	promoApplied: boolean;
	status: string;
	createdAt: string;
};

export const listSelenaOrderRequestsFn = createServerFn({ method: "GET" }).handler(
	async (): Promise<OrderRequestRow[]> => {
		await requireAdmin();
		const context = await resolveSessionAuthContext();
		const rows = await db
			.select({
				id: svOrderRequests.id,
				projectId: svOrderRequests.projectId,
				projectName: svProjects.name,
				planId: svOrderRequests.planId,
				contactName: svOrderRequests.contactName,
				contactChannel: svOrderRequests.contactChannel,
				comment: svOrderRequests.comment,
				promoCode: svOrderRequests.promoCode,
				promoApplied: svOrderRequests.promoApplied,
				status: svOrderRequests.status,
				createdAt: svOrderRequests.createdAt,
			})
			.from(svOrderRequests)
			.innerJoin(svProjects, eq(svOrderRequests.projectId, svProjects.id))
			.where(eq(svOrderRequests.organizationId, context.tenantId))
			.orderBy(desc(svOrderRequests.createdAt));
		return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
	},
);

export const updateSelenaOrderRequestStatusFn = createServerFn({ method: "POST" })
	.validator(z.object({ requestId: z.string().uuid(), status: z.enum(["NEW", "IN_PROGRESS", "CLOSED"]) }))
	.handler(async ({ data }) => {
		await requireAdmin();
		const context = await resolveSessionAuthContext();
		const [row] = await db
			.update(svOrderRequests)
			.set({ status: data.status, updatedAt: new Date() })
			.where(and(eq(svOrderRequests.id, data.requestId), eq(svOrderRequests.organizationId, context.tenantId)))
			.returning({ id: svOrderRequests.id });
		if (!row) throw new Error("Not found: request is outside AuthContext tenant");
		return { id: row.id, status: data.status };
	});

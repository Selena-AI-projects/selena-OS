import { createServerFn } from "@tanstack/react-start";
import { db } from "@workspace/lib/db/db";
import { svOrderRequests, svProjects } from "@workspace/lib/db/schema";
import { createSelenaRepositories } from "@workspace/lib/selena-visibility-repositories";
import { promoCodeApplies } from "@workspace/selena-visibility-contracts";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth/helpers";
import { resolveSessionAuthContext } from "../lib/selena-auth-context";

const repositories = /* @__PURE__ */ createSelenaRepositories(db);

// A request is a lead, not an order: nothing here touches quotes, orders,
// permits or the queue. The operator reads these on the admin desk and builds
// the paid order there, so the money path keeps its single human gate.

export const orderRequestPlanIds = ["visitor-local", "full-ai-landscape"] as const;

const createSchema = z.object({
	projectId: z.string().uuid(),
	planId: z.enum(orderRequestPlanIds),
	contactName: z.string().trim().min(1).max(200),
	contactChannel: z.string().trim().min(3).max(300),
	comment: z.string().trim().max(2000).optional(),
	promoCode: z.string().trim().max(100).optional(),
});

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
		return { id: row.id, promoApplied };
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

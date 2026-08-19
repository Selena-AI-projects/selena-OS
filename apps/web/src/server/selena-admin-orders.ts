import { createServerFn } from "@tanstack/react-start";
import { db } from "@workspace/lib/db/db";
import {
	svAuditEvents,
	svConfigurationLocks,
	svCycles,
	svOrders,
	svPayments,
	svProjects,
	svQcRecords,
	svQuotes,
	svRunPermits,
	svRuns,
} from "@workspace/lib/db/schema";
import { isMaintenanceEnabled } from "@workspace/lib/run-policy";
import { qcDecisions } from "@workspace/lib/selena-dispatch";
import { assertApprovable, evaluatePreflight, type PreflightEvaluation } from "@workspace/lib/selena-preflight";
import { createSelenaRepositories, type SelenaRepositoryContext } from "@workspace/lib/selena-visibility-repositories";
import { measurementConfigFromEnv, parseMeasurementScope } from "@workspace/selena-visibility-contracts";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { isAdmin, requireAdmin, requireAuthSession } from "@/lib/auth/helpers";
import { getBoss } from "@/lib/boss-client";
import { enqueueOrderRuns } from "@/lib/selena-run-enqueue";
import { resolveSessionAuthContext } from "../lib/selena-auth-context";

// Operator surface for the order pipeline: read the preflight, approve (which
// mints run permits and nothing else), enqueue those permits, stop, and record
// a QC decision. No provider is ever contacted here: approval is a permission
// record, enqueueing is a queue write, and the executor that consumes a permit
// lives in the worker. Approval and enqueue stay separate actions so minting
// permission never starts spending on its own.

const repositories = createSelenaRepositories(db);

/** Statuses an operator is expected to act on, newest work first. */
export const adminQueueStatuses = [
	"PAID_REVIEW_REQUIRED",
	"APPROVED",
	"QUEUED",
	"RUNNING",
	"QC_REQUIRED",
	"READY",
] as const;

const orderIdSchema = z.object({ orderId: z.string().uuid() });

async function requireAdminContext(): Promise<SelenaRepositoryContext> {
	await requireAdmin();
	return resolveSessionAuthContext();
}

async function recordAdminAudit(
	context: SelenaRepositoryContext,
	event: string,
	orderId: string,
	details: Record<string, unknown>,
) {
	await db.insert(svAuditEvents).values({
		organizationId: context.tenantId,
		actorId: context.actorId,
		event,
		subjectKind: "sv_orders",
		subjectId: orderId,
		details,
	});
}

async function findPriorAudit(context: SelenaRepositoryContext, event: string, orderId: string, key: string) {
	const [prior] = await db
		.select({ details: svAuditEvents.details, at: svAuditEvents.at })
		.from(svAuditEvents)
		.where(
			and(
				eq(svAuditEvents.organizationId, context.tenantId),
				eq(svAuditEvents.event, event),
				eq(svAuditEvents.subjectId, orderId),
				sql`${svAuditEvents.details} ->> 'idempotencyKey' = ${key}`,
			),
		)
		.limit(1);
	return prior ?? null;
}

async function getOwnedOrder(context: SelenaRepositoryContext, orderId: string) {
	const [order] = await db
		.select()
		.from(svOrders)
		.where(and(eq(svOrders.id, orderId), eq(svOrders.organizationId, context.tenantId)))
		.limit(1);
	if (!order) throw new Error("Not found: order is outside AuthContext tenant");
	return order;
}

/**
 * The provider budget is an owner-set ceiling, not a balance read from any
 * provider: nothing in this layer may talk to one. Unset means zero, which
 * preflight reports as a blocker instead of guessing that money is available.
 */
function providerBudgetRemaining(): number {
	const configured = Number(process.env.SELENA_PROVIDER_BUDGET_USD ?? 0);
	return Number.isFinite(configured) && configured > 0 ? configured : 0;
}

async function collectPreflight(context: SelenaRepositoryContext, orderId: string): Promise<PreflightEvaluation> {
	const order = await getOwnedOrder(context, orderId);
	const [lock] = await db
		.select()
		.from(svConfigurationLocks)
		.where(and(eq(svConfigurationLocks.id, order.lockId), eq(svConfigurationLocks.organizationId, context.tenantId)))
		.limit(1);
	const [quote] = await db
		.select({ currency: svQuotes.currency })
		.from(svQuotes)
		.where(and(eq(svQuotes.id, order.quoteId), eq(svQuotes.organizationId, context.tenantId)))
		.limit(1);
	// A snapshot whose scope block is corrupt throws; for preflight that is a
	// missing scope, reported as a blocker rather than a crashed panel.
	let scope: ReturnType<typeof parseMeasurementScope> = null;
	if (lock) {
		try {
			scope = parseMeasurementScope(lock.snapshot);
		} catch {
			scope = null;
		}
	}
	const cycleIds = (
		await db
			.select({ id: svCycles.id })
			.from(svCycles)
			.where(and(eq(svCycles.orderId, orderId), eq(svCycles.organizationId, context.tenantId)))
	).map((cycle) => cycle.id);
	const [permitCount, jobCount, payment] = await Promise.all([
		cycleIds.length === 0
			? Promise.resolve([{ count: 0 }])
			: db
					.select({ count: sql<number>`count(*)::int` })
					.from(svRunPermits)
					.where(
						and(
							inArray(svRunPermits.cycleId, cycleIds),
							eq(svRunPermits.organizationId, context.tenantId),
							isNull(svRunPermits.consumedAt),
						),
					),
		cycleIds.length === 0
			? Promise.resolve([{ count: 0 }])
			: db
					.select({ count: sql<number>`count(*)::int` })
					.from(svRuns)
					.where(
						and(
							inArray(svRuns.cycleId, cycleIds),
							eq(svRuns.organizationId, context.tenantId),
							isNull(svRuns.finishedAt),
						),
					),
		db
			.select({ id: svPayments.id })
			.from(svPayments)
			.where(
				and(
					eq(svPayments.orderId, orderId),
					eq(svPayments.organizationId, context.tenantId),
					eq(svPayments.status, "SUCCEEDED"),
				),
			)
			.limit(1),
	]);
	return evaluatePreflight({
		orderId,
		orderStatus: order.status,
		lockPresent: Boolean(lock),
		scope,
		lockExpectedRuns: lock?.expectedRuns ?? 0,
		activePermits: permitCount[0]?.count ?? 0,
		activeJobs: jobCount[0]?.count ?? 0,
		maintenanceActive: isMaintenanceEnabled(process.env.SCHEDULE_MAINTENANCE_ENABLED),
		providerBudgetRemaining: providerBudgetRemaining(),
		orderCap: Number(order.orderCap),
		// The lock's committed budget cap is the configuration's worst case: it
		// is the most this order may ever cost under the locked scope.
		worstCaseCost: Number(lock?.budgetCap ?? Number.NaN),
		paymentRecorded: Boolean(payment[0]),
		currency: quote?.currency,
	});
}

/** Lets the route answer a non-admin with the same 404 the rest of /admin gives. */
export const getSelenaAdminAccessFn = createServerFn({ method: "GET" }).handler(async () => {
	const session = await requireAuthSession();
	return { isAdmin: isAdmin(session) };
});

export const getSelenaAdminOrderQueueFn = createServerFn({ method: "GET" }).handler(async () => {
	const context = await requireAdminContext();
	const orders = await db
		.select({
			id: svOrders.id,
			status: svOrders.status,
			orderCap: svOrders.orderCap,
			paidAt: svOrders.paidAt,
			createdAt: svOrders.createdAt,
			updatedAt: svOrders.updatedAt,
			projectId: svOrders.projectId,
			projectName: svProjects.name,
			currency: svQuotes.currency,
			lockVersion: svConfigurationLocks.version,
			lockExpectedRuns: svConfigurationLocks.expectedRuns,
			lockBudgetCap: svConfigurationLocks.budgetCap,
		})
		.from(svOrders)
		.innerJoin(svProjects, eq(svOrders.projectId, svProjects.id))
		.innerJoin(svQuotes, eq(svOrders.quoteId, svQuotes.id))
		.innerJoin(svConfigurationLocks, eq(svOrders.lockId, svConfigurationLocks.id))
		.where(and(eq(svOrders.organizationId, context.tenantId), inArray(svOrders.status, [...adminQueueStatuses])))
		.orderBy(desc(svOrders.updatedAt));
	return Promise.all(
		orders.map(async (order) => {
			const [cycles, qc] = await Promise.all([
				db
					.select({
						id: svCycles.id,
						status: svCycles.status,
						expectedRuns: svCycles.expectedRuns,
						createdRuns: svCycles.createdRuns,
						completedRuns: svCycles.completedRuns,
					})
					.from(svCycles)
					.where(and(eq(svCycles.orderId, order.id), eq(svCycles.organizationId, context.tenantId)))
					.orderBy(desc(svCycles.createdAt)),
				db
					.select({
						id: svQcRecords.id,
						reviewer: svQcRecords.reviewer,
						decision: svQcRecords.decision,
						scope: svQcRecords.scope,
						notes: svQcRecords.notes,
						reviewedAt: svQcRecords.reviewedAt,
					})
					.from(svQcRecords)
					.where(and(eq(svQcRecords.orderId, order.id), eq(svQcRecords.organizationId, context.tenantId)))
					.orderBy(desc(svQcRecords.createdAt))
					.limit(1),
			]);
			return { ...order, cycles, latestQc: qc[0] ?? null };
		}),
	);
});

export const getSelenaOrderPreflightFn = createServerFn({ method: "GET" })
	.validator(orderIdSchema)
	.handler(async ({ data }) => {
		const context = await requireAdminContext();
		return collectPreflight(context, data.orderId);
	});

export const approveSelenaOrderFn = createServerFn({ method: "POST" })
	.validator(orderIdSchema.extend({ idempotencyKey: z.string().min(1).max(200).optional() }))
	.handler(async ({ data }) => {
		const context = await requireAdminContext();
		if (data.idempotencyKey) {
			const prior = await findPriorAudit(context, "ORDER_APPROVED", data.orderId, data.idempotencyKey);
			if (prior) {
				const order = await getOwnedOrder(context, data.orderId);
				const details = prior.details as Record<string, unknown>;
				return {
					orderId: data.orderId,
					status: order.status,
					cycleId: (details.cycleId as string | undefined) ?? null,
					created: (details.created as number | undefined) ?? 0,
					expected: (details.expected as number | undefined) ?? 0,
					replay: true,
				};
			}
		}
		const preflight = await collectPreflight(context, data.orderId);
		// Approval never runs past a blocker: the same evaluation the operator
		// saw is recomputed here and decides.
		assertApprovable(preflight);
		const [approved] = await db
			.update(svOrders)
			.set({ status: "APPROVED", updatedAt: new Date() })
			.where(
				and(
					eq(svOrders.id, data.orderId),
					eq(svOrders.organizationId, context.tenantId),
					eq(svOrders.status, "PAID_REVIEW_REQUIRED"),
				),
			)
			.returning({ id: svOrders.id });
		if (!approved) throw new Error("SELENA_ORDER_STATUS_CHANGED");
		const dispatch = await repositories.dispatch.createPermits(context, data.orderId);
		await recordAdminAudit(context, "ORDER_APPROVED", data.orderId, {
			cycleId: dispatch.cycleId,
			created: dispatch.created,
			expected: dispatch.expected,
			idempotencyKey: data.idempotencyKey ?? null,
		});
		const order = await getOwnedOrder(context, data.orderId);
		return {
			orderId: data.orderId,
			status: order.status,
			cycleId: dispatch.cycleId,
			created: dispatch.created,
			expected: dispatch.expected,
			replay: false,
		};
	});

export const enqueueSelenaOrderRunsFn = createServerFn({ method: "POST" })
	.validator(orderIdSchema.extend({ idempotencyKey: z.string().min(1).max(200).optional() }))
	.handler(async ({ data }) => {
		const context = await requireAdminContext();
		if (data.idempotencyKey) {
			const prior = await findPriorAudit(context, "RUNS_ENQUEUED", data.orderId, data.idempotencyKey);
			if (prior) {
				const details = prior.details as Record<string, unknown>;
				return {
					orderId: data.orderId,
					enqueued: (details.enqueued as number | undefined) ?? 0,
					skipped: (details.skipped as number | undefined) ?? 0,
					duplicates: (details.duplicates as number | undefined) ?? 0,
					reason: null,
					replay: true,
				};
			}
		}
		const order = await getOwnedOrder(context, data.orderId);
		// QUEUED is the state approval leaves an order in: permits exist and none
		// of them has been handed to the queue yet.
		if (order.status !== "QUEUED") throw new Error("SELENA_ORDER_NOT_QUEUED");
		const permits = await repositories.dispatch.listPermits(context, data.orderId);
		const config = measurementConfigFromEnv(process.env);
		const result = await enqueueOrderRuns({
			permits,
			config,
			organizationId: context.tenantId,
			actorId: context.actorId,
			now: new Date(),
			send: async (payload, options) => {
				const boss = await getBoss();
				return boss.send("selena-measure", payload, { singletonKey: options.singletonKey });
			},
		});
		await recordAdminAudit(context, "RUNS_ENQUEUED", data.orderId, {
			orderId: data.orderId,
			enqueued: result.enqueued,
			skipped: result.skipped,
			duplicates: result.duplicates,
			reason: result.reason,
			// A refused enqueue is deliberately not replayable: once the owner
			// turns execution on, the same key must still be able to queue the run.
			idempotencyKey: result.reason === null ? (data.idempotencyKey ?? null) : null,
		});
		return { orderId: data.orderId, ...result, replay: false };
	});

export const stopSelenaOrderFn = createServerFn({ method: "POST" })
	.validator(
		orderIdSchema.extend({
			reason: z.string().trim().max(500).optional(),
			idempotencyKey: z.string().min(1).max(200).optional(),
		}),
	)
	.handler(async ({ data }) => {
		const context = await requireAdminContext();
		const order = await getOwnedOrder(context, data.orderId);
		if (data.idempotencyKey) {
			const prior = await findPriorAudit(context, "ORDER_STOPPED", data.orderId, data.idempotencyKey);
			if (prior) return { orderId: data.orderId, status: order.status, stoppedCycles: 0, replay: true };
		}
		// The order status enum has no STOPPED member; a stopped order is a
		// cancelled one, while the cycle it owns carries the STOPPED state.
		if (order.status === "CANCELLED")
			return { orderId: data.orderId, status: order.status, stoppedCycles: 0, replay: true };
		await db
			.update(svOrders)
			.set({ status: "CANCELLED", updatedAt: new Date() })
			.where(and(eq(svOrders.id, data.orderId), eq(svOrders.organizationId, context.tenantId)));
		const stopped = await db
			.update(svCycles)
			.set({ status: "STOPPED", updatedAt: new Date() })
			.where(
				and(
					eq(svCycles.orderId, data.orderId),
					eq(svCycles.organizationId, context.tenantId),
					inArray(svCycles.status, ["CREATED", "APPROVED", "QUEUED", "RUNNING", "ANALYZING", "QC_REQUIRED"]),
				),
			)
			.returning({ id: svCycles.id });
		await recordAdminAudit(context, "ORDER_STOPPED", data.orderId, {
			previousStatus: order.status,
			stoppedCycles: stopped.length,
			reason: data.reason ?? null,
			idempotencyKey: data.idempotencyKey ?? null,
		});
		return { orderId: data.orderId, status: "CANCELLED" as const, stoppedCycles: stopped.length, replay: false };
	});

export const recordSelenaQcFn = createServerFn({ method: "POST" })
	.validator(
		orderIdSchema.extend({
			cycleId: z.string().uuid().optional(),
			reviewer: z.string().trim().min(1).max(200).optional(),
			reviewedAt: z.string().datetime().optional(),
			scope: z.string().trim().min(1).max(500),
			decision: z.enum(qcDecisions),
			notes: z.string().trim().max(2000).optional(),
		}),
	)
	.handler(async ({ data }) => {
		const context = await requireAdminContext();
		return repositories.qcRecords.create(context, {
			orderId: data.orderId,
			cycleId: data.cycleId ?? null,
			reviewer: data.reviewer,
			reviewedAt: data.reviewedAt ?? new Date(),
			scope: data.scope,
			decision: data.decision,
			notes: data.notes ?? null,
		});
	});

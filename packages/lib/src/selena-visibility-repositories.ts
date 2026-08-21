import {
	type ObservationReviewDecision,
	type OrderingState,
	type RunOutcome,
	assertCardinality,
	assertMentionMatch,
	assertObservationCardinality,
	assertObservationSubmission,
	contextHash,
	expectedObservations,
	localAiDiscoveryLockBlockSchema,
	observationReviewDecisions,
	observerContextSchema,
	parseMeasurementScope,
	resolveExplicitPosition,
	runOutcomeSchema,
} from "@workspace/selena-visibility-contracts";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./db/schema";
import { type ControlledCycleState, assertDirectDispatchAllowed } from "./run-policy";
import { assertLockExpectedRuns, assertQcDecision, planOrderDispatch } from "./selena-dispatch";
import { detectEntityCycle, validateEntityParent } from "./selena-entities";
import { observationContentSha256, planCaptureTasks } from "./selena-manual-pilot";

export type SelenaRepositoryContext = {
	actorId: string;
	tenantId: string;
	role: "owner" | "member" | "viewer";
	authType: "session" | "api_key";
	permissions: string[];
};

type Db = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbLike = Db | Tx;
function writable(ctx: SelenaRepositoryContext) {
	if (ctx.role === "viewer") throw new Error("Forbidden: viewer is read-only");
	if (ctx.authType === "api_key" && !ctx.permissions.includes("client:write"))
		throw new Error("Forbidden: API key lacks client:write permission");
}

export function createSelenaRepositories(db: Db) {
	const assertProjectOwned = async (ctx: SelenaRepositoryContext, projectId: string) => {
		const [project] = await db
			.select({ id: schema.svProjects.id })
			.from(schema.svProjects)
			.where(and(eq(schema.svProjects.id, projectId), eq(schema.svProjects.organizationId, ctx.tenantId)))
			.limit(1);
		if (!project) throw new Error("Not found: project is outside AuthContext tenant");
	};
	const assertLockOwned = async (ctx: SelenaRepositoryContext, lockId: string) => {
		const [lock] = await db
			.select({ id: schema.svConfigurationLocks.id })
			.from(schema.svConfigurationLocks)
			.where(
				and(eq(schema.svConfigurationLocks.id, lockId), eq(schema.svConfigurationLocks.organizationId, ctx.tenantId)),
			)
			.limit(1);
		if (!lock) throw new Error("Not found: configuration lock is outside AuthContext tenant");
	};
	const assertQuoteOwned = async (ctx: SelenaRepositoryContext, quoteId: string) => {
		const [quote] = await db
			.select({ id: schema.svQuotes.id })
			.from(schema.svQuotes)
			.where(and(eq(schema.svQuotes.id, quoteId), eq(schema.svQuotes.organizationId, ctx.tenantId)))
			.limit(1);
		if (!quote) throw new Error("Not found: quote is outside AuthContext tenant");
	};
	const assertOrderOwned = async (ctx: SelenaRepositoryContext, orderId: string) => {
		const [order] = await db
			.select({ id: schema.svOrders.id })
			.from(schema.svOrders)
			.where(and(eq(schema.svOrders.id, orderId), eq(schema.svOrders.organizationId, ctx.tenantId)))
			.limit(1);
		if (!order) throw new Error("Not found: order is outside AuthContext tenant");
	};
	const getOrderOwned = async (ctx: SelenaRepositoryContext, orderId: string) => {
		const [order] = await db
			.select()
			.from(schema.svOrders)
			.where(and(eq(schema.svOrders.id, orderId), eq(schema.svOrders.organizationId, ctx.tenantId)))
			.limit(1);
		if (!order) throw new Error("Not found: order is outside AuthContext tenant");
		return order;
	};
	const getLockOwned = async (ctx: SelenaRepositoryContext, lockId: string) => {
		const [lock] = await db
			.select()
			.from(schema.svConfigurationLocks)
			.where(
				and(eq(schema.svConfigurationLocks.id, lockId), eq(schema.svConfigurationLocks.organizationId, ctx.tenantId)),
			)
			.limit(1);
		if (!lock) throw new Error("Not found: configuration lock is outside AuthContext tenant");
		return lock;
	};
	const latestQcRecordForOrder = async (ctx: SelenaRepositoryContext, orderId: string) =>
		(
			await db
				.select()
				.from(schema.svQcRecords)
				.where(and(eq(schema.svQcRecords.orderId, orderId), eq(schema.svQcRecords.organizationId, ctx.tenantId)))
				.orderBy(desc(schema.svQcRecords.createdAt))
				.limit(1)
		)[0];
	// Every manual-pilot mutation leaves an audit row; on transactional paths
	// the row commits or rolls back together with the mutation it describes.
	const recordAudit = async (
		runner: DbLike,
		ctx: SelenaRepositoryContext,
		event: string,
		subjectKind: string,
		subjectId: string,
		details: Record<string, unknown> = {},
	) => {
		await runner
			.insert(schema.svAuditEvents)
			.values({ organizationId: ctx.tenantId, actorId: ctx.actorId, event, subjectKind, subjectId, details });
	};
	const lockBlockFor = async (ctx: SelenaRepositoryContext, lockId: string) => {
		const [lock] = await db
			.select()
			.from(schema.svConfigurationLocks)
			.where(
				and(eq(schema.svConfigurationLocks.id, lockId), eq(schema.svConfigurationLocks.organizationId, ctx.tenantId)),
			)
			.limit(1);
		if (!lock) throw new Error("Not found: configuration lock is outside AuthContext tenant");
		const parsed = localAiDiscoveryLockBlockSchema.safeParse(
			(lock.snapshot as Record<string, unknown> | null)?.localAiDiscovery,
		);
		if (!parsed.success) throw new Error("LOCK_LOCAL_AI_DISCOVERY_BLOCK_MISSING");
		return { lock, block: parsed.data };
	};
	const getPilotCycleOwned = async (ctx: SelenaRepositoryContext, pilotCycleId: string) => {
		const [cycle] = await db
			.select()
			.from(schema.svPilotCycles)
			.where(and(eq(schema.svPilotCycles.id, pilotCycleId), eq(schema.svPilotCycles.organizationId, ctx.tenantId)))
			.limit(1);
		if (!cycle) throw new Error("Not found: pilot cycle is outside AuthContext tenant");
		return cycle;
	};
	const getObservationOwned = async (ctx: SelenaRepositoryContext, observationId: string) => {
		const [observation] = await db
			.select()
			.from(schema.svLocalObservations)
			.where(
				and(
					eq(schema.svLocalObservations.id, observationId),
					eq(schema.svLocalObservations.organizationId, ctx.tenantId),
				),
			)
			.limit(1);
		if (!observation) throw new Error("Not found: observation is outside AuthContext tenant");
		return observation;
	};
	return {
		projects: {
			list: (ctx: SelenaRepositoryContext) =>
				db
					.select()
					.from(schema.svProjects)
					.where(eq(schema.svProjects.organizationId, ctx.tenantId))
					.orderBy(desc(schema.svProjects.createdAt)),
			get: async (ctx: SelenaRepositoryContext, id: string) =>
				(
					await db
						.select()
						.from(schema.svProjects)
						.where(and(eq(schema.svProjects.id, id), eq(schema.svProjects.organizationId, ctx.tenantId)))
						.limit(1)
				)[0],
			create: async (
				ctx: SelenaRepositoryContext,
				value: Omit<typeof schema.svProjects.$inferInsert, "organizationId">,
			) => {
				writable(ctx);
				return (
					await db
						.insert(schema.svProjects)
						.values({ ...value, organizationId: ctx.tenantId })
						.returning()
				)[0];
			},
		},
		locks: {
			create: async (
				ctx: SelenaRepositoryContext,
				value: Omit<typeof schema.svConfigurationLocks.$inferInsert, "organizationId" | "createdBy">,
			) => {
				writable(ctx);
				await assertProjectOwned(ctx, value.projectId);
				return (
					await db
						.insert(schema.svConfigurationLocks)
						.values({ ...value, organizationId: ctx.tenantId, createdBy: ctx.actorId })
						.returning()
				)[0];
			},
			list: (ctx: SelenaRepositoryContext, projectId: string) =>
				db
					.select()
					.from(schema.svConfigurationLocks)
					.where(
						and(
							eq(schema.svConfigurationLocks.projectId, projectId),
							eq(schema.svConfigurationLocks.organizationId, ctx.tenantId),
						),
					),
		},
		quotes: {
			create: async (
				ctx: SelenaRepositoryContext,
				value: Omit<typeof schema.svQuotes.$inferInsert, "organizationId">,
			) => {
				writable(ctx);
				await assertProjectOwned(ctx, value.projectId);
				await assertLockOwned(ctx, value.lockId);
				return (
					await db
						.insert(schema.svQuotes)
						.values({ ...value, organizationId: ctx.tenantId })
						.returning()
				)[0];
			},
			list: (ctx: SelenaRepositoryContext, projectId: string) =>
				db
					.select()
					.from(schema.svQuotes)
					.where(and(eq(schema.svQuotes.projectId, projectId), eq(schema.svQuotes.organizationId, ctx.tenantId))),
		},
		orders: {
			create: async (
				ctx: SelenaRepositoryContext,
				value: Omit<typeof schema.svOrders.$inferInsert, "organizationId">,
			) => {
				writable(ctx);
				await assertProjectOwned(ctx, value.projectId);
				await assertLockOwned(ctx, value.lockId);
				await assertQuoteOwned(ctx, value.quoteId);
				return (
					await db
						.insert(schema.svOrders)
						.values({ ...value, organizationId: ctx.tenantId })
						.returning()
				)[0];
			},
			list: (ctx: SelenaRepositoryContext) =>
				db.select().from(schema.svOrders).where(eq(schema.svOrders.organizationId, ctx.tenantId)),
		},
		profiles: {
			get: async (ctx: SelenaRepositoryContext, projectId: string) =>
				(
					await db
						.select()
						.from(schema.svProjectProfiles)
						.where(
							and(
								eq(schema.svProjectProfiles.projectId, projectId),
								eq(schema.svProjectProfiles.organizationId, ctx.tenantId),
							),
						)
						.limit(1)
				)[0],
			confirm: async (
				ctx: SelenaRepositoryContext,
				value: Omit<typeof schema.svProjectProfiles.$inferInsert, "organizationId" | "confirmedAt" | "confirmedBy">,
			) => {
				writable(ctx);
				await assertProjectOwned(ctx, value.projectId);
				const [profile] = await db
					.insert(schema.svProjectProfiles)
					.values({ ...value, organizationId: ctx.tenantId, confirmedAt: new Date(), confirmedBy: ctx.actorId })
					.onConflictDoUpdate({
						target: schema.svProjectProfiles.projectId,
						set: {
							...value,
							organizationId: ctx.tenantId,
							confirmedAt: new Date(),
							confirmedBy: ctx.actorId,
							updatedAt: new Date(),
						},
					})
					.returning();
				if (!profile) throw new Error("Unable to confirm project profile");
				return profile;
			},
		},
		families: {
			list: (ctx: SelenaRepositoryContext, projectId: string) =>
				db
					.select()
					.from(schema.svPromptFamilies)
					.where(
						and(
							eq(schema.svPromptFamilies.projectId, projectId),
							eq(schema.svPromptFamilies.organizationId, ctx.tenantId),
						),
					),
			create: async (
				ctx: SelenaRepositoryContext,
				value: Omit<typeof schema.svPromptFamilies.$inferInsert, "organizationId">,
			) => {
				writable(ctx);
				await assertProjectOwned(ctx, value.projectId);
				return (
					await db
						.insert(schema.svPromptFamilies)
						.values({ ...value, organizationId: ctx.tenantId })
						.returning()
				)[0];
			},
		},
		scenarios: {
			list: (ctx: SelenaRepositoryContext, familyId: string) =>
				db
					.select()
					.from(schema.svScenarios)
					.where(and(eq(schema.svScenarios.familyId, familyId), eq(schema.svScenarios.organizationId, ctx.tenantId))),
			create: async (
				ctx: SelenaRepositoryContext,
				value: Omit<typeof schema.svScenarios.$inferInsert, "organizationId">,
			) => {
				writable(ctx);
				const [family] = await db
					.select({ id: schema.svPromptFamilies.id })
					.from(schema.svPromptFamilies)
					.where(
						and(
							eq(schema.svPromptFamilies.id, value.familyId),
							eq(schema.svPromptFamilies.organizationId, ctx.tenantId),
						),
					)
					.limit(1);
				if (!family) throw new Error("Not found: prompt family is outside AuthContext tenant");
				return (
					await db
						.insert(schema.svScenarios)
						.values({ ...value, organizationId: ctx.tenantId })
						.returning()
				)[0];
			},
		},
		entities: {
			list: (ctx: SelenaRepositoryContext, projectId: string) =>
				db
					.select()
					.from(schema.svEntities)
					.where(and(eq(schema.svEntities.projectId, projectId), eq(schema.svEntities.organizationId, ctx.tenantId)))
					.orderBy(desc(schema.svEntities.createdAt)),
			create: async (
				ctx: SelenaRepositoryContext,
				value: Omit<typeof schema.svEntities.$inferInsert, "organizationId">,
			) => {
				writable(ctx);
				await assertProjectOwned(ctx, value.projectId);
				const parent = value.parentEntityId
					? (
							await db
								.select({
									id: schema.svEntities.id,
									organizationId: schema.svEntities.organizationId,
									projectId: schema.svEntities.projectId,
								})
								.from(schema.svEntities)
								.where(eq(schema.svEntities.id, value.parentEntityId))
								.limit(1)
						)[0]
					: undefined;
				validateEntityParent({ ...value, organizationId: ctx.tenantId }, parent);
				if (value.parentEntityId) {
					const siblings = await db
						.select({ id: schema.svEntities.id, parentEntityId: schema.svEntities.parentEntityId })
						.from(schema.svEntities)
						.where(
							and(eq(schema.svEntities.projectId, value.projectId), eq(schema.svEntities.organizationId, ctx.tenantId)),
						);
					detectEntityCycle(siblings, {
						id: value.id ?? globalThis.crypto.randomUUID(),
						parentEntityId: value.parentEntityId,
					});
				}
				return (
					await db
						.insert(schema.svEntities)
						.values({ ...value, organizationId: ctx.tenantId })
						.returning()
				)[0];
			},
			setConfirmation: async (
				ctx: SelenaRepositoryContext,
				entityId: string,
				status: (typeof schema.svEntityConfirmationEnum.enumValues)[number],
			) => {
				writable(ctx);
				const [entity] = await db
					.update(schema.svEntities)
					.set({ confirmationStatus: status, updatedAt: new Date() })
					.where(and(eq(schema.svEntities.id, entityId), eq(schema.svEntities.organizationId, ctx.tenantId)))
					.returning();
				if (!entity) throw new Error("Not found: entity is outside AuthContext tenant");
				return entity;
			},
		},
		locations: {
			list: (ctx: SelenaRepositoryContext, entityId: string) =>
				db
					.select()
					.from(schema.svBusinessLocations)
					.where(
						and(
							eq(schema.svBusinessLocations.entityId, entityId),
							eq(schema.svBusinessLocations.organizationId, ctx.tenantId),
						),
					),
			create: async (
				ctx: SelenaRepositoryContext,
				value: Omit<typeof schema.svBusinessLocations.$inferInsert, "organizationId">,
			) => {
				writable(ctx);
				const [entity] = await db
					.select({ id: schema.svEntities.id })
					.from(schema.svEntities)
					.where(and(eq(schema.svEntities.id, value.entityId), eq(schema.svEntities.organizationId, ctx.tenantId)))
					.limit(1);
				if (!entity) throw new Error("Not found: entity is outside AuthContext tenant");
				return (
					await db
						.insert(schema.svBusinessLocations)
						.values({ ...value, organizationId: ctx.tenantId })
						.returning()
				)[0];
			},
		},
		cycles: {
			list: (ctx: SelenaRepositoryContext, orderId: string) =>
				db
					.select()
					.from(schema.svCycles)
					.where(and(eq(schema.svCycles.orderId, orderId), eq(schema.svCycles.organizationId, ctx.tenantId))),
			create: async (
				ctx: SelenaRepositoryContext,
				value: Omit<typeof schema.svCycles.$inferInsert, "organizationId">,
			) => {
				writable(ctx);
				await assertOrderOwned(ctx, value.orderId);
				await assertLockOwned(ctx, value.lockId);
				return (
					await db
						.insert(schema.svCycles)
						.values({ ...value, organizationId: ctx.tenantId })
						.returning()
				)[0];
			},
		},
		// Order dispatch mints run permits: permission records that a later,
		// separate executor may consume. Nothing here touches consumedAt, an
		// adapter, a queue, or the network — planning an order can never run it.
		dispatch: {
			listPermits: async (ctx: SelenaRepositoryContext, orderId: string) => {
				await assertOrderOwned(ctx, orderId);
				const cycleIds = (
					await db
						.select({ id: schema.svCycles.id })
						.from(schema.svCycles)
						.where(and(eq(schema.svCycles.orderId, orderId), eq(schema.svCycles.organizationId, ctx.tenantId)))
				).map((cycle) => cycle.id);
				if (cycleIds.length === 0) return [];
				return db
					.select()
					.from(schema.svRunPermits)
					.where(
						and(inArray(schema.svRunPermits.cycleId, cycleIds), eq(schema.svRunPermits.organizationId, ctx.tenantId)),
					);
			},
			createPermits: async (
				ctx: SelenaRepositoryContext,
				orderId: string,
				opts?: {
					// Injectable so tests can exercise emergency-stop/maintenance gates;
					// the default state is the safe one (no stop, no maintenance).
					cycleState?: Partial<Omit<ControlledCycleState, "cohortId" | "expectedJobs" | "expectedProviderCalls">>;
					expiresAt?: Date;
				},
			) => {
				writable(ctx);
				const order = await getOrderOwned(ctx, orderId);
				// QUEUED is accepted only as the replay of a dispatch that already
				// succeeded; every other non-APPROVED status must not mint permits.
				if (order.status !== "APPROVED" && order.status !== "QUEUED") throw new Error("SELENA_ORDER_NOT_APPROVED");
				const lock = await getLockOwned(ctx, order.lockId);
				const scope = parseMeasurementScope(lock.snapshot);
				if (!scope) throw new Error("SELENA_LOCK_SCOPE_MISSING");
				const expected = assertLockExpectedRuns(scope, lock.expectedRuns);
				const state: ControlledCycleState = {
					activeMaintenanceJobs: 0,
					activeCohortJobs: 0,
					cohortId: orderId,
					expectedJobs: expected,
					// Zero by construction: permit minting performs no provider calls.
					expectedProviderCalls: 0,
					seenCohortIds: new Set<string>(),
					globalEmergencyStop: false,
					orderStopped: false,
					...opts?.cycleState,
				};
				assertDirectDispatchAllowed(state);
				const planned = planOrderDispatch({ orderId, lockVersion: lock.version, scope });
				// Unconsumed permission must lapse on its own rather than linger as a
				// standing authorization; one day comfortably covers a QUEUED order.
				const expiresAt = opts?.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000);
				const recordOverflow = async (detail: string) => {
					// §9.2: the transaction that hit the boundary rolls back, so the
					// incident is written outside it — the overflow must survive the
					// rollback that contained it.
					await db.insert(schema.svIncidents).values({
						organizationId: ctx.tenantId,
						orderId,
						kind: "CARDINALITY_OVERFLOW",
						detail,
					});
				};
				try {
					return await db.transaction(async (tx) => {
						const [existingCycle] = await tx
							.select()
							.from(schema.svCycles)
							.where(
								and(
									eq(schema.svCycles.orderId, orderId),
									eq(schema.svCycles.lockId, order.lockId),
									eq(schema.svCycles.organizationId, ctx.tenantId),
								),
							)
							.orderBy(desc(schema.svCycles.createdAt))
							.limit(1);
						const cycle =
							existingCycle ??
							(
								await tx
									.insert(schema.svCycles)
									.values({
										organizationId: ctx.tenantId,
										orderId,
										lockId: order.lockId,
										status: "QUEUED",
										expectedRuns: expected,
									})
									.returning()
							)[0];
						// The dispatch-key unique index makes replays idempotent: a second
						// call inserts nothing and can never mint a duplicate permit.
						const inserted = await tx
							.insert(schema.svRunPermits)
							.values(
								planned.map((permit) => ({
									organizationId: ctx.tenantId,
									cycleId: cycle.id,
									dispatchKey: permit.dispatchKey,
									channel: permit.channel,
									scenarioId: permit.scenarioId,
									// P0-07: the sold system is fixed at planning time so every
									// run can be sliced by engine even when extraction never ran.
									systemId: permit.systemId,
									expiresAt,
								})),
							)
							.onConflictDoNothing({ target: schema.svRunPermits.dispatchKey })
							.returning();
						const permits = await tx
							.select()
							.from(schema.svRunPermits)
							.where(
								and(eq(schema.svRunPermits.cycleId, cycle.id), eq(schema.svRunPermits.organizationId, ctx.tenantId)),
							);
						// assertCardinality blocks minting "one more" at its boundary; the
						// complete permit set legitimately sits at exactly expectedRuns, so
						// the overflow boundary for the stored total is expected + 1. An
						// undercount means planned keys were claimed by another cycle.
						assertCardinality(permits.length, expected + 1);
						if (permits.length !== expected) throw new Error("SELENA_PERMIT_CARDINALITY_MISMATCH");
						await tx
							.update(schema.svCycles)
							.set({ createdRuns: permits.length, updatedAt: new Date() })
							.where(eq(schema.svCycles.id, cycle.id));
						if (order.status === "APPROVED")
							await tx
								.update(schema.svOrders)
								.set({ status: "QUEUED", updatedAt: new Date() })
								.where(and(eq(schema.svOrders.id, orderId), eq(schema.svOrders.organizationId, ctx.tenantId)));
						await recordAudit(tx, ctx, "ORDER_DISPATCH_PLANNED", "sv_orders", orderId, {
							orderId,
							cycleId: cycle.id,
							created: inserted.length,
							expected,
						});
						return { cycleId: cycle.id, created: inserted.length, expected, permits };
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (
						message === "CARDINALITY_BLOCKED" ||
						message === "CARDINALITY_INVALID" ||
						message === "SELENA_PERMIT_CARDINALITY_MISMATCH"
					)
						await recordOverflow(message);
					throw error;
				}
			},
		},
		// Execution of a permit. Claiming spends the permission and opens a run
		// row; completing records the adapter's validated outcome. No provider
		// transport lives here — the adapter is injected in the executor.
		runs: {
			claim: async (ctx: SelenaRepositoryContext, permitId: string, opts?: { now?: Date }) => {
				writable(ctx);
				const now = opts?.now ?? new Date();
				return db.transaction(async (tx) => {
					const [permit] = await tx
						.select()
						.from(schema.svRunPermits)
						.where(and(eq(schema.svRunPermits.id, permitId), eq(schema.svRunPermits.organizationId, ctx.tenantId)))
						.for("update");
					if (!permit) throw new Error("Not found: run permit is outside AuthContext tenant");
					const [cycle] = await tx
						.select()
						.from(schema.svCycles)
						.where(and(eq(schema.svCycles.id, permit.cycleId), eq(schema.svCycles.organizationId, ctx.tenantId)))
						.limit(1);
					if (!cycle) throw new Error("Not found: cycle is outside AuthContext tenant");
					const runFor = async (dispatchKey: string) =>
						(
							await tx
								.select()
								.from(schema.svRuns)
								.where(and(eq(schema.svRuns.dispatchKey, dispatchKey), eq(schema.svRuns.organizationId, ctx.tenantId)))
								.limit(1)
						)[0];
					// A replay returns the run that already exists rather than failing,
					// and returns the permit as it stands — already consumed, which is
					// what stops the executor from spending it a second time.
					if (permit.consumedAt) {
						const existing = await runFor(permit.dispatchKey);
						if (!existing) throw new Error("SELENA_PERMIT_CONSUMED_WITHOUT_RUN");
						return { permit, run: existing, cycle, claimed: false };
					}
					await tx
						.update(schema.svRunPermits)
						.set({ consumedAt: now, status: "consumed" })
						.where(eq(schema.svRunPermits.id, permitId));
					await tx
						.insert(schema.svRuns)
						.values({
							organizationId: ctx.tenantId,
							cycleId: permit.cycleId,
							permitId: permit.id,
							dispatchKey: permit.dispatchKey,
							channel: permit.channel,
							scenarioId: permit.scenarioId,
							systemId: permit.systemId,
							status: "RUNNING",
							startedAt: now,
						})
						.onConflictDoNothing({ target: schema.svRuns.dispatchKey });
					const run = await runFor(permit.dispatchKey);
					if (!run) throw new Error("SELENA_RUN_CLAIM_FAILED");
					await recordAudit(tx, ctx, "RUN_CLAIMED", "sv_runs", run.id, {
						permitId,
						cycleId: permit.cycleId,
						dispatchKey: permit.dispatchKey,
					});
					// The permit object predates the consumedAt write above: the
					// executor re-checks this snapshot before an adapter may see it.
					return { permit, run, cycle, claimed: true };
				});
			},
			complete: async (ctx: SelenaRepositoryContext, runId: string, outcome: RunOutcome, opts?: { now?: Date }) => {
				writable(ctx);
				const parsed = runOutcomeSchema.parse(outcome);
				const now = opts?.now ?? new Date();
				return db.transaction(async (tx) => {
					const [run] = await tx
						.select()
						.from(schema.svRuns)
						.where(and(eq(schema.svRuns.id, runId), eq(schema.svRuns.organizationId, ctx.tenantId)))
						.for("update");
					if (!run) throw new Error("Not found: run is outside AuthContext tenant");
					if (run.dispatchKey !== parsed.dispatchKey) throw new Error("SELENA_DISPATCH_KEY_MISMATCH");
					// Terminal already: recording twice would double the cycle counter
					// and could push a cycle past its expected cardinality.
					if (run.finishedAt) return run;
					const measurement = parsed.measurement;
					const [completed] = await tx
						.update(schema.svRuns)
						.set({
							status: parsed.status,
							validity: parsed.validity,
							invalidReason: parsed.invalidReason ?? null,
							costUsd: parsed.costUsd === undefined ? null : String(parsed.costUsd),
							costBasis: parsed.costBasis ?? null,
							tokenInput: parsed.tokenUsage?.input ?? null,
							tokenOutput: parsed.tokenUsage?.output ?? null,
							system: measurement?.system ?? null,
							model: measurement?.model ?? null,
							language: measurement?.language ?? null,
							region: measurement?.region ?? null,
							mention: measurement?.mention ?? null,
							position: measurement?.position ?? null,
							ownedCitation: measurement?.ownedCitation ?? null,
							citations: measurement?.citations ?? null,
							competitors: measurement?.competitors ?? null,
							factualErrors: measurement?.factualErrors ?? null,
							rawResponseReference: parsed.rawResponseReference ?? null,
							canonicalPayload: parsed,
							finishedAt: now,
						})
						.where(eq(schema.svRuns.id, runId))
						.returning();
					const [cycle] = await tx
						.select()
						.from(schema.svCycles)
						.where(and(eq(schema.svCycles.id, run.cycleId), eq(schema.svCycles.organizationId, ctx.tenantId)))
						.for("update");
					if (!cycle) throw new Error("Not found: cycle is outside AuthContext tenant");
					// Failed and invalid runs count as finished: they are terminal, and
					// a cycle that never reaches its expected count never reaches QC.
					const completedRuns = cycle.completedRuns + 1;
					const cycleDone = completedRuns >= cycle.expectedRuns;
					await tx
						.update(schema.svCycles)
						.set({
							completedRuns,
							status: cycleDone ? "QC_REQUIRED" : "RUNNING",
							updatedAt: new Date(),
						})
						.where(eq(schema.svCycles.id, cycle.id));
					if (cycleDone)
						// Human QC is the only exit from a finished cycle; the order is
						// moved only from states that are still mid-flight, so a
						// cancelled or already delivered order is never revived.
						await tx
							.update(schema.svOrders)
							.set({ status: "QC_REQUIRED", updatedAt: new Date() })
							.where(
								and(
									eq(schema.svOrders.id, cycle.orderId),
									eq(schema.svOrders.organizationId, ctx.tenantId),
									inArray(schema.svOrders.status, ["QUEUED", "RUNNING", "ANALYZING"]),
								),
							);
					// The spend ledger is written with the run it belongs to, so a
					// committed charge can never exist without its evidence row and
					// vice versa.
					if (parsed.costUsd !== undefined)
						await tx.insert(schema.svCostEvents).values({
							organizationId: ctx.tenantId,
							cycleId: cycle.id,
							runId,
							// The billing transport, stable across extraction success: ledger
							// rows must group by who charged, not by what was measured.
							provider: parsed.provider ?? run.channel,
							amountUsd: String(parsed.costUsd),
							basis: parsed.costBasis ?? "estimated",
						});
					// §9.2: a run halted by a stop guard is an incident, not just a
					// FAILED row — the stop itself must be visible after the fact.
					if (
						parsed.invalidReason === "SELENA_GLOBAL_EMERGENCY_STOP" ||
						parsed.invalidReason === "SELENA_ORDER_STOPPED"
					)
						await tx.insert(schema.svIncidents).values({
							organizationId: ctx.tenantId,
							orderId: cycle.orderId,
							cycleId: cycle.id,
							kind: "EMERGENCY_STOP",
							detail: parsed.invalidReason,
							dispatchKey: parsed.dispatchKey,
						});
					await recordAudit(tx, ctx, "RUN_COMPLETED", "sv_runs", runId, {
						cycleId: cycle.id,
						dispatchKey: parsed.dispatchKey,
						status: parsed.status,
						validity: parsed.validity,
						completedRuns,
						expectedRuns: cycle.expectedRuns,
					});
					return completed;
				});
			},
		},
		incidents: {
			list: (ctx: SelenaRepositoryContext, opts?: { status?: "OPEN" | "RESOLVED" }) =>
				db
					.select()
					.from(schema.svIncidents)
					.where(
						and(
							eq(schema.svIncidents.organizationId, ctx.tenantId),
							...(opts?.status ? [eq(schema.svIncidents.status, opts.status)] : []),
						),
					)
					.orderBy(desc(schema.svIncidents.createdAt)),
			resolve: async (ctx: SelenaRepositoryContext, incidentId: string, opts?: { now?: Date }) => {
				writable(ctx);
				const now = opts?.now ?? new Date();
				const [resolved] = await db
					.update(schema.svIncidents)
					.set({ status: "RESOLVED", resolvedAt: now })
					.where(and(eq(schema.svIncidents.id, incidentId), eq(schema.svIncidents.organizationId, ctx.tenantId)))
					.returning();
				if (!resolved) throw new Error("Not found: incident is outside AuthContext tenant");
				await recordAudit(db, ctx, "INCIDENT_RESOLVED", "sv_incidents", incidentId, { kind: resolved.kind });
				return resolved;
			},
		},
		// Read-only on purpose: the ledger is appended where the charge happens
		// (run completion) and nowhere else.
		costEvents: {
			listForCycle: (ctx: SelenaRepositoryContext, cycleId: string) =>
				db
					.select()
					.from(schema.svCostEvents)
					.where(and(eq(schema.svCostEvents.cycleId, cycleId), eq(schema.svCostEvents.organizationId, ctx.tenantId)))
					.orderBy(desc(schema.svCostEvents.createdAt)),
		},
		// RC7 Phase E — manual pilot. These writers are the only path into the
		// sv_pilot_* / sv_local_observations tables and never touch background
		// job queues, sv_run_permits, sv_runs, or usage accounting: capture
		// happens off-system by a human, the backend only records and reviews it.
		pilotCycles: {
			list: (ctx: SelenaRepositoryContext) =>
				db
					.select()
					.from(schema.svPilotCycles)
					.where(eq(schema.svPilotCycles.organizationId, ctx.tenantId))
					.orderBy(desc(schema.svPilotCycles.createdAt)),
			get: (ctx: SelenaRepositoryContext, pilotCycleId: string) => getPilotCycleOwned(ctx, pilotCycleId),
			create: async (
				ctx: SelenaRepositoryContext,
				value: { projectId: string; lockId: string; idempotencyKey?: string },
			) => {
				writable(ctx);
				await assertProjectOwned(ctx, value.projectId);
				const { lock, block } = await lockBlockFor(ctx, value.lockId);
				if (lock.projectId !== value.projectId)
					throw new Error("Not found: configuration lock is outside AuthContext tenant");
				if (value.idempotencyKey) {
					const [priorCreate] = await db
						.select({ subjectId: schema.svAuditEvents.subjectId })
						.from(schema.svAuditEvents)
						.where(
							and(
								eq(schema.svAuditEvents.organizationId, ctx.tenantId),
								eq(schema.svAuditEvents.event, "PILOT_CYCLE_CREATED"),
								sql`${schema.svAuditEvents.details} ->> 'idempotencyKey' = ${value.idempotencyKey}`,
							),
						)
						.limit(1);
					if (priorCreate) return getPilotCycleOwned(ctx, priorCreate.subjectId);
				}
				const [cycle] = await db
					.insert(schema.svPilotCycles)
					.values({
						organizationId: ctx.tenantId,
						projectId: value.projectId,
						lockId: value.lockId,
						expectedObservations: expectedObservations(block.scenarios, block.observerContexts, block.repeats),
						captureProtocolVersion: block.captureProtocolVersion,
					})
					.returning();
				await recordAudit(db, ctx, "PILOT_CYCLE_CREATED", "sv_pilot_cycles", cycle.id, {
					lockId: value.lockId,
					idempotencyKey: value.idempotencyKey ?? null,
				});
				return cycle;
			},
		},
		captureTasks: {
			list: (ctx: SelenaRepositoryContext, pilotCycleId: string) =>
				db
					.select()
					.from(schema.svCaptureTasks)
					.where(
						and(
							eq(schema.svCaptureTasks.pilotCycleId, pilotCycleId),
							eq(schema.svCaptureTasks.organizationId, ctx.tenantId),
						),
					),
			generate: async (ctx: SelenaRepositoryContext, pilotCycleId: string, idempotencyKey?: string) => {
				writable(ctx);
				const cycle = await getPilotCycleOwned(ctx, pilotCycleId);
				const { block } = await lockBlockFor(ctx, cycle.lockId);
				const planned = planCaptureTasks(block);
				if (planned.length !== cycle.expectedObservations) throw new Error("OBSERVATION_CARDINALITY_INVALID");
				const scenarioIds = [...new Set(planned.map((task) => task.scenarioId))];
				const owned = await db
					.select({ id: schema.svScenarios.id })
					.from(schema.svScenarios)
					.where(and(inArray(schema.svScenarios.id, scenarioIds), eq(schema.svScenarios.organizationId, ctx.tenantId)));
				if (owned.length !== scenarioIds.length) throw new Error("Not found: scenario is outside AuthContext tenant");
				// The matrix unique index makes regeneration idempotent: replays
				// insert nothing and can never exceed the planned cardinality.
				const inserted = await db
					.insert(schema.svCaptureTasks)
					.values(
						planned.map((task) => ({
							organizationId: ctx.tenantId,
							pilotCycleId,
							scenarioId: task.scenarioId,
							contextHash: task.contextHash,
							contextSnapshot: task.contextSnapshot,
							repeatIndex: task.repeatIndex,
							queryTextSnapshot: task.queryTextSnapshot,
							targetEntityIdsSnapshot: task.targetEntityIdsSnapshot,
							idempotencyKey: `${pilotCycleId}:${task.dedupeKey}`,
						})),
					)
					.onConflictDoNothing({
						target: [
							schema.svCaptureTasks.pilotCycleId,
							schema.svCaptureTasks.scenarioId,
							schema.svCaptureTasks.contextHash,
							schema.svCaptureTasks.repeatIndex,
						],
					})
					.returning();
				await recordAudit(db, ctx, "CAPTURE_TASKS_GENERATED", "sv_pilot_cycles", pilotCycleId, {
					planned: planned.length,
					inserted: inserted.length,
					idempotencyKey: idempotencyKey ?? null,
				});
				return inserted;
			},
		},
		observations: {
			submit: async (
				ctx: SelenaRepositoryContext,
				input: {
					captureTaskId: string;
					capturedAt: string | Date;
					queryText: string;
					context: unknown;
					orderingState?: OrderingState;
					transcript: string;
					screenshot: {
						privateObjectReference: string;
						mimeType: string;
						sizeBytes: number;
						sha256: string;
					} | null;
					idempotencyKey?: string;
				},
			) => {
				writable(ctx);
				const [task] = await db
					.select()
					.from(schema.svCaptureTasks)
					.where(
						and(
							eq(schema.svCaptureTasks.id, input.captureTaskId),
							eq(schema.svCaptureTasks.organizationId, ctx.tenantId),
						),
					)
					.limit(1);
				if (!task) throw new Error("Not found: capture task is outside AuthContext tenant");
				const cycle = await getPilotCycleOwned(ctx, task.pilotCycleId);
				const { block } = await lockBlockFor(ctx, cycle.lockId);
				assertObservationSubmission(
					{
						queryText: input.queryText,
						context: input.context,
						capturedAt: input.capturedAt,
						transcript: input.transcript,
						screenshotReference: input.screenshot?.privateObjectReference ?? null,
					},
					block.evidencePolicy,
				);
				const context = observerContextSchema.parse(input.context);
				if (contextHash(context) !== task.contextHash) throw new Error("OBSERVATION_CONTEXT_MISMATCH");
				const [existing] = await db
					.select()
					.from(schema.svLocalObservations)
					.where(
						and(
							eq(schema.svLocalObservations.captureTaskId, task.id),
							eq(schema.svLocalObservations.organizationId, ctx.tenantId),
						),
					)
					.limit(1);
				if (existing) return existing;
				return db.transaction(async (tx) => {
					// The counter update and cardinality check share the row lock, so
					// concurrent submits cannot mint observation expected+1.
					const [lockedCycle] = await tx
						.select()
						.from(schema.svPilotCycles)
						.where(and(eq(schema.svPilotCycles.id, cycle.id), eq(schema.svPilotCycles.organizationId, ctx.tenantId)))
						.for("update");
					assertObservationCardinality(lockedCycle.createdObservations, lockedCycle.expectedObservations);
					await tx
						.update(schema.svPilotCycles)
						.set({ createdObservations: lockedCycle.createdObservations + 1, updatedAt: new Date() })
						.where(eq(schema.svPilotCycles.id, cycle.id));
					const [observation] = await tx
						.insert(schema.svLocalObservations)
						.values({
							organizationId: ctx.tenantId,
							captureTaskId: task.id,
							capturedBy: ctx.actorId,
							capturedAt: new Date(input.capturedAt),
							orderingState: input.orderingState ?? "UNKNOWN",
							transcript: input.transcript,
							queryText: input.queryText,
							contentSha256: observationContentSha256(input.transcript),
						})
						.returning();
					if (input.screenshot)
						await tx.insert(schema.svObservationEvidenceAssets).values({
							organizationId: ctx.tenantId,
							observationId: observation.id,
							assetType: "SCREENSHOT",
							mimeType: input.screenshot.mimeType,
							sizeBytes: input.screenshot.sizeBytes,
							sha256: input.screenshot.sha256,
							sequenceIndex: 0,
							privateObjectReference: input.screenshot.privateObjectReference,
							uploadedBy: ctx.actorId,
							capturedAt: new Date(input.capturedAt),
						});
					await tx
						.update(schema.svCaptureTasks)
						.set({ status: "SUBMITTED_FOR_REVIEW", updatedAt: new Date() })
						.where(eq(schema.svCaptureTasks.id, task.id));
					await recordAudit(tx, ctx, "OBSERVATION_SUBMITTED", "sv_local_observations", observation.id, {
						captureTaskId: task.id,
						pilotCycleId: cycle.id,
						idempotencyKey: input.idempotencyKey ?? null,
					});
					return observation;
				});
			},
			review: async (
				ctx: SelenaRepositoryContext,
				observationId: string,
				input: { decision: ObservationReviewDecision; reason?: string; idempotencyKey?: string },
			) => {
				writable(ctx);
				if (!observationReviewDecisions.includes(input.decision))
					throw new Error("OBSERVATION_REVIEW_DECISION_INVALID");
				const observation = await getObservationOwned(ctx, observationId);
				// SURFACE_UNAVAILABLE is a valid capture of an unavailable surface,
				// not invalid evidence — metrics exclude it from denominators.
				const validity =
					input.decision === "ACCEPTED" || input.decision === "SURFACE_UNAVAILABLE" ? "VALID" : "INVALID";
				const [reviewed] = await db
					.update(schema.svLocalObservations)
					.set({
						reviewStatus: input.decision,
						reviewedBy: ctx.actorId,
						reviewedAt: new Date(),
						validity,
						invalidReason: validity === "INVALID" ? (input.reason ?? input.decision) : null,
					})
					.where(
						and(
							eq(schema.svLocalObservations.id, observationId),
							eq(schema.svLocalObservations.organizationId, ctx.tenantId),
						),
					)
					.returning();
				await db
					.update(schema.svCaptureTasks)
					.set({ status: input.decision, updatedAt: new Date() })
					.where(
						and(
							eq(schema.svCaptureTasks.id, observation.captureTaskId),
							eq(schema.svCaptureTasks.organizationId, ctx.tenantId),
						),
					);
				await recordAudit(db, ctx, "OBSERVATION_REVIEWED", "sv_local_observations", observationId, {
					decision: input.decision,
					reason: input.reason ?? null,
					idempotencyKey: input.idempotencyKey ?? null,
				});
				return reviewed;
			},
		},
		mentions: {
			add: async (
				ctx: SelenaRepositoryContext,
				value: {
					observationId: string;
					rawMentionText: string;
					matchedEntityId?: string | null;
					mentionRole: (typeof schema.svMentionRoleEnum.enumValues)[number];
					matchStatus: (typeof schema.svMatchStatusEnum.enumValues)[number];
					matchConfidence?: number | null;
					explicitPosition?: number | null;
					orderingBasis?: string | null;
					factualError?: boolean;
					evidenceLocator?: string | null;
				},
			) => {
				writable(ctx);
				const observation = await getObservationOwned(ctx, value.observationId);
				assertMentionMatch({ matchStatus: value.matchStatus, matchedEntityId: value.matchedEntityId });
				const explicitPosition = resolveExplicitPosition(observation.orderingState, value.explicitPosition);
				if (value.matchedEntityId) {
					const [entity] = await db
						.select({ id: schema.svEntities.id })
						.from(schema.svEntities)
						.where(
							and(eq(schema.svEntities.id, value.matchedEntityId), eq(schema.svEntities.organizationId, ctx.tenantId)),
						)
						.limit(1);
					if (!entity) throw new Error("Not found: entity is outside AuthContext tenant");
				}
				const [mention] = await db
					.insert(schema.svObservationMentions)
					.values({
						organizationId: ctx.tenantId,
						observationId: value.observationId,
						rawMentionText: value.rawMentionText,
						matchedEntityId: value.matchedEntityId ?? null,
						mentionRole: value.mentionRole,
						matchStatus: value.matchStatus,
						matchConfidence: value.matchConfidence == null ? null : String(value.matchConfidence),
						explicitPosition,
						orderingBasis: value.orderingBasis ?? null,
						factualError: value.factualError ?? false,
						evidenceLocator: value.evidenceLocator ?? null,
					})
					.returning();
				await recordAudit(db, ctx, "MENTION_ADDED", "sv_observation_mentions", mention.id, {
					observationId: value.observationId,
				});
				return mention;
			},
		},
		evidenceAssets: {
			add: async (
				ctx: SelenaRepositoryContext,
				value: {
					observationId: string;
					assetType: "SCREENSHOT" | "TRANSCRIPT" | "OTHER";
					mimeType: string;
					sizeBytes: number;
					sha256: string;
					sequenceIndex: number;
					privateObjectReference: string;
					capturedAt: string | Date;
				},
			) => {
				writable(ctx);
				await getObservationOwned(ctx, value.observationId);
				const [asset] = await db
					.insert(schema.svObservationEvidenceAssets)
					.values({
						organizationId: ctx.tenantId,
						observationId: value.observationId,
						assetType: value.assetType,
						mimeType: value.mimeType,
						sizeBytes: value.sizeBytes,
						sha256: value.sha256,
						sequenceIndex: value.sequenceIndex,
						privateObjectReference: value.privateObjectReference,
						uploadedBy: ctx.actorId,
						capturedAt: new Date(value.capturedAt),
					})
					.returning();
				await recordAudit(db, ctx, "EVIDENCE_ASSET_ADDED", "sv_observation_evidence_assets", asset.id, {
					observationId: value.observationId,
				});
				return asset;
			},
		},
		// Human QC sign-off ledger: assertExpertVerified's storage. Publication
		// gates read the latest record per order, so a later rejection revokes an
		// earlier approval without rewriting history.
		qcRecords: {
			create: async (
				ctx: SelenaRepositoryContext,
				input: {
					orderId: string;
					cycleId?: string | null;
					reviewer?: string;
					reviewedAt: string | Date;
					scope: string;
					decision: string;
					notes?: string | null;
				},
			) => {
				writable(ctx);
				assertQcDecision(input.decision);
				await assertOrderOwned(ctx, input.orderId);
				if (input.cycleId) {
					const [cycle] = await db
						.select({ id: schema.svCycles.id, orderId: schema.svCycles.orderId })
						.from(schema.svCycles)
						.where(and(eq(schema.svCycles.id, input.cycleId), eq(schema.svCycles.organizationId, ctx.tenantId)))
						.limit(1);
					if (!cycle || cycle.orderId !== input.orderId)
						throw new Error("Not found: cycle is outside AuthContext tenant");
				}
				const [record] = await db
					.insert(schema.svQcRecords)
					.values({
						organizationId: ctx.tenantId,
						orderId: input.orderId,
						cycleId: input.cycleId ?? null,
						reviewer: input.reviewer ?? ctx.actorId,
						reviewedAt: new Date(input.reviewedAt),
						scope: input.scope,
						decision: input.decision,
						notes: input.notes ?? null,
					})
					.returning();
				await recordAudit(db, ctx, "QC_RECORD_CREATED", "sv_qc_records", record.id, {
					orderId: input.orderId,
					cycleId: input.cycleId ?? null,
					decision: input.decision,
				});
				return record;
			},
			latestForOrder: latestQcRecordForOrder,
			hasApprovedQcRecord: async (ctx: SelenaRepositoryContext, orderId: string) =>
				(await latestQcRecordForOrder(ctx, orderId))?.decision === "approved",
		},
	};
}

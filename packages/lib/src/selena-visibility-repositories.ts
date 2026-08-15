import { and, desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./db/schema";

export type SelenaRepositoryContext = {
	actorId: string;
	tenantId: string;
	role: "owner" | "member" | "viewer";
	authType: "session" | "api_key";
	permissions: string[];
};

type Db = NodePgDatabase<typeof schema>;
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
	};
}

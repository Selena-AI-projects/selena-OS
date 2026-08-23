import { createServerFn } from "@tanstack/react-start";
import { db } from "@workspace/lib/db/db";
import {
	svCycles,
	svOrders,
	svProjectProfiles,
	svRecommendationRuns,
	svWebsiteSnapshots,
} from "@workspace/lib/db/schema";
import { createSelenaRepositories } from "@workspace/lib/selena-visibility-repositories";
import { actionPlanSchema, projectCreateSchema } from "@workspace/selena-visibility-contracts";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { readStoredGoogleMapsLocation } from "@workspace/lib/google-maps-location";
import { resolveSessionAuthContext } from "../lib/selena-auth-context";

const repositories = /* @__PURE__ */ createSelenaRepositories(db);

export const listSelenaProjectsFn = createServerFn({ method: "GET" }).handler(async () => {
	const context = await resolveSessionAuthContext();
	return repositories.projects.list(context);
});

export const getSelenaWorkspaceFn = createServerFn({ method: "GET" }).handler(async () => {
	const context = await resolveSessionAuthContext();
	const projects = await repositories.projects.list(context);
	const summaries = await Promise.all(
		projects.map(async (project) => {
			const [profile, website, cycle, recommendationRun] = await Promise.all([
				db
					.select()
					.from(svProjectProfiles)
					.where(
						and(eq(svProjectProfiles.projectId, project.id), eq(svProjectProfiles.organizationId, context.tenantId)),
					)
					.limit(1)
					.then((rows) => rows[0] ?? null),
				db
					.select({
						website: svWebsiteSnapshots.website,
						capturedAt: svWebsiteSnapshots.capturedAt,
					})
					.from(svWebsiteSnapshots)
					.where(
						and(eq(svWebsiteSnapshots.projectId, project.id), eq(svWebsiteSnapshots.organizationId, context.tenantId)),
					)
					.orderBy(desc(svWebsiteSnapshots.capturedAt))
					.limit(1)
					.then((rows) => rows[0] ?? null),
				db
					.select({
						id: svCycles.id,
						status: svCycles.status,
						expectedRuns: svCycles.expectedRuns,
						completedRuns: svCycles.completedRuns,
						createdAt: svCycles.createdAt,
						updatedAt: svCycles.updatedAt,
					})
					.from(svCycles)
					.innerJoin(svOrders, eq(svCycles.orderId, svOrders.id))
					.where(
						and(
							eq(svOrders.projectId, project.id),
							eq(svOrders.organizationId, context.tenantId),
							eq(svCycles.organizationId, context.tenantId),
						),
					)
					.orderBy(desc(svCycles.createdAt))
					.limit(1)
					.then((rows) => rows[0] ?? null),
				db
					.select({
						id: svRecommendationRuns.id,
						status: svRecommendationRuns.status,
						groundingStatus: svRecommendationRuns.groundingStatus,
						actionPlan: svRecommendationRuns.actionPlan,
						createdAt: svRecommendationRuns.createdAt,
					})
					.from(svRecommendationRuns)
					.where(
						and(
							eq(svRecommendationRuns.projectId, project.id),
							eq(svRecommendationRuns.organizationId, context.tenantId),
						),
					)
					.orderBy(desc(svRecommendationRuns.createdAt))
					.limit(1)
					.then((rows) => rows[0] ?? null),
			]);

			const parsedPlan = actionPlanSchema.safeParse(recommendationRun?.actionPlan);
			const actionPlan = parsedPlan.success ? parsedPlan.data : null;
			return {
				project: {
					id: project.id,
					name: project.name,
					category: project.category,
					country: project.country,
					region: project.region,
					languages: project.languages,
					status: project.status,
					createdAt: project.createdAt.toISOString(),
				},
				profile: profile
					? {
							brandName: profile.brandName,
							primaryDomain: profile.primaryDomain,
							publicProfiles: Array.isArray(profile.publicProfiles) ? profile.publicProfiles : [],
							mapsLocation: readStoredGoogleMapsLocation(profile.mapsLocation),
							competitors: Array.isArray(profile.competitorSnapshot) ? profile.competitorSnapshot : [],
							scenarios: Array.isArray(profile.scenarioSnapshot) ? profile.scenarioSnapshot : [],
							confirmedAt: profile.confirmedAt?.toISOString() ?? null,
						}
					: null,
				website: website ? { website: website.website, capturedAt: website.capturedAt.toISOString() } : null,
				measurement: cycle
					? {
							id: cycle.id,
							status: cycle.status,
							expectedRuns: cycle.expectedRuns,
							completedRuns: cycle.completedRuns,
							createdAt: cycle.createdAt.toISOString(),
							updatedAt: cycle.updatedAt.toISOString(),
						}
					: null,
				recommendation: recommendationRun
					? {
							id: recommendationRun.id,
							status: recommendationRun.status,
							groundingStatus: recommendationRun.groundingStatus,
							createdAt: recommendationRun.createdAt.toISOString(),
							findingsCount: actionPlan?.findings.length ?? 0,
							recommendationsCount: actionPlan?.recommendations.length ?? 0,
							tasksCount: actionPlan?.tasks.length ?? 0,
							topActions:
								actionPlan?.recommendations
									.filter((item) => !item.blocked)
									.slice(0, 3)
									.map((item) => ({ title: item.title, action: item.action, priority: item.priority })) ?? [],
						}
					: null,
			};
		}),
	);
	return { projects: summaries };
});

export const createSelenaProjectFn = createServerFn({ method: "POST" })
	.validator(projectCreateSchema)
	.handler(async ({ data }) => {
		const context = await resolveSessionAuthContext();
		return repositories.projects.create(context, { ...data, status: "DRAFT" });
	});

export const getSelenaProjectFn = createServerFn({ method: "GET" })
	.validator(z.object({ projectId: z.string().uuid() }))
	.handler(async ({ data }) => repositories.projects.get(await resolveSessionAuthContext(), data.projectId));

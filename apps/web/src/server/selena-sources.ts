import { createServerFn } from "@tanstack/react-start";
import { db } from "@workspace/lib/db/db";
import { createSelenaRepositories } from "@workspace/lib/selena-visibility-repositories";
import { z } from "zod";
import { resolveSessionAuthContext } from "../lib/selena-auth-context";

const repositories = createSelenaRepositories(db);

/**
 * The Source Opportunity Map (addendum §8) reads the stored snapshots rather
 * than recomputing them, so what the customer sees is the aggregation that was
 * written when the cycle was analysed, under the formula version stored beside
 * it. Recomputing on read would quietly change a number the client already saw.
 */
export const getSelenaSourceMapFn = createServerFn({ method: "GET" })
	.validator(z.object({ projectId: z.string().uuid(), gapsOnly: z.boolean().optional() }))
	.handler(async ({ data }) => {
		const context = await resolveSessionAuthContext();
		const project = await repositories.projects.get(context, data.projectId);
		if (!project) throw new Error("Project not found");
		const sources = await repositories.citationGaps.listForProject(context, data.projectId, {
			gapsOnly: data.gapsOnly,
		});
		return {
			project: { id: project.id, name: project.name },
			sources: sources.map((source) => ({
				id: source.id,
				cycleId: source.cycleId,
				domain: source.sourceDomain,
				urls: source.sourceUrls,
				ownedCitationCount: source.ownedCitationCount,
				competitorCitationCount: source.competitorCitationCount,
				competitorNames: source.competitorNames,
				scenarioCount: source.scenarioCount,
				engineCount: source.engineCount,
				repeatStability: source.repeatStability === null ? null : Number(source.repeatStability),
				firstSeen: source.firstSeen?.toISOString() ?? null,
				lastSeen: source.lastSeen?.toISOString() ?? null,
				gapType: source.gapType,
				priorityBand: source.priorityBand,
				formulaVersion: source.formulaVersion,
				evidenceRunIds: source.evidenceRunIds,
			})),
		};
	});

export const listSelenaSourceProjectsFn = createServerFn({ method: "GET" }).handler(async () => {
	const context = await resolveSessionAuthContext();
	const projects = await repositories.projects.list(context);
	return projects.map((project) => ({ id: project.id, name: project.name }));
});

import { createServerFn } from "@tanstack/react-start";
import { db } from "@workspace/lib/db/db";
import { svProjectProfiles, svWebsiteSnapshots } from "@workspace/lib/db/schema";
import { readStoredGoogleMapsLocation } from "@workspace/lib/google-maps-location";
import { buildWebsiteActionPlan, collectWebsite } from "@workspace/lib/website-collector";
import { createRecommendationRepositories } from "@workspace/lib/recommendation-persistence";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { resolveSessionAuthContext } from "../lib/selena-auth-context";

const recommendationRepositories = /* @__PURE__ */ createRecommendationRepositories(db);

export const collectSelenaWebsiteFn = createServerFn({ method: "POST" })
	.validator(z.object({ projectId: z.string().uuid() }))
	.handler(async ({ data }) => {
		const auth = await resolveSessionAuthContext();
		const [profile] = await db
			.select({ primaryDomain: svProjectProfiles.primaryDomain, mapsLocation: svProjectProfiles.mapsLocation })
			.from(svProjectProfiles)
			.where(and(eq(svProjectProfiles.projectId, data.projectId), eq(svProjectProfiles.organizationId, auth.tenantId)))
			.limit(1);
		if (!profile) throw new Error("Website collection requires a confirmed project profile");
		const collection = await collectWebsite(auth.tenantId, profile.primaryDomain);
		const actionPlan = buildWebsiteActionPlan(collection, {
			mapsLocation: readStoredGoogleMapsLocation(profile.mapsLocation),
		});
		const [stored] = await db
			.insert(svWebsiteSnapshots)
			.values({
				id: collection.snapshot.id,
				organizationId: auth.tenantId,
				projectId: data.projectId,
				website: collection.snapshot.url,
				contentHash: collection.snapshot.contentHash,
				capturedAt: new Date(collection.snapshot.capturedAt),
				snapshot: collection.snapshot,
				immutable: true,
			})
			.onConflictDoNothing({ target: [svWebsiteSnapshots.projectId, svWebsiteSnapshots.contentHash] })
			.returning();
		const run = await recommendationRepositories.create(auth, {
			projectId: data.projectId,
			datasetId: collection.snapshot.id,
			idempotencyKey: `website:${collection.snapshot.id}`,
			evidence: collection.evidence,
			rulepackVersion: collection.manifest.rulepackVersion,
			actionPlan,
			manifest: collection.manifest,
		});
		return {
			snapshot: {
				id: stored?.id ?? collection.snapshot.id,
				url: stored?.website ?? collection.snapshot.url,
				contentHash: stored?.contentHash ?? collection.snapshot.contentHash,
				capturedAt: (stored?.capturedAt ?? new Date(collection.snapshot.capturedAt)).toISOString(),
				immutable: true,
			},
			manifest: collection.manifest,
			recommendationRunId: run.id,
			evidenceCount: collection.evidence.length,
			actionPlan,
		};
	});

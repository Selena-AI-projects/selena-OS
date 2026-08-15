import { createFileRoute } from "@tanstack/react-router";
import { db } from "@workspace/lib/db/db";
import { svProjectProfiles, svWebsiteSnapshots } from "@workspace/lib/db/schema";
import { buildWebsiteActionPlan, collectWebsite } from "@workspace/lib/website-collector";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { resolveApiKeyAuthContext } from "../../../../lib/selena-auth-context";

const requestSchema = z.object({ projectId: z.string().uuid() });

export const Route = createFileRoute("/api/v1/selena/website-collector")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				try {
					const auth = await resolveApiKeyAuthContext(request);
					if (!auth.permissions.includes("client:write")) return Response.json({ error: "Forbidden" }, { status: 403 });
					const parsed = requestSchema.safeParse(await request.json());
					if (!parsed.success)
						return Response.json({ error: "Validation Error", message: parsed.error.message }, { status: 400 });
					const [profile] = await db
						.select({ primaryDomain: svProjectProfiles.primaryDomain })
						.from(svProjectProfiles)
						.where(
							and(
								eq(svProjectProfiles.projectId, parsed.data.projectId),
								eq(svProjectProfiles.organizationId, auth.tenantId),
							),
						)
						.limit(1);
					if (!profile)
						return Response.json(
							{ error: "Not Found", message: "Confirmed project profile is required" },
							{ status: 404 },
						);
					const collection = await collectWebsite(auth.tenantId, profile.primaryDomain);
					await db
						.insert(svWebsiteSnapshots)
						.values({
							id: collection.snapshot.id,
							organizationId: auth.tenantId,
							projectId: parsed.data.projectId,
							website: collection.snapshot.url,
							contentHash: collection.snapshot.contentHash,
							capturedAt: new Date(collection.snapshot.capturedAt),
							snapshot: collection.snapshot,
							immutable: true,
						})
						.onConflictDoNothing({ target: [svWebsiteSnapshots.projectId, svWebsiteSnapshots.contentHash] });
					return Response.json(
						{
							snapshot: {
								id: collection.snapshot.id,
								url: collection.snapshot.url,
								contentHash: collection.snapshot.contentHash,
								immutable: true,
							},
							manifest: collection.manifest,
							evidenceCount: collection.evidence.length,
							actionPlan: buildWebsiteActionPlan(collection),
						},
						{ status: 201 },
					);
				} catch (error) {
					return Response.json(
						{ error: "Request Failed", message: error instanceof Error ? error.message : "Unable to collect website" },
						{ status: 400 },
					);
				}
			},
		},
	},
});

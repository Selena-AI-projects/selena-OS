import { createFileRoute } from "@tanstack/react-router";
import { db } from "@workspace/lib/db/db";
import { createSelenaRepositories } from "@workspace/lib/selena-visibility-repositories";
import { z } from "zod";
import { resolveApiKeyAuthContext } from "../../../../lib/selena-auth-context";

const repositories = createSelenaRepositories(db);

/**
 * Addendum §8: the stored snapshots, not a recomputation. A client reading this
 * twice gets the same numbers the cycle was analysed with, each carrying the
 * formula version that produced it.
 */
export const Route = createFileRoute("/api/v1/selena/citation-gaps")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				try {
					const auth = await resolveApiKeyAuthContext(request);
					const params = new URL(request.url).searchParams;
					const projectId = params.get("projectId");
					if (!projectId || !z.string().uuid().safeParse(projectId).success)
						return Response.json(
							{ error: "Validation Error", message: "projectId query parameter is required" },
							{ status: 400 },
						);
					const sources = await repositories.citationGaps.listForProject(auth, projectId, {
						gapsOnly: params.get("gapsOnly") === "true",
					});
					return Response.json({ sources });
				} catch (error) {
					return Response.json(
						{
							error: "Request Failed",
							message: error instanceof Error ? error.message : "Unable to read citation gaps",
						},
						{ status: 400 },
					);
				}
			},
		},
	},
});

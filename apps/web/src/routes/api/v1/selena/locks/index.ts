import { createFileRoute } from "@tanstack/react-router";
import { db } from "@workspace/lib/db/db";
import { createSelenaRepositories } from "@workspace/lib/selena-visibility-repositories";
import { z } from "zod";
import { resolveApiKeyAuthContext } from "../../../../../lib/selena-auth-context";

const repositories = createSelenaRepositories(db);
const bodySchema = z.object({
	projectId: z.string().uuid(),
	version: z.number().int().positive(),
	snapshot: z.record(z.string(), z.unknown()),
	engineSha: z.string().min(1),
	expectedRuns: z.number().int().positive(),
	budgetCap: z.number().nonnegative(),
});

export const Route = createFileRoute("/api/v1/selena/locks/")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				try {
					const auth = await resolveApiKeyAuthContext(request);
					const projectId = new URL(request.url).searchParams.get("projectId");
					if (!projectId || !z.string().uuid().safeParse(projectId).success)
						return Response.json(
							{ error: "Validation Error", message: "projectId query parameter is required" },
							{ status: 400 },
						);
					return Response.json({ locks: await repositories.locks.list(auth, projectId) });
				} catch (error) {
					return Response.json(
						{ error: "Request Failed", message: error instanceof Error ? error.message : "Unable to read locks" },
						{ status: 400 },
					);
				}
			},
			POST: async ({ request }) => {
				try {
					const auth = await resolveApiKeyAuthContext(request);
					if (!auth.permissions.includes("client:write"))
						return Response.json(
							{ error: "Forbidden", message: "API key lacks client:write permission" },
							{ status: 403 },
						);
					const parsed = bodySchema.safeParse(await request.json());
					if (!parsed.success)
						return Response.json({ error: "Validation Error", message: parsed.error.message }, { status: 400 });
					const lock = await repositories.locks.create(auth, {
						projectId: parsed.data.projectId,
						version: parsed.data.version,
						snapshot: parsed.data.snapshot,
						engineSha: parsed.data.engineSha,
						expectedRuns: parsed.data.expectedRuns,
						budgetCap: String(parsed.data.budgetCap),
					});
					return Response.json(lock, { status: 201 });
				} catch (error) {
					const message = error instanceof Error ? error.message : "Request failed";
					return Response.json(
						{ error: message.startsWith("Forbidden") ? "Forbidden" : "Request Failed", message },
						{ status: message.startsWith("Forbidden") ? 403 : 400 },
					);
				}
			},
		},
	},
});

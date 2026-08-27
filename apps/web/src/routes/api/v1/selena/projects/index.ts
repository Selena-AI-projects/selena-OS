import { createFileRoute } from "@tanstack/react-router";
import { db } from "@workspace/lib/db/db";
import { createSelenaRepositories } from "@workspace/lib/selena-visibility-repositories";
import { projectCreateSchema } from "@workspace/selena-visibility-contracts";
import { resolveApiKeyAuthContext } from "../../../../../lib/selena-auth-context.server";

const repositories = createSelenaRepositories(db);

export const Route = createFileRoute("/api/v1/selena/projects/")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				try {
					return Response.json({ projects: await repositories.projects.list(await resolveApiKeyAuthContext(request)) });
				} catch {
					return Response.json({ error: "Unauthorized", message: "Valid scoped API key required" }, { status: 401 });
				}
			},
			POST: async ({ request }) => {
				try {
					const auth = await resolveApiKeyAuthContext(request);
					const parsed = projectCreateSchema.safeParse(await request.json());
					if (!parsed.success)
						return Response.json({ error: "Validation Error", message: parsed.error.message }, { status: 400 });
					return Response.json(await repositories.projects.create(auth, { ...parsed.data, status: "DRAFT" }), {
						status: 201,
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : "Request failed";
					return Response.json(
						{ error: message.startsWith("Forbidden") ? "Forbidden" : "Unauthorized", message },
						{ status: message.startsWith("Forbidden") ? 403 : 401 },
					);
				}
			},
		},
	},
});

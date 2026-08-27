import { createFileRoute } from "@tanstack/react-router";
import { db } from "@workspace/lib/db/db";
import { createSelenaRepositories } from "@workspace/lib/selena-visibility-repositories";
import { z } from "zod";
import { resolveApiKeyAuthContext } from "../../../../../lib/selena-auth-context.server";

const repositories = createSelenaRepositories(db);
const bodySchema = z.object({ familyId: z.string().uuid(), text: z.string().min(1), language: z.string().min(2) });

export const Route = createFileRoute("/api/v1/selena/scenarios/")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				try {
					const auth = await resolveApiKeyAuthContext(request);
					const familyId = new URL(request.url).searchParams.get("familyId");
					if (!familyId || !z.string().uuid().safeParse(familyId).success)
						return Response.json(
							{ error: "Validation Error", message: "familyId query parameter is required" },
							{ status: 400 },
						);
					return Response.json({ scenarios: await repositories.scenarios.list(auth, familyId) });
				} catch (error) {
					return Response.json(
						{ error: "Request Failed", message: error instanceof Error ? error.message : "Unable to read scenarios" },
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
					return Response.json(await repositories.scenarios.create(auth, { ...parsed.data, status: "PROPOSED" }), {
						status: 201,
					});
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

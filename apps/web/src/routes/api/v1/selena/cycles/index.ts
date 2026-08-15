import { createFileRoute } from "@tanstack/react-router";
import { db } from "@workspace/lib/db/db";
import { createSelenaRepositories } from "@workspace/lib/selena-visibility-repositories";
import { z } from "zod";
import { resolveApiKeyAuthContext } from "../../../../../lib/selena-auth-context";

const repositories = createSelenaRepositories(db);
const createSchema = z.object({
	orderId: z.string().uuid(),
	lockId: z.string().uuid(),
	expectedRuns: z.number().int().positive(),
});

export const Route = createFileRoute("/api/v1/selena/cycles/")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				try {
					const auth = await resolveApiKeyAuthContext(request);
					const orderId = new URL(request.url).searchParams.get("orderId");
					if (!orderId || !z.string().uuid().safeParse(orderId).success)
						return Response.json(
							{ error: "Validation Error", message: "orderId query parameter is required" },
							{ status: 400 },
						);
					return Response.json({ cycles: await repositories.cycles.list(auth, orderId) });
				} catch (error) {
					return Response.json(
						{
							error: "Unauthorized",
							message: error instanceof Error ? error.message : "Valid scoped API key required",
						},
						{ status: 401 },
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
					const parsed = createSchema.safeParse(await request.json());
					if (!parsed.success)
						return Response.json({ error: "Validation Error", message: parsed.error.message }, { status: 400 });
					return Response.json(
						await repositories.cycles.create(auth, {
							...parsed.data,
							status: "CREATED",
							createdRuns: 0,
							completedRuns: 0,
						}),
						{ status: 201 },
					);
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

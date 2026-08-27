import { createFileRoute } from "@tanstack/react-router";
import { db } from "@workspace/lib/db/db";
import { createSelenaRepositories } from "@workspace/lib/selena-visibility-repositories";
import { z } from "zod";
import { resolveApiKeyAuthContext } from "../../../../../lib/selena-auth-context.server";

const repositories = createSelenaRepositories(db);
const bodySchema = z.object({
	projectId: z.string().uuid(),
	quoteId: z.string().uuid(),
	lockId: z.string().uuid(),
	orderCap: z.number().nonnegative(),
});

export const Route = createFileRoute("/api/v1/selena/orders/")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				try {
					return Response.json({ orders: await repositories.orders.list(await resolveApiKeyAuthContext(request)) });
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
					const parsed = bodySchema.safeParse(await request.json());
					if (!parsed.success)
						return Response.json({ error: "Validation Error", message: parsed.error.message }, { status: 400 });
					return Response.json(
						await repositories.orders.create(auth, {
							projectId: parsed.data.projectId,
							quoteId: parsed.data.quoteId,
							lockId: parsed.data.lockId,
							orderCap: String(parsed.data.orderCap),
							status: "AWAITING_PAYMENT",
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

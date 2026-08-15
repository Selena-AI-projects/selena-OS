import { createFileRoute } from "@tanstack/react-router";
import { db } from "@workspace/lib/db/db";
import { createSelenaRepositories } from "@workspace/lib/selena-visibility-repositories";
import { calculateQuote, quoteCreateSchema, quotePricingSchema } from "@workspace/selena-visibility-contracts";
import { z } from "zod";
import { resolveApiKeyAuthContext } from "../../../../../lib/selena-auth-context";

const repositories = createSelenaRepositories(db);
const quoteBody = z.object({
	projectId: z.string().uuid(),
	lockId: z.string().uuid(),
	input: quoteCreateSchema,
	pricing: quotePricingSchema,
});

export const Route = createFileRoute("/api/v1/selena/quotes/")({
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
					return Response.json({ quotes: await repositories.quotes.list(auth, projectId) });
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
					const parsed = quoteBody.safeParse(await request.json());
					if (!parsed.success)
						return Response.json({ error: "Validation Error", message: parsed.error.message }, { status: 400 });
					const quote = calculateQuote(parsed.data.input, parsed.data.pricing);
					return Response.json(
						await repositories.quotes.create(auth, {
							projectId: parsed.data.projectId,
							lockId: parsed.data.lockId,
							status: "ISSUED",
							priceAmount: String(quote.amount),
							currency: quote.currency,
							expectedRuns: quote.expectedRuns,
							expiresAt: new Date(Date.now() + 7 * 86400000),
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

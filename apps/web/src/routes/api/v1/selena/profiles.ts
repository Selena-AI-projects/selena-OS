import { createFileRoute } from "@tanstack/react-router";
import { db } from "@workspace/lib/db/db";
import { createSelenaRepositories } from "@workspace/lib/selena-visibility-repositories";
import { z } from "zod";
import { resolveApiKeyAuthContext } from "../../../../lib/selena-auth-context";

const repositories = createSelenaRepositories(db);
const profileSchema = z.object({
	projectId: z.string().uuid(),
	brandName: z.string().trim().min(1).max(160),
	primaryDomain: z.string().url(),
	publicProfiles: z.array(z.object({ platform: z.string().min(1), url: z.string().url() })).max(20),
	competitorSnapshot: z.array(z.object({ name: z.string().min(1), domains: z.array(z.string()) })).max(50),
	scenarioSnapshot: z
		.array(z.object({ text: z.string().min(1), language: z.string().min(2), intentType: z.string().min(1) }))
		.max(100),
});

export const Route = createFileRoute("/api/v1/selena/profiles")({
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
					const profile = await repositories.profiles.get(auth, projectId);
					return profile
						? Response.json(profile)
						: Response.json({ error: "Not Found", message: "Profile not found" }, { status: 404 });
				} catch (error) {
					return Response.json(
						{ error: "Request Failed", message: error instanceof Error ? error.message : "Unable to read profile" },
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
					const parsed = profileSchema.safeParse(await request.json());
					if (!parsed.success)
						return Response.json({ error: "Validation Error", message: parsed.error.message }, { status: 400 });
					const profile = await repositories.profiles.confirm(auth, parsed.data);
					return Response.json(profile, { status: 201 });
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

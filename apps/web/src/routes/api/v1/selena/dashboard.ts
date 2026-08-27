import { createFileRoute } from "@tanstack/react-router";
import { db } from "@workspace/lib/db/db";
import { svCycles, svFindings, svRecommendations } from "@workspace/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { resolveApiKeyAuthContext } from "../../../../lib/selena-auth-context.server";

export const Route = createFileRoute("/api/v1/selena/dashboard")({
	server: {
		handlers: {
			GET: async ({ request }) => {
				try {
					const auth = await resolveApiKeyAuthContext(request);
					const cycleId = new URL(request.url).searchParams.get("cycleId");
					if (!cycleId || !z.string().uuid().safeParse(cycleId).success)
						return Response.json(
							{ error: "Validation Error", message: "cycleId query parameter is required" },
							{ status: 400 },
						);
					const [cycle] = await db
						.select()
						.from(svCycles)
						.where(and(eq(svCycles.id, cycleId), eq(svCycles.organizationId, auth.tenantId)))
						.limit(1);
					if (!cycle)
						return Response.json(
							{ error: "Not Found", message: "Cycle is outside AuthContext tenant" },
							{ status: 404 },
						);
					const [findings, recommendations] = await Promise.all([
						db
							.select()
							.from(svFindings)
							.where(and(eq(svFindings.cycleId, cycle.id), eq(svFindings.organizationId, auth.tenantId))),
						db
							.select()
							.from(svRecommendations)
							.where(and(eq(svRecommendations.cycleId, cycle.id), eq(svRecommendations.organizationId, auth.tenantId))),
					]);
					return Response.json({
						cycle,
						findings,
						recommendations,
						channels: ["Visitor View", "API View"],
						reportExports: { csv: true, pdf: true, xlsx: true },
					});
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
		},
	},
});

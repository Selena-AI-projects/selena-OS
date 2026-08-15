import { createFileRoute } from "@tanstack/react-router";
import { db } from "@workspace/lib/db/db";
import { svPublicScans } from "@workspace/lib/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";

const scanIdSchema = z.string().uuid();

export const Route = createFileRoute("/api/v1/selena/readiness/scans/$scanId")({
	server: {
		handlers: {
			GET: async ({ params }) => {
				if (!scanIdSchema.safeParse(params.scanId).success) return Response.json({ error: "Validation Error" }, { status: 400 });
				const [scan] = await db.select().from(svPublicScans).where(eq(svPublicScans.id, params.scanId)).limit(1);
				if (!scan) return Response.json({ error: "Not Found" }, { status: 404 });
				return Response.json({ id: scan.id, website: scan.website, status: scan.status, result: scan.result, createdAt: scan.createdAt, completedAt: scan.completedAt });
			},
		},
	},
});

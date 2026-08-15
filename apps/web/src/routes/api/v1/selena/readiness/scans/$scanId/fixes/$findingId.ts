import { createFileRoute } from "@tanstack/react-router";
import { db } from "@workspace/lib/db/db";
import { svPublicScans } from "@workspace/lib/db/schema";
import { generateReadinessFix, readinessResultSchema } from "@workspace/selena-visibility-contracts";
import { eq } from "drizzle-orm";

export const Route = createFileRoute("/api/v1/selena/readiness/scans/$scanId/fixes/$findingId")({
	server: {
		handlers: {
			GET: async ({ params }) => {
				const [scan] = await db.select().from(svPublicScans).where(eq(svPublicScans.id, params.scanId)).limit(1);
				if (!scan) return Response.json({ error: "Not Found" }, { status: 404 });
				const parsed = readinessResultSchema.safeParse((scan.result as { readiness?: unknown } | null)?.readiness);
				const finding = parsed.success ? parsed.data.findings.find((item) => item.id === params.findingId) : undefined;
				if (!finding) return Response.json({ error: "Not Found" }, { status: 404 });
				return Response.json({ fix: generateReadinessFix(finding), applied: false });
			},
		},
	},
});

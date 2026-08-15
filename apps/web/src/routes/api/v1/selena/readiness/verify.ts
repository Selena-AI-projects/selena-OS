import { createFileRoute } from "@tanstack/react-router";
import { db } from "@workspace/lib/db/db";
import { svPublicScans } from "@workspace/lib/db/schema";
import { collectWebsite } from "@workspace/lib/website-collector";
import { assertPublicScanUrl } from "../../../../../lib/selena-public-scan-policy";
import { compareReadiness, scorePublicReadiness } from "@workspace/selena-visibility-contracts";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

const bodySchema = z.object({ scanId: z.string().uuid(), website: z.string().trim().min(1).max(2048).optional() });

export const Route = createFileRoute("/api/v1/selena/readiness/verify")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				let verificationId: string | undefined;
				try {
					const parsed = bodySchema.safeParse(await request.json());
					if (!parsed.success) return Response.json({ error: "Validation Error", message: parsed.error.message }, { status: 400 });
					const [baselineScan] = await db.select().from(svPublicScans).where(and(eq(svPublicScans.id, parsed.data.scanId), eq(svPublicScans.status, "COMPLETED"))).limit(1);
					if (!baselineScan) return Response.json({ error: "Not Found", message: "Completed readiness baseline not found" }, { status: 404 });
					const baseline = (baselineScan.result as { readiness?: unknown } | null)?.readiness;
					if (!baseline) return Response.json({ error: "Invalid Baseline" }, { status: 409 });
					const website = assertPublicScanUrl(parsed.data.website ?? baselineScan.website);
					const [verificationScan] = await db.insert(svPublicScans).values({ website, status: "PENDING" }).returning({ id: svPublicScans.id });
					if (!verificationScan) throw new Error("Unable to create verification job");
					verificationId = verificationScan.id;
					const collection = await collectWebsite("public-readiness-verification", website, { maxPages: 5, maxDepth: 1 });
					const readiness = scorePublicReadiness({ pageUrl: collection.snapshot.finalUrl, status: collection.snapshot.status, robots: collection.snapshot.robots, canonical: collection.snapshot.canonical, headings: collection.snapshot.headings, visibleText: collection.snapshot.visibleText, jsonLd: collection.snapshot.jsonLd, contacts: collection.snapshot.contacts, services: collection.snapshot.services, metadata: collection.snapshot.metadata, internalLinks: collection.snapshot.internalLinks });
					const [completed] = await db.update(svPublicScans).set({ status: "COMPLETED", result: { readiness, baselineScanId: baselineScan.id, verification: true, providerCalls: 0 }, completedAt: new Date() }).where(eq(svPublicScans.id, verificationScan.id)).returning({ id: svPublicScans.id });
					if (!completed) throw new Error("Unable to complete verification job");
					return Response.json({ verificationScanId: completed.id, baselineScanId: baselineScan.id, comparison: compareReadiness(baseline as Parameters<typeof compareReadiness>[0], readiness), providerCalls: 0 });
				} catch (error) {
					if (verificationId) await db.update(svPublicScans).set({ status: "FAILED", completedAt: new Date() }).where(eq(svPublicScans.id, verificationId));
					const message = error instanceof Error ? error.message : "Verification failed";
					return Response.json({ error: "Verification Failed", message }, { status: 502 });
				}
			},
		},
	},
});

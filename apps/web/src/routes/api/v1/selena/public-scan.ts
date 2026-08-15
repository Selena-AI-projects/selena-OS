import { createFileRoute } from "@tanstack/react-router";
import { db } from "@workspace/lib/db/db";
import { svPublicScans } from "@workspace/lib/db/schema";
import { cleanOnboardingDomain, inferBrandNameFromDomain } from "@workspace/lib/onboarding";
import { getWebsiteExcerpt } from "@workspace/lib/website-excerpt";
import { collectWebsite } from "@workspace/lib/website-collector";
import { scorePublicReadiness } from "@workspace/selena-visibility-contracts";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { assertPublicScanUrl } from "../../../../lib/selena-public-scan-policy";

const bodySchema = z.object({ website: z.string().trim().min(1).max(2048) });

export const Route = createFileRoute("/api/v1/selena/public-scan")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				let scanId: string | undefined;
				try {
					const parsed = bodySchema.safeParse(await request.json());
					if (!parsed.success)
						return Response.json({ error: "Validation Error", message: parsed.error.message }, { status: 400 });
					const website = assertPublicScanUrl(parsed.data.website);
					const [scan] = await db
						.insert(svPublicScans)
						.values({ website, status: "PENDING" })
						.returning({ id: svPublicScans.id });
					if (!scan) throw new Error("Unable to create public scan");
					scanId = scan.id;
					const collection = await collectWebsite("public-readiness", website, { maxPages: 5, maxDepth: 1 });
					const excerpt = collection.snapshot.visibleText.slice(0, 2_000) || await getWebsiteExcerpt(website);
					const readiness = scorePublicReadiness({
						pageUrl: collection.snapshot.finalUrl, status: collection.snapshot.status, robots: collection.snapshot.robots,
						canonical: collection.snapshot.canonical, headings: collection.snapshot.headings, visibleText: collection.snapshot.visibleText,
						jsonLd: collection.snapshot.jsonLd, contacts: collection.snapshot.contacts, services: collection.snapshot.services,
						metadata: collection.snapshot.metadata, internalLinks: collection.snapshot.internalLinks,
					});
					const result = {
						website,
						domain: cleanOnboardingDomain(website),
						suggestedBrandName: inferBrandNameFromDomain(website),
						excerpt,
						readiness,
						evidenceCount: collection.evidence.length,
						manifestId: collection.manifest.id,
						requiresRegistrationForFullReport: true,
					};
					const [completed] = await db
						.update(svPublicScans)
						.set({ status: "COMPLETED", result, completedAt: new Date() })
						.where(eq(svPublicScans.id, scan.id))
						.returning();
					return Response.json({ id: completed?.id ?? scan.id, status: "COMPLETED", result }, { status: 200 });
				} catch (error) {
					if (scanId)
						await db
							.update(svPublicScans)
							.set({ status: "FAILED", completedAt: new Date() })
							.where(eq(svPublicScans.id, scanId));
					const message = error instanceof Error ? error.message : "Public scan failed";
					return Response.json(
						{
							error:
								message.includes("Private hosts") || message.includes("valid public")
									? "Validation Error"
									: "Scan Failed",
							message,
						},
						{ status: message.includes("Private hosts") || message.includes("valid public") ? 400 : 502 },
					);
				}
			},
		},
	},
});

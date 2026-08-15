import { createServerFn } from "@tanstack/react-start";
import { db } from "@workspace/lib/db/db";
import { svPublicScans } from "@workspace/lib/db/schema";
import { cleanOnboardingDomain as cleanDomain, inferBrandNameFromDomain } from "@workspace/lib/onboarding";
import { getWebsiteExcerpt } from "@workspace/lib/website-excerpt";
import { collectWebsite } from "@workspace/lib/website-collector";
import { scorePublicReadiness } from "@workspace/selena-visibility-contracts";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { assertPublicScanUrl } from "../lib/selena-public-scan-policy";

export const runSelenaPublicScanFn = createServerFn({ method: "POST" })
	.validator(z.object({ website: z.string().trim().min(1).max(2048) }))
	.handler(async ({ data }) => {
		const website = assertPublicScanUrl(data.website);
		const [scan] = await db.insert(svPublicScans).values({ website, status: "PENDING" }).returning();
		if (!scan) throw new Error("Unable to create public scan");
		try {
			const collection = await collectWebsite("public-readiness", website, { maxPages: 5, maxDepth: 1 });
			const excerpt = collection.snapshot.visibleText.slice(0, 2_000) || await getWebsiteExcerpt(website);
			const readiness = scorePublicReadiness({
				pageUrl: collection.snapshot.finalUrl,
				status: collection.snapshot.status,
				robots: collection.snapshot.robots,
				canonical: collection.snapshot.canonical,
				headings: collection.snapshot.headings,
				visibleText: collection.snapshot.visibleText,
				jsonLd: collection.snapshot.jsonLd,
				contacts: collection.snapshot.contacts,
				services: collection.snapshot.services,
				metadata: collection.snapshot.metadata,
				internalLinks: collection.snapshot.internalLinks,
			});
			const result = {
				website,
				domain: cleanDomain(website),
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
			if (!completed) throw new Error("Unable to complete public scan");
			return {
				id: completed.id,
				website: completed.website,
				status: completed.status,
				result,
				createdAt: completed.createdAt,
				completedAt: completed.completedAt,
			};
		} catch (error) {
			await db
				.update(svPublicScans)
				.set({ status: "FAILED", completedAt: new Date() })
				.where(eq(svPublicScans.id, scan.id));
			throw error;
		}
	});

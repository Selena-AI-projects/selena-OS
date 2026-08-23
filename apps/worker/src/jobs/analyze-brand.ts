import { db } from "@workspace/lib/db/db";
import { svProjects } from "@workspace/lib/db/schema";
import { analyzeBrand, type OnboardingSuggestion } from "@workspace/lib/onboarding";
import { assertSuggestSpendAllowed } from "@workspace/lib/run-policy";
import { assertSuggestBudget, recordSuggestCost } from "@workspace/lib/selena-suggest-metering";
import { eq } from "drizzle-orm";
import type { Job } from "pg-boss";

export interface AnalyzeBrandData {
	/** Id the web app reads the result back by. */
	requestKey: string;
	website: string;
	brandName?: string;
	/** Free-text place context; scopes competitors and prompts to the area. */
	locationHint?: string;
	maxCompetitors?: number;
	maxPrompts?: number;
}

/**
 * Run brand analysis as a background job.
 *
 * The onboarding wizard used to call analyzeBrand() synchronously inside the
 * HTTP request. That call is an LLM + web-search round trip that routinely
 * takes ~1 minute, so it gets killed by reverse-proxy read timeouts (the user
 * sees a 504 even though the work finishes). Running it here lets the request
 * return immediately; the web app polls the job's `output` via getJobById.
 *
 * The queue is registered with batchSize: 1, so `jobs` always holds exactly
 * one job and the returned suggestion becomes that job's output.
 */
export async function analyzeBrandJob(jobs: Job<AnalyzeBrandData>[]): Promise<OnboardingSuggestion> {
	const [job] = jobs;
	if (!job) {
		throw new Error("analyze-brand handler received an empty batch");
	}

	const { requestKey, website, brandName, locationHint, maxCompetitors, maxPrompts } = job.data;
	// A job already on the queue when the gate closed must not spend either:
	// the request key carries which product asked, and the Selena suggestion is
	// the one whose spending is budget-classed.
	if (requestKey.startsWith("selena:")) {
		assertSuggestSpendAllowed();
		// Second refusal frontier of the monthly ceiling; the first is at
		// enqueue time in the web app.
		await assertSuggestBudget(db);
	}
	const suggestion = await analyzeBrand({ website, brandName, locationHint, maxCompetitors, maxPrompts });
	if (requestKey.startsWith("selena:")) {
		// Booked where the spending happened. Attribution follows the project
		// the request key names; a suggestion for a deleted project is still a
		// real charge, so the row is written best-effort and never voids the
		// suggestion itself.
		try {
			const projectId = requestKey.slice("selena:".length);
			const [project] = await db
				.select({ organizationId: svProjects.organizationId })
				.from(svProjects)
				.where(eq(svProjects.id, projectId))
				.limit(1);
			if (project) await recordSuggestCost(db, { organizationId: project.organizationId, provider: "onboarding-llm" });
		} catch (error) {
			console.error("[analyze-brand] suggest cost row not written:", error);
		}
	}
	return suggestion;
}

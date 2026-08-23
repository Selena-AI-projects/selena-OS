import { analyzeBrand, type OnboardingSuggestion } from "@workspace/lib/onboarding";
import { assertSuggestSpendAllowed } from "@workspace/lib/run-policy";
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
	if (requestKey.startsWith("selena:")) assertSuggestSpendAllowed();
	return analyzeBrand({ website, brandName, locationHint, maxCompetitors, maxPrompts });
}

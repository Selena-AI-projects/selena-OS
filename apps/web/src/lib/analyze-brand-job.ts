/**
 * Server-only helpers for the async brand-analysis job.
 *
 * All pg-boss coupling for the onboarding analysis lives here so the server
 * functions that use it stay thin (and free of direct db imports). The web app
 * enqueues the work and then polls the job's result *by request key* — the id
 * of whatever the analysis was started for (an Elmo brand, a Selena project).
 * Callers prove access to that record first, so a job's output never reaches
 * someone outside the org that asked for it.
 *
 * Reading the result goes straight at pg-boss's `pgboss.job` table rather than
 * `getJobById`, because the client polls by brand (not by an opaque job id it
 * has to round-trip). The columns used here (`name`, `data`, `state`,
 * `output`, `created_on`) are stable across the pinned pg-boss v12 line.
 */

import { db } from "@workspace/lib/db/db";
import { cleanOnboardingUrl, type OnboardingSuggestion, type QuestionStyle } from "@workspace/lib/onboarding";
import { sql } from "drizzle-orm";
import { getBoss } from "@/lib/boss-client";
import { extractDomain } from "@/lib/domain-categories";

const ANALYZE_BRAND_QUEUE = "analyze-brand";

/**
 * Shown to the user when a job ends in a failed/cancelled state. The real
 * error (provider messages, stack traces) is already captured server-side by
 * the worker's Sentry wrapper; we never forward it to the browser.
 */
const GENERIC_FAILURE = "Brand analysis failed. Please try again.";

/** Discriminated status returned to the wizard while it polls. */
export type AnalyzeBrandStatus =
	| { status: "pending" }
	| { status: "done"; suggestion: OnboardingSuggestion }
	| { status: "failed"; error: string };

/**
 * Which product a job belongs to. Both products key jobs by a UUID (Elmo by
 * brand id, Selena by project id), and a brand name can be shaped like a UUID,
 * so the raw ids share a namespace. The product prefix keeps one product from
 * reading or cancelling the other's job by guessing its id.
 */
export type AnalyzeBrandProduct = "elmo" | "selena";

export interface AnalyzeBrandInput {
	product: AnalyzeBrandProduct;
	/** Id the result is read back by. Must be access-checked by the caller. */
	requestKey: string;
	website: string;
	brandName?: string;
	/** Free-text place context; scopes competitors and prompts to the area. */
	locationHint?: string;
	maxCompetitors?: number;
	maxPrompts?: number;
	/** How suggested questions are phrased; the analyzer's default when unset. */
	questionStyle?: QuestionStyle;
}

/** The namespaced value actually stored in and queried from the job payload. */
function namespacedKey(product: AnalyzeBrandProduct, requestKey: string): string {
	return `${product}:${requestKey}`;
}

interface JobRow {
	id: string;
	state: string;
	data: { website?: string } | null;
	output: unknown;
}

/** The most recent analyze-brand job for a request key, regardless of state. */
async function latestJob(namespaced: string): Promise<JobRow | undefined> {
	const result = await db.execute(sql`
		SELECT id, state, data, output
		FROM pgboss.job
		WHERE name = ${ANALYZE_BRAND_QUEUE} AND data->>'requestKey' = ${namespaced}
		ORDER BY created_on DESC
		LIMIT 1
	`);
	return result.rows[0] as unknown as JobRow | undefined;
}

const IN_FLIGHT_STATES = new Set(["created", "active", "retry"]);

/**
 * The page an enqueued job will actually read. Two runs are "the same" only if
 * they research the same URL — `nike.com/golf` and `nike.com/running` share a
 * domain but produce completely different suggestions.
 */
function analysisKey(website: string): string {
	return cleanOnboardingUrl(website) || extractDomain(website);
}

/**
 * Enqueue a brand analysis, deduped by the request key + page it runs for.
 *
 * If an analysis for this page is already in flight we reuse it instead of
 * paying for a second run; once a job reaches a terminal state a fresh analysis
 * is allowed again (so "try again" works).
 *
 * We guard with an explicit in-flight check rather than pg-boss's `singletonKey`
 * because that would be a no-op here: `singleton_key` only enforces uniqueness
 * under a non-standard queue policy (short/singleton/stately) or with a
 * `singletonSeconds` window, and this queue uses the default `standard` policy
 * with no window. The check-then-send isn't atomic, but the analyze button is a
 * deliberate, low-frequency action (and disabled while running), so the worst
 * case — two near-simultaneous clicks racing past the check — is rare and
 * merely costs a duplicate run.
 */
export async function enqueueAnalyzeBrand(input: AnalyzeBrandInput): Promise<void> {
	const boss = await getBoss();
	const pageKey = analysisKey(input.website);

	const latest = await latestJob(namespacedKey(input.product, input.requestKey));
	if (latest && IN_FLIGHT_STATES.has(latest.state) && analysisKey(latest.data?.website ?? "") === pageKey) {
		return;
	}

	// Store the namespaced value so a poll/cancel for one product can never
	// match the other product's job, even when the raw ids are equal.
	await boss.send(ANALYZE_BRAND_QUEUE, {
		...input,
		requestKey: namespacedKey(input.product, input.requestKey),
	});
}

/** Poll the status/result of the latest brand-analysis job for a request key. */
export async function getAnalyzeBrandStatus(
	product: AnalyzeBrandProduct,
	requestKey: string,
): Promise<AnalyzeBrandStatus> {
	const job = await latestJob(namespacedKey(product, requestKey));

	// No job yet — the enqueue may not be visible, or the worker hasn't picked
	// it up. Either way the client should keep polling.
	if (!job) {
		return { status: "pending" };
	}
	if (job.state === "completed") {
		return { status: "done", suggestion: job.output as OnboardingSuggestion };
	}
	if (job.state === "failed" || job.state === "cancelled") {
		console.error("[analyze-brand] job ended without a result", {
			product,
			requestKey,
			jobId: job.id,
			state: job.state,
		});
		return { status: "failed", error: GENERIC_FAILURE };
	}
	return { status: "pending" };
}

/**
 * Best-effort cancel of an in-flight analysis. Used when the user backs out so
 * the worker doesn't keep grinding on a result nobody is waiting for.
 */
export async function cancelAnalyzeBrand(product: AnalyzeBrandProduct, requestKey: string): Promise<void> {
	const job = await latestJob(namespacedKey(product, requestKey));
	if (!job || !IN_FLIGHT_STATES.has(job.state)) {
		return;
	}
	const boss = await getBoss();
	try {
		await boss.cancel(ANALYZE_BRAND_QUEUE, job.id);
	} catch {
		// Job may have completed between the read and the cancel — nothing to do.
	}
}

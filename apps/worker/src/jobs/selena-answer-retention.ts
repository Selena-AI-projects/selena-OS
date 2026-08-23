import * as Sentry from "@sentry/node";
import { db } from "@workspace/lib/db/db";
import { expireAnswerTexts } from "@workspace/lib/selena-answer-retention";
import type { Job } from "pg-boss";

export interface SelenaAnswerRetentionData {
	source?: string;
}

/** Unset means off: deleting customer evidence is an owner decision. */
export function isAnswerRetentionEnabled(value: string | undefined): boolean {
	return value === "true";
}

/**
 * Deletes only the raw answer text whose retention window
 * (canonical_payload.answer.retainUntil, CABINET_MODEL §4a) has passed.
 * Findings, citations, sources and the response reference stay; each cleaned
 * run gets an ANSWER_TEXT_EXPIRED audit row.
 */
export async function selenaAnswerRetentionJob(jobs: Job<SelenaAnswerRetentionData>[]): Promise<void> {
	if (!isAnswerRetentionEnabled(process.env.SELENA_ANSWER_RETENTION_ENABLED)) {
		console.log("[selena-answer-retention] Skipped: SELENA_ANSWER_RETENTION_ENABLED is not 'true'");
		return;
	}
	for (const job of jobs) {
		const source = job.data?.source || "scheduled";
		try {
			const { expired } = await expireAnswerTexts(db);
			console.log(`[selena-answer-retention] Expired ${expired} answer texts (source: ${source})`);
		} catch (error) {
			console.error("[selena-answer-retention] Failed:", error);
			Sentry.captureException(error);
			throw error;
		}
	}
}

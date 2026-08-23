import { sql } from "drizzle-orm";
import type { db as defaultDb } from "./db/db";

type Executor = Pick<typeof defaultDb, "execute">;

/**
 * CABINET_MODEL §4a: the raw answer text lives in the run's canonical payload
 * for the owner's retention window and is then deleted — only the text.
 * Findings, citations, sources, the response reference and the retention
 * stamp itself all stay, so everything derived from the text outlives it and
 * the deletion is provable (`textDeletedAt` plus an audit row per run).
 *
 * The deletion works on the payload's own `answer.retainUntil`, written by the
 * adapter that stored the text — the job never invents a window of its own.
 */
export async function expireAnswerTexts(
	dbc: Executor,
	opts?: { now?: Date },
): Promise<{ expired: number }> {
	const now = opts?.now ?? new Date();
	const nowIso = now.toISOString();
	const result = await dbc.execute(sql`
		WITH expired AS (
			UPDATE sv_runs
			SET canonical_payload = jsonb_set(
				canonical_payload,
				'{answer}',
				(canonical_payload -> 'answer') - 'text' || jsonb_build_object('textDeletedAt', ${nowIso}::text)
			)
			WHERE canonical_payload -> 'answer' ? 'text'
				AND (canonical_payload -> 'answer' ->> 'retainUntil')::timestamptz < ${nowIso}::timestamptz
			RETURNING id, organization_id
		)
		INSERT INTO sv_audit_events (organization_id, actor_id, event, subject_kind, subject_id, details)
		SELECT organization_id, 'system:answer-retention', 'ANSWER_TEXT_EXPIRED', 'sv_runs', id::text,
			jsonb_build_object('deletedAt', ${nowIso}::text)
		FROM expired
		RETURNING id
	`);
	return { expired: result.rowCount ?? 0 };
}

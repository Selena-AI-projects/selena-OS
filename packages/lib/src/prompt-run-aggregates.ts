import { sql } from "drizzle-orm";
import type { db as defaultDb } from "./db/db";

type Executor = Pick<typeof defaultDb, "execute">;

/**
 * Roll one just-inserted prompt run into its hourly aggregate row. Call inside
 * the same transaction as the run insert so prompt_runs and the rollup can
 * never disagree about a committed run.
 */
export async function upsertPromptRunAggregate(
	tx: Executor,
	run: {
		promptId: string;
		brandId: string;
		model: string;
		provider: string | null;
		webSearchEnabled: boolean;
		createdAt: Date;
		brandMentioned: boolean;
	},
): Promise<void> {
	await tx.execute(sql`
		INSERT INTO prompt_run_hourly_aggregates
			(prompt_id, brand_id, model, provider, web_search_enabled, hour_bucket, total_runs, brand_mentioned_count)
		VALUES (
			${run.promptId}::uuid,
			${run.brandId},
			${run.model},
			${run.provider},
			${run.webSearchEnabled},
			date_trunc('hour', ${run.createdAt.toISOString()}::timestamptz),
			1,
			${run.brandMentioned ? 1 : 0}
		)
		ON CONFLICT (prompt_id, model, provider, web_search_enabled, hour_bucket) DO UPDATE
		SET total_runs = prompt_run_hourly_aggregates.total_runs + 1,
			brand_mentioned_count = prompt_run_hourly_aggregates.brand_mentioned_count + ${run.brandMentioned ? 1 : 0}
	`);
}

/**
 * Recompute the trailing window of aggregates straight from prompt_runs and
 * remove rollup rows whose runs disappeared. The same-transaction upsert keeps
 * the rollup current in normal operation; this catches drift from crashes,
 * manual deletes, or anything else that bypassed the write path. Windowed so
 * the cost stays bounded — the backfill migration owns history.
 */
export async function reconcilePromptRunAggregates(dbc: Executor, windowHours = 48): Promise<void> {
	const windowStart = sql`date_trunc('hour', now() - make_interval(hours => ${windowHours}::int))`;
	await dbc.execute(sql`
		INSERT INTO prompt_run_hourly_aggregates
			(prompt_id, brand_id, model, provider, web_search_enabled, hour_bucket, total_runs, brand_mentioned_count)
		SELECT
			prompt_id,
			brand_id,
			model,
			provider,
			web_search_enabled,
			date_trunc('hour', created_at),
			count(*)::int,
			count(*) FILTER (WHERE brand_mentioned)::int
		FROM prompt_runs
		WHERE created_at >= ${windowStart}
		GROUP BY prompt_id, brand_id, model, provider, web_search_enabled, date_trunc('hour', created_at)
		ON CONFLICT (prompt_id, model, provider, web_search_enabled, hour_bucket) DO UPDATE
		SET total_runs = excluded.total_runs,
			brand_mentioned_count = excluded.brand_mentioned_count
	`);
	await dbc.execute(sql`
		DELETE FROM prompt_run_hourly_aggregates agg
		WHERE agg.hour_bucket >= ${windowStart}
			AND NOT EXISTS (
				SELECT 1
				FROM prompt_runs r
				WHERE r.prompt_id = agg.prompt_id
					AND r.model = agg.model
					AND r.provider IS NOT DISTINCT FROM agg.provider
					AND r.web_search_enabled = agg.web_search_enabled
					AND date_trunc('hour', r.created_at) = agg.hour_bucket
			)
	`);
}

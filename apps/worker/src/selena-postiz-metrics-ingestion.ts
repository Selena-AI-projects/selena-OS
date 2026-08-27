import { randomUUID } from "node:crypto";
import {
	createPostizPerformanceSnapshot,
	type PostizAnalyticsPayload,
	type PostizPerformanceSnapshot,
} from "@workspace/lib/selena-postiz-ingestion";
import type { Pool, PoolClient } from "pg";

export type PostizAnalyticsReader = {
	getPostAnalytics(providerPostId: string): Promise<unknown>;
};

export type PostizPerformanceSnapshotInput = {
	brandId: string;
	capturedAt: string;
	organizationId: string;
	providerPostId: string;
	publicationAttemptId: string;
	windowEndedAt: string;
	windowStartedAt: string;
};

type IngestionPool = Pick<Pool, "connect">;
type IngestionClient = Pick<PoolClient, "query" | "release">;

function asAnalyticsPayload(value: unknown): PostizAnalyticsPayload {
	if (!Array.isArray(value)) throw new Error("Postiz analytics response is invalid");
	return value as PostizAnalyticsPayload;
}

/**
 * Fetches provider data only through the injected Gateway-owned adapter. This
 * worker module has no credential configuration and cannot call Postiz by itself.
 */
export async function collectPostizPerformanceSnapshot(
	reader: PostizAnalyticsReader,
	input: PostizPerformanceSnapshotInput,
): Promise<PostizPerformanceSnapshot> {
	if (!input.providerPostId) throw new Error("Postiz provider post ID is required");
	const payload = asAnalyticsPayload(await reader.getPostAnalytics(input.providerPostId));
	return createPostizPerformanceSnapshot({
		capturedAt: input.capturedAt,
		payload,
		publicationAttemptId: input.publicationAttemptId,
		windowEndedAt: input.windowEndedAt,
		windowStartedAt: input.windowStartedAt,
	});
}

async function withIngestionContext<T>(
	client: IngestionClient,
	input: Pick<PostizPerformanceSnapshotInput, "brandId" | "organizationId">,
	operation: () => Promise<T>,
): Promise<T> {
	await client.query("BEGIN");
	try {
		await client.query("SELECT selena_registry.set_request_context($1, $2, $3, $4, $5, $6, $7, NULL)", [
			"service:ingestion",
			input.organizationId,
			input.brandId,
			"service",
			randomUUID(),
			"ingestion",
			"service",
		]);
		const result = await operation();
		await client.query("COMMIT");
		return result;
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	}
}

/**
 * Persists raw provider evidence before its normalized metrics. The database
 * function checks that the publication attempt, account, organization, and
 * brand agree, and makes a repeated request key idempotent.
 */
export async function persistPostizPerformanceSnapshot(
	pool: IngestionPool,
	input: Pick<PostizPerformanceSnapshotInput, "brandId" | "organizationId" | "publicationAttemptId">,
	snapshot: PostizPerformanceSnapshot,
): Promise<{ metricSnapshotId: string; rawSnapshotId: string }> {
	const client = await pool.connect();
	try {
		return await withIngestionContext(client, input, async () => {
			const result = await client.query<{ metric_snapshot_id: string; raw_snapshot_id: string }>(
				`SELECT * FROM selena_ingest_raw.record_postiz_performance_snapshot(
					$1, $2, $3, $4, $5, $6, $7, $8, $9, $10
				)`,
				[
					input.publicationAttemptId,
					snapshot.requestKey,
					snapshot.windowStartedAt,
					snapshot.windowEndedAt,
					snapshot.capturedAt,
					JSON.stringify(snapshot.payload),
					snapshot.payloadSha256,
					snapshot.definitionVersion,
					snapshot.quality,
					JSON.stringify(snapshot.values),
				],
			);
			const row = result.rows[0];
			if (!row) throw new Error("Postiz performance snapshot was not persisted");
			return { metricSnapshotId: row.metric_snapshot_id, rawSnapshotId: row.raw_snapshot_id };
		});
	} finally {
		client.release();
	}
}

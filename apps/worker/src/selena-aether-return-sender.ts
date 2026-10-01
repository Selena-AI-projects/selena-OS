/**
 * Sends terminal content outcomes back to Aether (the return channel, P1-3).
 *
 * The forward path ends when the gateway records a verdict; two triggers then
 * enqueue that verdict into `selena_registry.aether_outcome_outbox`. This worker
 * drains that outbox and posts each outcome to Aether's inbound route, signed
 * with the shared return secret, so the task that produced the draft learns it
 * was published, refused, failed, or rejected.
 *
 * It mirrors the trigger dispatcher: it claims under the registry worker's own
 * identity, commits the lease before the network call, and records the result
 * in a second transaction — a crash leaves the row leased and it is retried once
 * the lease expires. Off unless SELENA_AETHER_RETURN_ENABLED is exactly `true`.
 */

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { setWorkerServiceSettings } from "@workspace/lib/content-workflow-projection";
import { assertDatabaseTlsVerified, requiresVerifiedDatabaseTls } from "@workspace/lib/db/staging-tls";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, canonicalJson } from "@workspace/lib/selena-aether-bridge";
import { Pool, type PoolClient } from "pg";

const LEASE_SECONDS = 300;
const RETURN_SCHEMA_VERSION = "1";
const RETURN_EVENT_TYPE = "content.outcome";

export type ClaimedOutcome = {
	id: string;
	eventId: string;
	outcome: string;
	aetherProjectId: string;
	aggregateId: string;
	taskId: string | null;
	contentKind: string | null;
	materialVersion: number;
	reference: string | null;
	detail: string | null;
	traceId: string | null;
	occurredAt: string;
	leaseOwner: string;
};

/** The wire shape posted to Aether; the whole of it is signed, keys and all. */
export function buildOutcomeEvent(outcome: ClaimedOutcome) {
	return {
		schema_version: RETURN_SCHEMA_VERSION,
		event_type: RETURN_EVENT_TYPE,
		event_id: outcome.eventId,
		project_id: outcome.aetherProjectId,
		task_id: outcome.taskId,
		aggregate_id: outcome.aggregateId,
		content_kind: outcome.contentKind,
		material_version: outcome.materialVersion,
		outcome: outcome.outcome,
		reference: outcome.reference,
		detail: outcome.detail,
		trace_id: outcome.traceId,
		occurred_at: outcome.occurredAt,
	};
}

export type ReturnSenderClient = { send(outcome: ClaimedOutcome): Promise<void> };

type ReturnConfig = { url: string; secret: string };

export function requiredReturnConfig(env = process.env): ReturnConfig | null {
	const url = env.AETHER_RETURN_URL;
	const secret = env.AETHER_RETURN_SECRET;
	if (!url && !secret) return null;
	if (!url || !secret)
		throw new Error("Aether return sender requires AETHER_RETURN_URL and AETHER_RETURN_SECRET together");
	if (!/^https:\/\//.test(url)) throw new Error("AETHER_RETURN_URL must use HTTPS");
	return { url: url.replace(/\/$/, ""), secret };
}

/**
 * Signs and posts one outcome. The signature covers `"{timestamp}.{body}"` over
 * the exact bytes sent, the same construction the forward receiver verifies.
 * Redirects are refused rather than followed, so a signed event cannot be
 * steered to another host.
 */
export function createReturnSenderClient(config: ReturnConfig, fetchFn: typeof fetch = fetch): ReturnSenderClient {
	return {
		async send(outcome) {
			const body = canonicalJson(buildOutcomeEvent(outcome));
			const timestamp = new Date().toISOString();
			const signature = createHmac("sha256", config.secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
			const response = await fetchFn(config.url, {
				method: "POST",
				redirect: "error",
				headers: {
					"content-type": "application/json",
					[SIGNATURE_HEADER]: signature,
					[TIMESTAMP_HEADER]: timestamp,
				},
				body,
			});
			if (!response.ok) throw new Error(`Aether return delivery failed with status ${response.status}`);
		},
	};
}

function createReturnWorkerPool(connectionString: string): Pool {
	assertDatabaseTlsVerified(connectionString);
	if (!requiresVerifiedDatabaseTls()) return new Pool({ connectionString });
	const url = new URL(connectionString);
	const certificatePath = url.searchParams.get("sslrootcert");
	if (!certificatePath) throw new Error("Aether return sender staging connection needs a root certificate");
	for (const name of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) url.searchParams.delete(name);
	return new Pool({
		connectionString: url.toString(),
		ssl: { ca: readFileSync(certificatePath, "utf8"), rejectUnauthorized: true },
	});
}

async function withWorkerContext<T>(client: PoolClient, task: () => Promise<T>): Promise<T> {
	await client.query("BEGIN");
	try {
		await setWorkerServiceSettings(client);
		const result = await task();
		await client.query("COMMIT");
		return result;
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	}
}

async function claimOutcome(pool: Pool): Promise<ClaimedOutcome | null> {
	const client = await pool.connect();
	try {
		return await withWorkerContext(client, async () => {
			const result = await client.query<{
				id: string;
				event_id: string;
				outcome: string;
				aether_project_id: string;
				aggregate_id: string;
				task_id: string | null;
				content_kind: string | null;
				material_version: number;
				reference: string | null;
				detail: string | null;
				trace_id: string | null;
				occurred_at: Date;
				lease_owner: string;
			}>("SELECT * FROM selena_registry.claim_next_aether_outcome($1)", [LEASE_SECONDS]);
			const row = result.rows[0];
			if (!row) return null;
			return {
				id: row.id,
				eventId: row.event_id,
				outcome: row.outcome,
				aetherProjectId: row.aether_project_id,
				aggregateId: row.aggregate_id,
				taskId: row.task_id,
				contentKind: row.content_kind,
				materialVersion: row.material_version,
				reference: row.reference,
				detail: row.detail,
				traceId: row.trace_id,
				occurredAt: row.occurred_at.toISOString(),
				leaseOwner: row.lease_owner,
			};
		});
	} finally {
		client.release();
	}
}

async function recordDelivered(pool: Pool, outcome: ClaimedOutcome): Promise<void> {
	const client = await pool.connect();
	try {
		await withWorkerContext(client, async () => {
			await client.query("SELECT selena_registry.record_aether_outcome_delivered($1, $2)", [
				outcome.id,
				outcome.leaseOwner,
			]);
		});
	} finally {
		client.release();
	}
}

async function retryOrDeadLetter(pool: Pool, outcome: ClaimedOutcome, error: unknown): Promise<void> {
	const client = await pool.connect();
	try {
		await withWorkerContext(client, async () => {
			const detail = error instanceof Error ? error.message : "Aether return delivery failed";
			await client.query("SELECT selena_registry.retry_or_dead_letter_aether_outcome($1, $2, $3)", [
				outcome.id,
				outcome.leaseOwner,
				detail,
			]);
		});
	} finally {
		client.release();
	}
}

export async function sendOneOutcome(pool: Pool, client: ReturnSenderClient): Promise<"IDLE" | "SENT" | "RETRIED"> {
	const outcome = await claimOutcome(pool);
	if (!outcome) return "IDLE";
	try {
		await client.send(outcome);
		await recordDelivered(pool, outcome);
		return "SENT";
	} catch (error) {
		await retryOrDeadLetter(pool, outcome, error);
		return "RETRIED";
	}
}

export function startSelenaAetherReturnSender(): (() => Promise<void>) | null {
	if (process.env.SELENA_AETHER_RETURN_ENABLED !== "true") return null;
	const config = requiredReturnConfig();
	if (!config) {
		throw new Error("SELENA_AETHER_RETURN_ENABLED is true but AETHER_RETURN_URL/AETHER_RETURN_SECRET are not set");
	}
	const connectionString = process.env.SELENA_REGISTRY_WORKER_DATABASE_URL ?? process.env.DATABASE_URL;
	if (!connectionString) {
		throw new Error("SELENA_REGISTRY_WORKER_DATABASE_URL or DATABASE_URL is required for the Aether return sender");
	}
	const pool = createReturnWorkerPool(connectionString);
	const client = createReturnSenderClient(config);
	let running = false;
	const tick = async () => {
		if (running) return;
		running = true;
		try {
			while ((await sendOneOutcome(pool, client)) !== "IDLE") undefined;
		} catch (error) {
			// Fired from a timer with no awaiter: a throw here would be an unhandled
			// rejection that crashes the worker. Log it and let the next tick retry.
			console.error("Selena Aether return sender tick failed", error);
		} finally {
			running = false;
		}
	};
	const interval = setInterval(() => void tick(), 5_000);
	void tick();
	return async () => {
		clearInterval(interval);
		await pool.end();
	};
}

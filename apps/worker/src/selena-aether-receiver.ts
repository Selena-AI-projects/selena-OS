/**
 * HTTP receiver for the Aether → Control Room bridge.
 *
 * A separate runtime on purpose. It is the only component that faces the public
 * internet with a shared secret, and it holds the ingestion identity, which can
 * record an event and nothing else: the recording function is its entire reach
 * into the database. A defect here therefore cannot read release manifests,
 * publish anything, or touch a table directly.
 *
 * Verification happens before the body is parsed, so an unsigned body is never
 * interpreted. Everything the sender says about itself — project, task, version,
 * payload — is data, never an instruction.
 */
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { assertStagingDatabaseTls } from "@workspace/lib/db/staging-tls";
import {
	acceptEvent,
	type EventEnvelope,
	EventRejected,
	MAX_EVENT_BODY_BYTES,
	SIGNATURE_HEADER,
	TIMESTAMP_HEADER,
} from "@workspace/lib/selena-aether-bridge";
import { Pool, type PoolClient } from "pg";

const RECEIVE_PATH = "/v1/bridge/aether";
// Since contract 1.1 an event may carry a whole material. The limit is the
// contract's: it sits above the largest envelope the contract can describe, and
// a body beyond it is not an event this receiver is meant to accept.
const MAX_BODY_BYTES = MAX_EVENT_BODY_BYTES;
// The recording function refuses a version redelivered with different content,
// or an event id reused for different content, with this SQLSTATE.
const CONFLICT_SQLSTATE = "SE409";

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required for the Aether receiver`);
	return value;
}

/** Comma-separated so the shared secret can be rotated without a gap. */
export function receiverSecrets(raw: string): string[] {
	const secrets = raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	if (secrets.length === 0) throw new Error("SELENA_AETHER_BRIDGE_SECRET is empty");
	return secrets;
}

function createReceiverPool(connectionString: string): Pool {
	const isStagingMvp = process.env.SELENA_STAGING_MVP === "true";
	assertStagingDatabaseTls(connectionString, isStagingMvp);
	if (!isStagingMvp) return new Pool({ connectionString });
	const url = new URL(connectionString);
	const certificatePath = url.searchParams.get("sslrootcert");
	if (!certificatePath) throw new Error("Aether receiver staging connection needs a root certificate");
	for (const name of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) url.searchParams.delete(name);
	return new Pool({
		connectionString: url.toString(),
		ssl: { ca: readFileSync(certificatePath, "utf8"), rejectUnauthorized: true },
	});
}

export type RecordOutcome = "recorded" | "duplicate" | "stale";

export class RecordConflict extends Error {
	constructor() {
		super("event conflicts with what was already recorded");
		this.name = "RecordConflict";
	}
}

/**
 * The recording function decides the outcome, not this process: duplicate and
 * stale are answered from the rows already stored, so two receivers running at
 * once cannot disagree about which event won.
 */
export async function recordEvent(client: PoolClient, envelope: EventEnvelope): Promise<RecordOutcome> {
	await client.query("BEGIN");
	try {
		await client.query("SELECT set_config('app.selena_service_identity', 'ingestion', true)");
		await client.query("SELECT set_config('app.selena_auth_type', 'service', true)");
		const recorded = await client.query<{ outcome: RecordOutcome }>(
			"SELECT outcome FROM selena_ingest_raw.record_aether_event($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)",
			[
				envelope.event_id,
				envelope.event_type,
				envelope.schema_version,
				envelope.project_id,
				envelope.aggregate_id,
				envelope.version,
				envelope.occurred_at,
				envelope.trace_id,
				JSON.stringify(envelope.payload),
				envelope.payload_hash,
			],
		);
		await client.query("COMMIT");
		const outcome = recorded.rows[0]?.outcome;
		if (!outcome) throw new Error("the recording function returned no outcome");
		return outcome;
	} catch (error) {
		await client.query("ROLLBACK");
		if ((error as { code?: unknown })?.code === CONFLICT_SQLSTATE) throw new RecordConflict();
		throw error;
	}
}

async function readBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > MAX_BODY_BYTES) throw new EventRejected("body", "event body is too large");
		chunks.push(buffer);
	}
	// The signature covers these exact bytes, so the body is kept as received
	// and only decoded once — re-serializing it would verify something else.
	return Buffer.concat(chunks).toString("utf8");
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
	const value = request.headers[name];
	return Array.isArray(value) ? value[0] : value;
}

function sendJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
	response.writeHead(status, { "cache-control": "no-store", "content-type": "application/json" });
	response.end(JSON.stringify(body));
}

/**
 * An unauthenticated caller learns only that it was refused; a caller holding a
 * live secret gets the specific reason, because that is the sender debugging a
 * contract mismatch rather than someone probing.
 */
function statusFor(reason: EventRejected["reason"]): number {
	return reason === "signature" || reason === "timestamp" ? 401 : 400;
}

/** A minimal view of the pool, so the request handling can be driven in a test. */
export interface ReceiverPool {
	connect(): Promise<PoolClient>;
	end(): Promise<void>;
}

export function createReceiverServer(options: { secrets: string[]; pool: ReceiverPool }): Server {
	const { secrets, pool } = options;
	return createServer(async (request, response) => {
		if (request.url === "/healthz" && request.method === "GET") return sendJson(response, 200, { status: "ok" });
		if (request.url !== RECEIVE_PATH) return sendJson(response, 404, { error: "not_found" });
		if (request.method !== "POST") return sendJson(response, 405, { error: "method_not_allowed" });

		let body: string;
		try {
			body = await readBody(request);
		} catch (error) {
			const reason = error instanceof EventRejected ? error.reason : "body";
			return sendJson(response, 413, { error: "rejected", reason });
		}

		let envelope: EventEnvelope;
		try {
			envelope = acceptEvent(
				body,
				{ signature: headerValue(request, SIGNATURE_HEADER), timestamp: headerValue(request, TIMESTAMP_HEADER) },
				secrets,
			).envelope;
		} catch (error) {
			if (error instanceof EventRejected) {
				return sendJson(response, statusFor(error.reason), { error: "rejected", reason: error.reason });
			}
			throw error;
		}

		const client = await pool.connect();
		try {
			const outcome = await recordEvent(client, envelope);
			// Identifiers and the verdict, never the payload: an operator needs to
			// know that a redelivery was recognised as one, and answering that from
			// the log should not mean reading the event's contents out of it.
			console.log(
				`aether event ${outcome}: event=${envelope.event_id} aggregate=${envelope.aggregate_id} version=${envelope.version} trace=${envelope.trace_id}`,
			);
			// Duplicate and stale are acknowledged, not retried: the sender has
			// nothing left to do, and an error would keep an already-delivered
			// event circling until its attempts ran out.
			return sendJson(response, 202, { outcome, event_id: envelope.event_id });
		} catch (error) {
			if (error instanceof RecordConflict) {
				// Not a retry and not a server fault: the sender delivered a version
				// that disagrees with what was recorded. Retrying cannot fix that.
				console.warn(
					`aether event conflict: event=${envelope.event_id} aggregate=${envelope.aggregate_id} version=${envelope.version} trace=${envelope.trace_id}`,
				);
				return sendJson(response, 409, { error: "rejected", reason: "conflict", event_id: envelope.event_id });
			}
			// The sender must retry, so this is a server error — but its text
			// stays here rather than travelling back across the bridge.
			console.error("Aether receiver could not record an event", error);
			return sendJson(response, 500, { error: "not_recorded" });
		} finally {
			client.release();
		}
	});
}

export async function startSelenaAetherReceiver(): Promise<void> {
	const secrets = receiverSecrets(requiredEnv("SELENA_AETHER_BRIDGE_SECRET"));
	const pool = createReceiverPool(requiredEnv("SELENA_INGESTION_DATABASE_URL"));
	const port = Number.parseInt(process.env.SELENA_RECEIVER_PORT ?? "8083", 10);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SELENA_RECEIVER_PORT is invalid");

	const server = createReceiverServer({ secrets, pool });
	server.listen(port, "0.0.0.0");
	const shutdown = async () => {
		server.close();
		await pool.end();
		process.exit(0);
	};
	process.once("SIGTERM", () => void shutdown());
	process.once("SIGINT", () => void shutdown());
}

if (process.argv[1]?.endsWith("selena-aether-receiver.ts")) {
	startSelenaAetherReceiver().catch((error) => {
		console.error(error instanceof Error ? error.message : "Aether receiver failed to start");
		process.exit(1);
	});
}

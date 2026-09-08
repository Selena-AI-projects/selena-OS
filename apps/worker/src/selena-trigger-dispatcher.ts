import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { assertDatabaseTlsVerified, requiresVerifiedDatabaseTls } from "@workspace/lib/db/staging-tls";
import { createOpaqueWorkflowPayload } from "@workspace/lib/selena-control-room";
import { Pool, type PoolClient } from "pg";
import {
	createReleaseGatewayClient,
	type ReleaseGatewayClient,
	requiredGatewayConfig,
} from "./selena-release-gateway-client";

const WORKFLOW_QUEUE_CONTEXT = { organizationId: "__outbox_queue__", brandId: "__outbox_queue__" };
const SELENA_TRIGGER_TASK_ID = "selena-release-workflow";

type ClaimedOutbox = {
	attemptCount: number;
	brandId: string;
	correlationId: string;
	idempotencyKey: string;
	leaseOwner: string;
	organizationId: string;
	outboxEventId: string;
	releaseIntentId: string;
};

export type TriggerWorkflowClient = {
	trigger(input: {
		concurrencyKey: string;
		idempotencyKey: string;
		payload: ReturnType<typeof createOpaqueWorkflowPayload>;
	}): Promise<string>;
};

type CarryInput = {
	concurrencyKey: string;
	idempotencyKey: string;
	payload: ReturnType<typeof createOpaqueWorkflowPayload>;
};

/**
 * How a claimed release left the queue.
 *
 * `RUNNING` means the carry only started the work and something else will
 * finish it; the terminal states mean the release reached its conclusion
 * before the queue entry was closed. The conclusion itself — accepted,
 * refused, rejected — is recorded by the gateway in the publication attempt,
 * not here.
 */
export type ReleaseCarry = {
	reference: string;
	state: "RUNNING" | "COMPLETED" | "FAILED" | "RECONCILIATION_REQUIRED";
};

export type ReleaseCarrier = { carry(input: CarryInput): Promise<ReleaseCarry> };

export function createTriggerCarrier(client: TriggerWorkflowClient): ReleaseCarrier {
	return {
		async carry(input) {
			return { reference: await client.trigger(input), state: "RUNNING" };
		},
	};
}

/**
 * Carries a release through the gateway in this process.
 *
 * Every answer the gateway can give about a release is a conclusion, so the
 * queue entry closes either way: retrying a rejected release would post
 * nothing, and retrying an ambiguous one is how a post appears twice. Only a
 * gateway that could not be reached or is not configured leaves the entry to
 * be tried again.
 */
export function createGatewayReleaseCarrier(gateway: ReleaseGatewayClient): ReleaseCarrier {
	return {
		async carry(input) {
			const manifest = await gateway.signManifest(input.payload.releaseIntentId);
			const report = await gateway.dispatch({
				idempotencyKey: input.idempotencyKey,
				manifestId: manifest.manifestId,
			});
			if (report.outcome === "NOT_CONFIGURED") {
				throw new Error(`Release Gateway has no provider configured: ${report.missing.join(", ")}`);
			}
			if (report.outcome === "ACCEPTED") return { reference: report.providerReferenceId, state: "COMPLETED" };
			if (report.outcome === "SKIPPED") return { reference: report.reservationId, state: "COMPLETED" };
			if (report.outcome === "AMBIGUOUS") return { reference: manifest.manifestId, state: "RECONCILIATION_REQUIRED" };
			return { reference: manifest.manifestId, state: "FAILED" };
		},
	};
}

type TriggerClientConfig = {
	apiUrl: string;
	secretKey: string;
	taskId: string;
};

function requiredTriggerConfig(env = process.env): TriggerClientConfig | null {
	const secretKey = env.TRIGGER_SECRET_KEY;
	const taskId = env.SELENA_TRIGGER_TASK_ID;
	const apiUrl = env.SELENA_TRIGGER_API_URL;
	if (!secretKey && !taskId && !apiUrl) return null;
	if (!secretKey || !taskId || !apiUrl)
		throw new Error(
			"Trigger dispatcher requires TRIGGER_SECRET_KEY, SELENA_TRIGGER_TASK_ID, and SELENA_TRIGGER_API_URL together",
		);
	if (!/^https:\/\//.test(apiUrl)) throw new Error("SELENA_TRIGGER_API_URL must use HTTPS");
	return { apiUrl: apiUrl.replace(/\/$/, ""), secretKey, taskId };
}

export function createTriggerDevClient(
	config: TriggerClientConfig,
	fetchFn: typeof fetch = fetch,
): TriggerWorkflowClient {
	return {
		async trigger(input) {
			const response = await fetchFn(`${config.apiUrl}/api/v1/tasks/${encodeURIComponent(config.taskId)}/trigger`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${config.secretKey}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					payload: input.payload,
					context: { correlationId: input.payload.correlationId, source: "selena-outbox" },
					options: {
						concurrencyKey: input.concurrencyKey,
						idempotencyKey: input.idempotencyKey,
						queue: { name: "selena-release", concurrencyLimit: 1 },
					},
				}),
			});
			if (!response.ok) throw new Error(`Trigger workflow dispatch failed with status ${response.status}`);
			const body = (await response.json()) as { id?: unknown };
			if (typeof body.id !== "string" || body.id.length === 0)
				throw new Error("Trigger workflow dispatch returned no run ID");
			return body.id;
		},
	};
}

function createRegistryWorkerPool(connectionString: string): Pool {
	assertDatabaseTlsVerified(connectionString);
	if (!requiresVerifiedDatabaseTls()) return new Pool({ connectionString });
	const url = new URL(connectionString);
	const certificatePath = url.searchParams.get("sslrootcert");
	if (!certificatePath) throw new Error("Selena Trigger dispatcher staging connection needs a root certificate");
	for (const name of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) url.searchParams.delete(name);
	return new Pool({
		connectionString: url.toString(),
		ssl: { ca: readFileSync(certificatePath, "utf8"), rejectUnauthorized: true },
	});
}

async function withWorkerContext<T>(client: PoolClient, task: () => Promise<T>): Promise<T> {
	await client.query("BEGIN");
	try {
		await client.query("SELECT selena_registry.set_request_context($1, $2, $3, $4, $5, $6, $7, NULL)", [
			"service:registry-worker",
			WORKFLOW_QUEUE_CONTEXT.organizationId,
			WORKFLOW_QUEUE_CONTEXT.brandId,
			"service",
			randomUUID(),
			"registry_worker",
			"service",
		]);
		const result = await task();
		await client.query("COMMIT");
		return result;
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	}
}

async function claimOutbox(pool: Pool): Promise<ClaimedOutbox | null> {
	const client = await pool.connect();
	try {
		return await withWorkerContext(client, async () => {
			const result = await client.query<{
				outbox_event_id: string;
				release_intent_id: string;
				organization_id: string;
				brand_id: string;
				correlation_id: string;
				idempotency_key: string;
				attempt_count: number;
				lease_owner: string;
			}>("SELECT * FROM selena_release.claim_next_trigger_outbox($1)", [300]);
			const row = result.rows[0];
			if (!row) return null;
			return {
				outboxEventId: row.outbox_event_id,
				releaseIntentId: row.release_intent_id,
				organizationId: row.organization_id,
				brandId: row.brand_id,
				correlationId: row.correlation_id,
				idempotencyKey: row.idempotency_key,
				attemptCount: row.attempt_count,
				leaseOwner: row.lease_owner,
			};
		});
	} finally {
		client.release();
	}
}

async function recordDispatch(pool: Pool, outbox: ClaimedOutbox, carry: ReleaseCarry): Promise<void> {
	const client = await pool.connect();
	try {
		await withWorkerContext(client, async () => {
			if (carry.state === "RUNNING") {
				await client.query("SELECT * FROM selena_release.record_trigger_workflow_dispatch($1, $2, $3)", [
					outbox.outboxEventId,
					outbox.leaseOwner,
					carry.reference,
				]);
				return;
			}
			await client.query("SELECT * FROM selena_release.record_direct_release_dispatch($1, $2, $3, $4)", [
				outbox.outboxEventId,
				outbox.leaseOwner,
				carry.reference,
				carry.state,
			]);
		});
	} finally {
		client.release();
	}
}

async function retryOrDeadLetter(pool: Pool, outbox: ClaimedOutbox, error: unknown): Promise<void> {
	const client = await pool.connect();
	try {
		await withWorkerContext(client, async () => {
			const detail = error instanceof Error ? error.message : "Trigger workflow dispatch failed";
			await client.query("SELECT selena_release.retry_or_dead_letter_trigger_outbox($1, $2, $3)", [
				outbox.outboxEventId,
				outbox.leaseOwner,
				detail,
			]);
		});
	} finally {
		client.release();
	}
}

export async function dispatchOneTriggerWorkflow(
	pool: Pool,
	carrier: ReleaseCarrier,
): Promise<"IDLE" | "DISPATCHED" | "RETRIED"> {
	const outbox = await claimOutbox(pool);
	if (!outbox) return "IDLE";
	try {
		const carry = await carrier.carry({
			concurrencyKey: `brand:${outbox.brandId}`,
			idempotencyKey: outbox.idempotencyKey,
			payload: createOpaqueWorkflowPayload({
				correlationId: outbox.correlationId,
				releaseIntentId: outbox.releaseIntentId,
			}),
		});
		await recordDispatch(pool, outbox, carry);
		return "DISPATCHED";
	} catch (error) {
		await retryOrDeadLetter(pool, outbox, error);
		return "RETRIED";
	}
}

/**
 * Which transport carries an approved release, chosen by what is configured.
 *
 * A contour with neither is not broken, but it does queue releases nobody will
 * ever carry, so it says so once instead of starting in silence.
 */
function releaseCarrier(): ReleaseCarrier | null {
	const trigger = requiredTriggerConfig();
	if (trigger) return createTriggerCarrier(createTriggerDevClient(trigger));
	const gateway = requiredGatewayConfig();
	if (gateway) return createGatewayReleaseCarrier(createReleaseGatewayClient(gateway));
	console.warn("selena_release: no release carrier is configured; approved releases will wait in the queue");
	return null;
}

export function startSelenaTriggerDispatcher(): (() => Promise<void>) | null {
	const carrier = releaseCarrier();
	if (!carrier) return null;
	// The queue functions identify their caller by the role it connects as, and
	// they refuse a session that looks like more than one runtime at once — which
	// is exactly how an administrative connection looks, since it is a member of
	// every role. The dispatcher therefore takes its own connection string under
	// `selena_worker_login`, the way the web runtime already takes one under
	// `selena_web_login`, and falls back to the shared one only where no separate
	// login was provisioned.
	const connectionString = process.env.SELENA_REGISTRY_WORKER_DATABASE_URL ?? process.env.DATABASE_URL;
	if (!connectionString) {
		throw new Error("SELENA_REGISTRY_WORKER_DATABASE_URL or DATABASE_URL is required for the release dispatcher");
	}
	const pool = createRegistryWorkerPool(connectionString);
	let running = false;
	const tick = async () => {
		if (running) return;
		running = true;
		try {
			while ((await dispatchOneTriggerWorkflow(pool, carrier)) === "DISPATCHED") undefined;
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

export { SELENA_TRIGGER_TASK_ID };

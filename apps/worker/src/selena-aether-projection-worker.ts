/**
 * Projects accepted Aether material events into Control Room content versions.
 *
 * A separate runtime from the receiver on purpose: the receiver faces the public
 * internet and can only record events; this worker faces nothing and can only
 * read recorded events and write content under the registry worker role, in the
 * brand context it resolves through the owner's binding. Every step is one
 * transaction — claim, resolve, write, mark — so a crash leaves the event
 * unclaimed rather than half-projected, and a repeat finds what is already there.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	appendWorkerAudit,
	type ClaimedDraftEvent,
	claimNextDraftEvent,
	createDraftVersion,
	currentPolicyVersion,
	deferProjection,
	enterBrandContext,
	markProjected,
	resolveBinding,
	setWorkerServiceSettings,
} from "@workspace/lib/content-workflow-repositories";
import { assertStagingDatabaseTls } from "@workspace/lib/db/staging-tls";
import { type EventEnvelope, EventRejected, parseEnvelope } from "@workspace/lib/selena-aether-bridge";
import {
	type ProjectionErrorCode,
	ProjectionRejected,
	projectDraftEvent,
} from "@workspace/lib/selena-aether-projection";
import { Pool, type PoolClient } from "pg";

export const SOURCE_ENVIRONMENTS = ["local", "staging", "production"] as const;
export type SourceEnvironment = (typeof SOURCE_ENVIRONMENTS)[number];

export function isProjectionEnabled(env: { GROWTH_ENGINE_STAGE1_ENABLED?: string } = process.env): boolean {
	// Fail closed on anything but the exact string, like every other Selena flag.
	return env.GROWTH_ENGINE_STAGE1_ENABLED === "true";
}

export function sourceEnvironmentFrom(value: string | undefined): SourceEnvironment {
	if (!value || !(SOURCE_ENVIRONMENTS as readonly string[]).includes(value)) {
		throw new Error("SELENA_GROWTH_SOURCE_ENVIRONMENT must be one of local, staging, production");
	}
	return value as SourceEnvironment;
}

export type ProjectionOutcome =
	| { kind: "idle" }
	| { kind: "projected"; eventId: string; contentVersionId: string; created: boolean }
	| { kind: "refused"; eventId: string; code: ProjectionErrorCode }
	| { kind: "deferred"; eventId: string; code: ProjectionErrorCode; nextAttemptAt: Date };

/**
 * What the owner can still supply is not a verdict on the material: a project
 * bound tomorrow, or a policy written tomorrow, must still receive the drafts
 * that arrived today, and the sender will not repeat unchanged material.
 */
const DEFERRABLE_CODES: ReadonlySet<ProjectionErrorCode> = new Set(["NO_BINDING", "NO_CONTENT_POLICY"]);

/** A minimal view of the pool, so a test can drive the worker with its own client. */
export interface WorkerPool {
	connect(): Promise<PoolClient>;
	end(): Promise<void>;
}

function envelopeFrom(event: ClaimedDraftEvent): EventEnvelope {
	// The stored columns are the accepted envelope; rebuilding it and running it
	// through the same parser the receiver used means a row that was somehow
	// altered in the database is refused here rather than projected.
	const envelope = {
		schema_version: event.schemaVersion,
		event_id: event.eventId,
		event_type: "content.draft_ready",
		project_id: event.sourceProjectId,
		aggregate_id: event.aggregateId,
		version: event.version,
		occurred_at: event.occurredAt,
		trace_id: event.traceId,
		payload: event.payload,
		payload_hash: event.payloadSha256,
	};
	return parseEnvelope(JSON.stringify(envelope));
}

/**
 * One claimed event, start to finish, in one transaction. Returns what happened
 * so the loop can log it; never throws for a refusal, only for a fault that
 * should leave the event unclaimed.
 */
export async function projectOnce(pool: WorkerPool, sourceEnvironment: SourceEnvironment): Promise<ProjectionOutcome> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await setWorkerServiceSettings(client);
		const event = await claimNextDraftEvent(client);
		if (!event) {
			await client.query("ROLLBACK");
			return { kind: "idle" };
		}

		const refuse = async (code: ProjectionErrorCode): Promise<ProjectionOutcome> => {
			if (DEFERRABLE_CODES.has(code)) {
				const nextAttemptAt = await deferProjection(client, event.eventRowId, code);
				await client.query("COMMIT");
				return { kind: "deferred", eventId: event.eventId, code, nextAttemptAt };
			}
			await markProjected(client, event.eventRowId, { error: code });
			await client.query("COMMIT");
			return { kind: "refused", eventId: event.eventId, code };
		};

		let envelope: EventEnvelope;
		try {
			envelope = envelopeFrom(event);
		} catch (error) {
			if (error instanceof EventRejected) return refuse("PROJECTION_FAILED");
			throw error;
		}

		const binding = await resolveBinding(client, event.sourceProjectId, sourceEnvironment);
		if (!binding) return refuse("NO_BINDING");

		await enterBrandContext(client, binding, randomUUID());
		const policyVersion = await currentPolicyVersion(client, binding);
		if (!policyVersion) return refuse("NO_CONTENT_POLICY");

		let input: ReturnType<typeof projectDraftEvent>;
		try {
			input = projectDraftEvent(envelope, binding, policyVersion);
		} catch (error) {
			if (error instanceof ProjectionRejected) return refuse(error.code);
			throw error;
		}

		const ref = await createDraftVersion(client, input);
		await appendWorkerAudit(client, {
			organizationId: binding.organizationId,
			brandId: binding.brandId,
			action: ref.created ? "content.draft_received" : "content.draft_repeated",
			aggregateType: "content_version",
			aggregateId: ref.contentVersionId,
			// Identifiers, hashes and flags only: the body, claims and QA text stay in
			// the version row, never in the audit chain.
			metadata: {
				eventId: event.eventId,
				aggregateId: event.aggregateId,
				version: event.version,
				contentHash: input.contentHash,
				kind: input.kind,
				briefRef: input.briefRef,
				synthetic: input.disclosure.synthetic,
				qaFailed: input.disclosure.qa_failed,
				needsVerification: input.disclosure.needs_verification,
				traceId: event.traceId,
			},
		});
		await markProjected(client, event.eventRowId, { contentVersionId: ref.contentVersionId });
		await client.query("COMMIT");
		return { kind: "projected", eventId: event.eventId, contentVersionId: ref.contentVersionId, created: ref.created };
	} catch (error) {
		await client.query("ROLLBACK").catch(() => undefined);
		throw error;
	} finally {
		client.release();
	}
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required for the Aether projection worker`);
	return value;
}

function createWorkerPool(connectionString: string): Pool {
	const isStagingMvp = process.env.SELENA_STAGING_MVP === "true";
	assertStagingDatabaseTls(connectionString, isStagingMvp);
	if (!isStagingMvp) return new Pool({ connectionString });
	const url = new URL(connectionString);
	const certificatePath = url.searchParams.get("sslrootcert");
	if (!certificatePath) throw new Error("Aether projection worker staging connection needs a root certificate");
	for (const name of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) url.searchParams.delete(name);
	return new Pool({
		connectionString: url.toString(),
		ssl: { ca: readFileSync(certificatePath, "utf8"), rejectUnauthorized: true },
	});
}

export async function runProjectionLoop(options: {
	pool: WorkerPool;
	sourceEnvironment: SourceEnvironment;
	idleDelayMs?: number;
	signal?: AbortSignal;
}): Promise<void> {
	const idleDelayMs = options.idleDelayMs ?? 5_000;
	while (!options.signal?.aborted) {
		let outcome: ProjectionOutcome;
		try {
			outcome = await projectOnce(options.pool, options.sourceEnvironment);
		} catch (error) {
			console.error("Aether projection worker failed a cycle", error instanceof Error ? error.message : error);
			await new Promise((resolve) => setTimeout(resolve, idleDelayMs));
			continue;
		}
		if (outcome.kind === "idle") {
			await new Promise((resolve) => setTimeout(resolve, idleDelayMs));
			continue;
		}
		// Identifiers and the verdict, never content.
		if (outcome.kind === "projected") {
			console.log(
				`aether material ${outcome.created ? "projected" : "already projected"}: event=${outcome.eventId} version=${outcome.contentVersionId}`,
			);
		} else if (outcome.kind === "deferred") {
			console.warn(
				`aether material deferred: event=${outcome.eventId} code=${outcome.code} next=${outcome.nextAttemptAt.toISOString()}`,
			);
		} else {
			console.warn(`aether material refused: event=${outcome.eventId} code=${outcome.code}`);
		}
	}
}

export async function startSelenaAetherProjectionWorker(): Promise<void> {
	if (!isProjectionEnabled()) {
		console.log("Aether projection worker is disabled (GROWTH_ENGINE_STAGE1_ENABLED is not exactly true); exiting");
		return;
	}
	const sourceEnvironment = sourceEnvironmentFrom(process.env.SELENA_GROWTH_SOURCE_ENVIRONMENT);
	const pool = createWorkerPool(requiredEnv("DATABASE_URL"));
	const controller = new AbortController();
	const shutdown = async () => {
		controller.abort();
		await pool.end();
		process.exit(0);
	};
	process.once("SIGTERM", () => void shutdown());
	process.once("SIGINT", () => void shutdown());
	await runProjectionLoop({ pool, sourceEnvironment, signal: controller.signal });
}

if (process.argv[1]?.endsWith("selena-aether-projection-worker.ts")) {
	startSelenaAetherProjectionWorker().catch((error) => {
		console.error(error instanceof Error ? error.message : "Aether projection worker failed to start");
		process.exit(1);
	});
}

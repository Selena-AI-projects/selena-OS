import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { assertDatabaseTlsVerified, requiresVerifiedDatabaseTls } from "@workspace/lib/db/staging-tls";
import {
	assertImmutablePublicationPackage,
	ensureGatewaySigningKey,
	signReleaseManifest,
} from "@workspace/lib/selena-release-gateway";
import { configureReleaseProviders } from "@workspace/lib/selena-release-providers";
import { Pool, type PoolClient } from "pg";
import { dispatchReleaseManifest, type GatewayQuery } from "./selena-release-dispatch";

const GATEWAY_CONTEXT = { organizationId: "__gateway__", brandId: "__gateway__" };

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required for the Selena Release Gateway`);
	return value;
}

export function isGatewayAuthorizationValid(expected: string, provided: string | undefined): boolean {
	if (!provided) return false;
	const expectedBytes = Buffer.from(expected);
	const providedBytes = Buffer.from(provided);
	return expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes);
}

function createGatewayPool(connectionString: string): Pool {
	assertDatabaseTlsVerified(connectionString);
	if (!requiresVerifiedDatabaseTls()) return new Pool({ connectionString });
	const url = new URL(connectionString);
	const certificatePath = url.searchParams.get("sslrootcert");
	if (!certificatePath) throw new Error("Selena Gateway staging connection needs a root certificate");
	for (const name of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) url.searchParams.delete(name);
	return new Pool({
		connectionString: url.toString(),
		ssl: { ca: readFileSync(certificatePath, "utf8"), rejectUnauthorized: true },
	});
}

async function withGatewayContext<T>(
	client: PoolClient,
	task: () => Promise<T>,
	releaseManifestId: string | null = null,
): Promise<T> {
	await client.query("BEGIN");
	try {
		await client.query("SELECT selena_registry.set_request_context($1, $2, $3, $4, $5, $6, $7, NULL)", [
			"service:gateway",
			GATEWAY_CONTEXT.organizationId,
			GATEWAY_CONTEXT.brandId,
			"service",
			randomUUID(),
			"gateway",
			"service",
			releaseManifestId,
		]);
		const result = await task();
		await client.query("COMMIT");
		return result;
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	}
}

async function createSignedManifest(input: {
	pool: Pool;
	privateKey: string;
	releaseIntentId: string;
	signingKeyVersion: string;
}): Promise<{ expiresAt: string; manifestId: string; manifestHash: string }> {
	const client = await input.pool.connect();
	try {
		return await withGatewayContext(client, async () => {
			const prepared = await client.query<{ package: unknown }>(
				"SELECT selena_release.build_gateway_release_package($1) AS package",
				[input.releaseIntentId],
			);
			const manifest = prepared.rows[0]?.package;
			assertImmutablePublicationPackage(manifest);
			const signed = signReleaseManifest(manifest, input.privateKey);
			const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
			const recorded = await client.query<{ id: string; manifest_hash: string; expires_at: Date }>(
				`SELECT * FROM selena_release.record_gateway_release_manifest($1, $2::jsonb, $3, $4, $5, $6, $7, $8)`,
				[
					input.releaseIntentId,
					JSON.stringify(manifest),
					signed.canonicalManifest,
					signed.manifestHash,
					signed.signatureAlgorithm,
					input.signingKeyVersion,
					signed.signature,
					expiresAt,
				],
			);
			const result = recorded.rows[0];
			if (!result) throw new Error("Release Gateway could not persist the manifest");
			return { manifestId: result.id, manifestHash: result.manifest_hash, expiresAt: result.expires_at.toISOString() };
		});
	} finally {
		client.release();
	}
}

/**
 * A supplied key still wins, because an operator who already runs a key
 * management system should keep using it. What changed is the fallback: an
 * absent key no longer stops the gateway from starting, it makes the gateway
 * mint one and leave it in the database, where the grants decide who may read
 * it. The previous fallback was a person pasting a private key into a hosting
 * panel, which put the value in a clipboard and a deploy log on the way.
 */
async function resolveSigningKey(pool: Pool): Promise<{ privateKey: string; version: string }> {
	const suppliedKey = process.env.SELENA_GATEWAY_SIGNING_PRIVATE_KEY;
	if (suppliedKey) {
		return { privateKey: suppliedKey, version: requiredEnv("SELENA_GATEWAY_SIGNING_KEY_VERSION") };
	}
	const client = await pool.connect();
	try {
		const key = await ensureGatewaySigningKey(client);
		return { privateKey: key.privateKeyPem, version: key.version };
	} finally {
		client.release();
	}
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > 32 * 1024) throw new Error("Gateway request is too large");
		chunks.push(buffer);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function requireUuid(value: unknown, field: string): string {
	if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value)) throw new Error(`${field} must be a UUID`);
	return value;
}

/**
 * A dispatch is bound to one key for its whole life: the same key reserves it,
 * authorizes it and reaches the provider, so a repeated request returns the
 * reservation already made rather than publishing a second time.
 */
function requireIdempotencyKey(value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > 200) {
		throw new Error("idempotencyKey is required");
	}
	return value;
}

/** Runs one committed transaction in the Gateway's context for a manifest. */
function gatewayTransactionFor(pool: Pool, manifestId: string) {
	return async <Result>(task: (query: GatewayQuery) => Promise<Result>): Promise<Result> => {
		const client = await pool.connect();
		try {
			return await withGatewayContext(
				client,
				() =>
					task(async <Row>(sql: string, parameters: unknown[]) => {
						const result = await client.query(sql, parameters);
						return result.rows as Row[];
					}),
				manifestId,
			);
		} finally {
			client.release();
		}
	};
}

function sendJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
	response.writeHead(status, { "cache-control": "no-store", "content-type": "application/json" });
	response.end(JSON.stringify(body));
}

export async function startSelenaReleaseGateway(): Promise<void> {
	const token = requiredEnv("SELENA_GATEWAY_INTERNAL_TOKEN");
	const pool = createGatewayPool(requiredEnv("DATABASE_URL"));
	const { privateKey, version: signingKeyVersion } = await resolveSigningKey(pool);
	const port = Number.parseInt(process.env.SELENA_GATEWAY_PORT ?? "8082", 10);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SELENA_GATEWAY_PORT is invalid");

	const server = createServer(async (request, response) => {
		if (request.url === "/healthz" && request.method === "GET") return sendJson(response, 200, { status: "ok" });
		if (!isGatewayAuthorizationValid(token, request.headers.authorization?.replace(/^Bearer /, "")))
			return sendJson(response, 401, { error: "unauthorized" });
		const isManifestRequest = request.url === "/v1/release-manifests" && request.method === "POST";
		const isDispatchRequest = request.url === "/v1/release-dispatches" && request.method === "POST";
		if (!isManifestRequest && !isDispatchRequest) return sendJson(response, 404, { error: "not_found" });
		try {
			const body = await readJson(request);
			if (isDispatchRequest) {
				const manifestId = requireUuid(body.manifestId, "manifestId");
				return sendJson(
					response,
					200,
					await dispatchReleaseManifest({
						configuration: configureReleaseProviders(),
						idempotencyKey: requireIdempotencyKey(body.idempotencyKey),
						inGatewayContext: gatewayTransactionFor(pool, manifestId),
						manifestId,
					}),
				);
			}
			return sendJson(
				response,
				201,
				await createSignedManifest({
					pool,
					privateKey,
					releaseIntentId: requireUuid(body.releaseIntentId, "releaseIntentId"),
					signingKeyVersion,
				}),
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Release Gateway request failed";
			return sendJson(response, 409, { error: message });
		}
	});
	server.listen(port, "0.0.0.0");
	const shutdown = async () => {
		server.close();
		await pool.end();
		process.exit(0);
	};
	process.once("SIGTERM", () => void shutdown());
	process.once("SIGINT", () => void shutdown());
}

if (process.argv[1]?.endsWith("selena-release-gateway.ts")) {
	startSelenaReleaseGateway().catch((error) => {
		console.error(error instanceof Error ? error.message : "Release Gateway failed to start");
		process.exit(1);
	});
}

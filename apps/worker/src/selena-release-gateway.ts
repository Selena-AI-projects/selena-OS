import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { assertStagingDatabaseTls } from "@workspace/lib/db/staging-tls";
import { assertImmutablePublicationPackage, signReleaseManifest } from "@workspace/lib/selena-release-gateway";
import { Pool, type PoolClient } from "pg";

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
	const isStagingMvp = process.env.SELENA_STAGING_MVP === "true";
	assertStagingDatabaseTls(connectionString, isStagingMvp);
	if (!isStagingMvp) return new Pool({ connectionString });
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

async function readJson(request: IncomingMessage): Promise<{ releaseIntentId: string }> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > 32 * 1024) throw new Error("Gateway request is too large");
		chunks.push(buffer);
	}
	const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { releaseIntentId?: unknown };
	if (typeof parsed.releaseIntentId !== "string" || !/^[0-9a-f-]{36}$/i.test(parsed.releaseIntentId)) {
		throw new Error("releaseIntentId must be a UUID");
	}
	return { releaseIntentId: parsed.releaseIntentId };
}

function sendJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
	response.writeHead(status, { "cache-control": "no-store", "content-type": "application/json" });
	response.end(JSON.stringify(body));
}

export async function startSelenaReleaseGateway(): Promise<void> {
	const token = requiredEnv("SELENA_GATEWAY_INTERNAL_TOKEN");
	const privateKey = requiredEnv("SELENA_GATEWAY_SIGNING_PRIVATE_KEY");
	const signingKeyVersion = requiredEnv("SELENA_GATEWAY_SIGNING_KEY_VERSION");
	const pool = createGatewayPool(requiredEnv("DATABASE_URL"));
	const port = Number.parseInt(process.env.SELENA_GATEWAY_PORT ?? "8082", 10);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SELENA_GATEWAY_PORT is invalid");

	const server = createServer(async (request, response) => {
		if (request.url === "/healthz" && request.method === "GET") return sendJson(response, 200, { status: "ok" });
		if (!isGatewayAuthorizationValid(token, request.headers.authorization?.replace(/^Bearer /, "")))
			return sendJson(response, 401, { error: "unauthorized" });
		if (request.url !== "/v1/release-manifests" || request.method !== "POST")
			return sendJson(response, 404, { error: "not_found" });
		try {
			return sendJson(
				response,
				201,
				await createSignedManifest({
					pool,
					privateKey,
					releaseIntentId: (await readJson(request)).releaseIntentId,
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

import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import { assertStagingDatabaseTls } from "@workspace/lib/db/staging-tls";
import { parseClamAvScanReply } from "@workspace/lib/selena-clamav";
import {
	createSelenaStorageKey,
	MAX_SELENA_ASSET_BYTES,
	SupabasePrivateStorage,
	validateSelenaAsset,
} from "@workspace/lib/selena-private-storage";
import { Pool, type PoolClient } from "pg";

const SCANNER_QUEUE_CONTEXT = { organizationId: "__scanner_queue__", brandId: "__scanner_queue__" };
const MAX_FILENAME_LENGTH = 180;

type AssetScope = {
	actorId: string;
	brandId: string;
	contentVersionId: string;
	consentExpiresAt: Date;
	filename: string;
	organizationId: string;
	rightsExpiresAt: Date;
};

type ClaimedAsset = {
	id: string;
	organizationId: string;
	brandId: string;
	contentVersionId: string;
	storageBucket: string;
	storageKey: string;
	sha256: string;
	mimeType: string;
	scanAttempts: number;
	scanLeaseToken: string;
};

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required for the Selena scanner runtime`);
	return value;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535)
		throw new Error("Scanner port configuration is invalid");
	return parsed;
}

function sameSecret(expected: string, provided: string | undefined): boolean {
	if (!provided) return false;
	const expectedBytes = Buffer.from(expected);
	const providedBytes = Buffer.from(provided);
	return expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes);
}

function readHeader(request: IncomingMessage, name: string): string {
	const value = request.headers[name];
	if (typeof value !== "string" || value.length === 0) throw new Error(`Missing required ${name} header`);
	return value;
}

function parseFutureIso(value: string, name: string): Date {
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime()) || parsed <= new Date()) throw new Error(`${name} must be a future ISO timestamp`);
	return parsed;
}

function hasControlCharacter(value: string): boolean {
	for (const character of value) {
		if (character.charCodeAt(0) <= 31) return true;
	}
	return false;
}

export function parseAssetScope(request: IncomingMessage): AssetScope {
	const filename = readHeader(request, "x-selena-filename").trim();
	if (!filename || filename.length > MAX_FILENAME_LENGTH || hasControlCharacter(filename)) {
		throw new Error("Asset filename is invalid");
	}
	return {
		actorId: readHeader(request, "x-selena-actor-id"),
		brandId: readHeader(request, "x-selena-brand-id"),
		contentVersionId: readHeader(request, "x-selena-content-version-id"),
		consentExpiresAt: parseFutureIso(readHeader(request, "x-selena-consent-expires-at"), "Consent expiry"),
		filename,
		organizationId: readHeader(request, "x-selena-organization-id"),
		rightsExpiresAt: parseFutureIso(readHeader(request, "x-selena-rights-expires-at"), "Rights expiry"),
	};
}

function parseAssetReadScope(request: IncomingMessage): Pick<AssetScope, "actorId" | "brandId" | "organizationId"> {
	return {
		actorId: readHeader(request, "x-selena-actor-id"),
		brandId: readHeader(request, "x-selena-brand-id"),
		organizationId: readHeader(request, "x-selena-organization-id"),
	};
}

export function scanRetrySeconds(attempt: number): number {
	return Math.min(30 * 2 ** Math.max(0, attempt - 1), 15 * 60);
}

async function readBody(request: IncomingMessage): Promise<Uint8Array> {
	const declaredLength = Number.parseInt(request.headers["content-length"] ?? "", 10);
	if (Number.isFinite(declaredLength) && declaredLength > MAX_SELENA_ASSET_BYTES) {
		throw new Error("Asset upload exceeds the 10 MiB limit");
	}

	return await new Promise<Uint8Array>((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		request.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_SELENA_ASSET_BYTES) {
				reject(new Error("Asset upload exceeds the 10 MiB limit"));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
		request.on("error", reject);
	});
}

function createScannerPool(connectionString: string): Pool {
	const isStagingMvp = process.env.SELENA_STAGING_MVP === "true";
	assertStagingDatabaseTls(connectionString, isStagingMvp);
	if (!isStagingMvp) return new Pool({ connectionString });

	const url = new URL(connectionString);
	const certificatePath = url.searchParams.get("sslrootcert");
	if (!certificatePath) throw new Error("SELENA scanner staging connection needs a root certificate");
	for (const name of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) url.searchParams.delete(name);
	return new Pool({
		connectionString: url.toString(),
		ssl: { ca: readFileSync(certificatePath, "utf8"), rejectUnauthorized: true },
	});
}

async function withScannerContext<T>(
	client: PoolClient,
	scope: Pick<AssetScope, "organizationId" | "brandId">,
	task: () => Promise<T>,
): Promise<T> {
	await client.query("BEGIN");
	try {
		await client.query("SELECT selena_registry.set_request_context($1, $2, $3, $4, $5, $6, $7, NULL)", [
			"service:scanner",
			scope.organizationId,
			scope.brandId,
			"service",
			randomUUID(),
			"scanner",
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

async function claimNextAsset(pool: Pool): Promise<ClaimedAsset | null> {
	const client = await pool.connect();
	try {
		return await withScannerContext(client, SCANNER_QUEUE_CONTEXT, async () => {
			const result = await client.query<{
				id: string;
				organization_id: string;
				brand_id: string;
				content_version_id: string;
				storage_bucket: string;
				storage_key: string;
				sha256: string;
				mime_type: string;
				scan_attempts: number;
				scan_lease_token: string;
			}>("SELECT * FROM selena_registry.claim_next_quarantined_asset($1)", [300]);
			const row = result.rows[0];
			if (!row) return null;
			return {
				id: row.id,
				organizationId: row.organization_id,
				brandId: row.brand_id,
				contentVersionId: row.content_version_id,
				storageBucket: row.storage_bucket,
				storageKey: row.storage_key,
				sha256: row.sha256,
				mimeType: row.mime_type,
				scanAttempts: row.scan_attempts,
				scanLeaseToken: row.scan_lease_token,
			};
		});
	} finally {
		client.release();
	}
}

export async function scanWithClamAv(bytes: Uint8Array, host: string, port: number) {
	return await new Promise<ReturnType<typeof parseClamAvScanReply>>((resolve, reject) => {
		const socket = new Socket();
		const response: Buffer[] = [];
		let settled = false;
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			callback();
		};
		socket.setTimeout(60_000);
		socket.on("connect", () => {
			const size = Buffer.allocUnsafe(4);
			size.writeUInt32BE(bytes.byteLength);
			socket.write("zINSTREAM\0");
			socket.write(size);
			socket.write(bytes);
			socket.write(Buffer.alloc(4));
		});
		socket.on("data", (chunk: Buffer) => response.push(chunk));
		socket.on("end", () =>
			finish(() => {
				try {
					resolve(parseClamAvScanReply(Buffer.concat(response).toString("utf8")));
				} catch (error) {
					reject(error);
				}
			}),
		);
		socket.on("timeout", () => finish(() => reject(new Error("ClamAV scan timed out"))));
		socket.on("error", (error) => finish(() => reject(error)));
		socket.connect(port, host);
	});
}

async function updateAssetScanResult(
	pool: Pool,
	claim: ClaimedAsset,
	result: { state: "CLEAN" | "REJECTED" | "QUARANTINED"; reason: string | null; temporary: boolean },
): Promise<void> {
	const client = await pool.connect();
	try {
		await withScannerContext(client, claim, async () => {
			if (result.temporary) {
				await client.query(
					`UPDATE selena_registry.content_assets
					 SET scan_status = 'QUARANTINED', scan_available_at = now() + make_interval(secs => $1),
					     scan_lease_expires_at = NULL, scan_lease_token = NULL, scan_error = $2
					 WHERE id = $3 AND scan_status = 'SCANNING' AND scan_lease_token = $4`,
					[scanRetrySeconds(claim.scanAttempts), result.reason, claim.id, claim.scanLeaseToken],
				);
				return;
			}
			await client.query(
				`UPDATE selena_registry.content_assets
				 SET scan_status = $1, scan_provider_event_ref = $2, scan_completed_at = now(),
				     scan_lease_expires_at = NULL, scan_lease_token = NULL, scan_error = NULL,
				     scanner_version = 'clamav', rejection_reason = $3,
				     verified_at = CASE WHEN $1 = 'CLEAN' THEN now() ELSE NULL END
				 WHERE id = $4 AND scan_status = 'SCANNING' AND scan_lease_token = $5`,
				[result.state, `clamav:${randomUUID()}`, result.reason, claim.id, claim.scanLeaseToken],
			);
		});
	} finally {
		client.release();
	}
}

async function processOneAsset(
	pool: Pool,
	storage: SupabasePrivateStorage,
	clamav: { host: string; port: number },
): Promise<boolean> {
	const claim = await claimNextAsset(pool);
	if (!claim) return false;
	try {
		const bytes = await storage.download(claim.storageKey);
		const asset = validateSelenaAsset({ bytes, mimeType: claim.mimeType });
		if (asset.sha256 !== claim.sha256) throw new Error("ASSET_INTEGRITY_MISMATCH");
		const scan = await scanWithClamAv(bytes, clamav.host, clamav.port);
		await updateAssetScanResult(
			pool,
			claim,
			scan.clean
				? { state: "CLEAN", reason: null, temporary: false }
				: { state: "REJECTED", reason: scan.reason, temporary: false },
		);
	} catch (error) {
		const reason =
			error instanceof Error && error.message === "ASSET_INTEGRITY_MISMATCH"
				? "ASSET_INTEGRITY_MISMATCH"
				: "SCANNER_UNAVAILABLE";
		await updateAssetScanResult(pool, claim, {
			state: reason === "ASSET_INTEGRITY_MISMATCH" ? "REJECTED" : "QUARANTINED",
			reason,
			temporary: reason !== "ASSET_INTEGRITY_MISMATCH",
		});
	}
	return true;
}

async function createAsset(
	pool: Pool,
	storage: SupabasePrivateStorage,
	scope: AssetScope,
	bytes: Uint8Array,
	mimeType: string,
): Promise<{ id: string; scanStatus: "QUARANTINED" }> {
	const asset = validateSelenaAsset({ bytes, mimeType });
	const id = randomUUID();
	const storageKey = createSelenaStorageKey({ ...scope, assetId: id, mimeType: asset.mimeType });
	const client = await pool.connect();
	try {
		await withScannerContext(client, scope, async () => {
			const version = await client.query(
				`SELECT id FROM selena_registry.content_versions
				 WHERE id = $1 AND organization_id = $2 AND brand_id = $3`,
				[scope.contentVersionId, scope.organizationId, scope.brandId],
			);
			if (version.rowCount !== 1) throw new Error("Content version is not available for this brand");
			await client.query(
				`INSERT INTO selena_registry.content_assets (
					id, organization_id, brand_id, content_version_id, storage_bucket, storage_key,
					original_filename, sha256, mime_type, detected_mime_type, size_bytes,
					scan_status, rights_expires_at, consent_expires_at, immutable, created_by
				) VALUES ($1, $2, $3, $4, 'selena-quarantine', $5, $6, $7, $8, $9, $10,
					'QUARANTINED', $11, $12, true, $13)`,
				[
					id,
					scope.organizationId,
					scope.brandId,
					scope.contentVersionId,
					storageKey,
					scope.filename,
					asset.sha256,
					asset.mimeType,
					asset.detectedMimeType,
					asset.sizeBytes,
					scope.rightsExpiresAt,
					scope.consentExpiresAt,
					scope.actorId,
				],
			);
		});
	} finally {
		client.release();
	}

	try {
		const uploaded = await storage.uploadImmutable({ bytes: asset.bytes, key: storageKey, mimeType: asset.mimeType });
		const updateClient = await pool.connect();
		try {
			await withScannerContext(updateClient, scope, async () => {
				await updateClient.query(
					`UPDATE selena_registry.content_assets
					 SET object_version_id = $1
					 WHERE id = $2 AND scan_status = 'QUARANTINED' AND object_version_id IS NULL`,
					[uploaded.objectVersionId ?? asset.sha256, id],
				);
			});
		} finally {
			updateClient.release();
		}
	} catch {
		const updateClient = await pool.connect();
		try {
			await withScannerContext(updateClient, scope, async () => {
				await updateClient.query(
					`UPDATE selena_registry.content_assets
					 SET scan_status = 'REJECTED', scan_completed_at = now(), rejection_reason = 'STORAGE_UPLOAD_FAILED'
					 WHERE id = $1 AND scan_status = 'QUARANTINED'`,
					[id],
				);
			});
		} finally {
			updateClient.release();
		}
		throw new Error("Private asset storage upload failed");
	}

	return { id, scanStatus: "QUARANTINED" };
}

function sendJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
	response.writeHead(status, { "cache-control": "no-store", "content-type": "application/json" });
	response.end(JSON.stringify(body));
}

export async function startSelenaScannerRuntime(): Promise<void> {
	const token = requiredEnv("SELENA_SCANNER_INTERNAL_TOKEN");
	const pool = createScannerPool(requiredEnv("DATABASE_URL"));
	const storage = new SupabasePrivateStorage({
		apiUrl: requiredEnv("SELENA_STORAGE_API_URL"),
		serviceKey: requiredEnv("SELENA_STORAGE_SERVICE_KEY"),
	});
	await storage.ensurePrivateBucket();
	const clamav = {
		host: process.env.CLAMAV_HOST ?? "127.0.0.1",
		port: parsePositiveInt(process.env.CLAMAV_PORT, 3310),
	};

	const server = createServer(async (request, response) => {
		if (request.url === "/healthz" && request.method === "GET") return sendJson(response, 200, { status: "ok" });
		if (!sameSecret(token, request.headers.authorization?.replace(/^Bearer /, "")))
			return sendJson(response, 401, { error: "unauthorized" });

		try {
			if (request.url === "/v1/assets" && request.method === "POST") {
				const scope = parseAssetScope(request);
				const mimeType = readHeader(request, "content-type").split(";", 1)[0] ?? "";
				const asset = await createAsset(pool, storage, scope, await readBody(request), mimeType);
				return sendJson(response, 202, asset);
			}

			const signedMatch = request.url?.match(/^\/v1\/assets\/([0-9a-f-]{36})\/signed-url$/i);
			if (signedMatch && request.method === "POST") {
				const scope = parseAssetReadScope(request);
				const client = await pool.connect();
				try {
					const signedUrl = await withScannerContext(client, scope, async () => {
						const asset = await client.query<{ storage_key: string }>(
							`SELECT storage_key FROM selena_registry.content_assets
							 WHERE id = $1 AND organization_id = $2 AND brand_id = $3 AND scan_status = 'CLEAN'
							   AND rights_expires_at > now() AND consent_expires_at > now()`,
							[signedMatch[1], scope.organizationId, scope.brandId],
						);
						if (asset.rowCount !== 1) throw new Error("Asset is not available for download");
						const [assetRow] = asset.rows;
						if (!assetRow) throw new Error("Asset is not available for download");
						return storage.createSignedDownloadUrl(assetRow.storage_key, 300);
					});
					return sendJson(response, 200, { signedUrl, expiresInSeconds: 300 });
				} finally {
					client.release();
				}
			}

			return sendJson(response, 404, { error: "not_found" });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Scanner request failed";
			const status = /not available|not available for this brand/.test(message) ? 403 : 400;
			return sendJson(response, status, { error: message });
		}
	});

	const processLoop = setInterval(() => {
		void processOneAsset(pool, storage, clamav);
	}, 1_000);
	processLoop.unref();
	server.listen(parsePositiveInt(process.env.SELENA_SCANNER_PORT, 8081), "0.0.0.0");

	const shutdown = async () => {
		clearInterval(processLoop);
		server.close();
		await pool.end();
		process.exit(0);
	};
	process.once("SIGTERM", () => void shutdown());
	process.once("SIGINT", () => void shutdown());
}

if (process.argv[1]?.endsWith("selena-scanner.ts")) {
	startSelenaScannerRuntime().catch((error) => {
		console.error(error instanceof Error ? error.message : "Selena scanner failed to start");
		process.exit(1);
	});
}

import { createHash } from "node:crypto";

export const SELENA_QUARANTINE_BUCKET = "selena-quarantine";
export const MAX_SELENA_ASSET_BYTES = 10 * 1024 * 1024;
export const SELENA_ASSET_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export type SelenaAssetMimeType = (typeof SELENA_ASSET_MIME_TYPES)[number];

export type ValidatedSelenaAsset = {
	bytes: Uint8Array;
	detectedMimeType: SelenaAssetMimeType;
	mimeType: SelenaAssetMimeType;
	sha256: string;
	sizeBytes: number;
};

export type SupabaseStorageConfig = {
	apiUrl: string;
	serviceKey: string;
};

type FetchLike = typeof fetch;

function isSelenaAssetMimeType(value: string): value is SelenaAssetMimeType {
	return (SELENA_ASSET_MIME_TYPES as readonly string[]).includes(value);
}

function hasPrefix(bytes: Uint8Array, prefix: number[]): boolean {
	return prefix.every((value, index) => bytes[index] === value);
}

export function detectSelenaAssetMimeType(bytes: Uint8Array): SelenaAssetMimeType | null {
	if (hasPrefix(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
	if (hasPrefix(bytes, [0x52, 0x49, 0x46, 0x46]) && hasPrefix(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) {
		return "image/webp";
	}
	return null;
}

export function sha256Bytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function validateSelenaAsset(input: { bytes: Uint8Array; mimeType: string }): ValidatedSelenaAsset {
	if (input.bytes.byteLength === 0) throw new Error("Asset upload is empty");
	if (input.bytes.byteLength > MAX_SELENA_ASSET_BYTES) {
		throw new Error("Asset upload exceeds the 10 MiB limit");
	}
	if (!isSelenaAssetMimeType(input.mimeType)) throw new Error("Asset type is not allowed");
	const detectedMimeType = detectSelenaAssetMimeType(input.bytes);
	if (!detectedMimeType) throw new Error("Asset bytes are not a supported image");
	if (detectedMimeType !== input.mimeType) throw new Error("Asset type does not match its file bytes");
	return {
		bytes: input.bytes,
		detectedMimeType,
		mimeType: input.mimeType,
		sha256: sha256Bytes(input.bytes),
		sizeBytes: input.bytes.byteLength,
	};
}

export function createSelenaStorageKey(input: {
	assetId: string;
	brandId: string;
	contentVersionId: string;
	organizationId: string;
	mimeType: SelenaAssetMimeType;
}): string {
	const extension = input.mimeType === "image/jpeg" ? "jpg" : input.mimeType === "image/png" ? "png" : "webp";
	const scope = createHash("sha256").update(`${input.organizationId}\u0000${input.brandId}`).digest("hex").slice(0, 24);
	return `originals/${scope}/${input.contentVersionId}/${input.assetId}.${extension}`;
}

function objectPath(bucket: string, key: string): string {
	return `${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function storageFailure(action: string, response: Response): Error {
	return new Error(`Supabase Storage ${action} failed with status ${response.status}`);
}

/**
 * Scanner-only Storage client. The browser and normal web database runtime do
 * not import or receive the credential used by this client.
 */
export class SupabasePrivateStorage {
	private readonly baseUrl: string;

	constructor(
		private readonly config: SupabaseStorageConfig,
		private readonly fetchFn: FetchLike = fetch,
	) {
		this.baseUrl = new URL("/storage/v1/", config.apiUrl).toString().replace(/\/$/, "");
	}

	private headers(): Record<string, string> {
		return {
			apikey: this.config.serviceKey,
			authorization: `Bearer ${this.config.serviceKey}`,
		};
	}

	async ensurePrivateBucket(): Promise<void> {
		const response = await this.fetchFn(`${this.baseUrl}/bucket`, {
			method: "POST",
			headers: { ...this.headers(), "content-type": "application/json" },
			body: JSON.stringify({
				id: SELENA_QUARANTINE_BUCKET,
				name: SELENA_QUARANTINE_BUCKET,
				public: false,
				file_size_limit: MAX_SELENA_ASSET_BYTES,
				allowed_mime_types: SELENA_ASSET_MIME_TYPES,
			}),
		});
		if (!response.ok && response.status !== 409) throw storageFailure("bucket setup", response);
	}

	async uploadImmutable(input: {
		bytes: Uint8Array;
		key: string;
		mimeType: SelenaAssetMimeType;
	}): Promise<{ objectVersionId: string | null }> {
		const response = await this.fetchFn(`${this.baseUrl}/object/${objectPath(SELENA_QUARANTINE_BUCKET, input.key)}`, {
			method: "POST",
			headers: {
				...this.headers(),
				"content-type": input.mimeType,
				"x-upsert": "false",
			},
			body: Buffer.from(input.bytes),
		});
		if (!response.ok) throw storageFailure("upload", response);
		return { objectVersionId: response.headers.get("etag") };
	}

	async download(key: string): Promise<Uint8Array> {
		const response = await this.fetchFn(`${this.baseUrl}/object/${objectPath(SELENA_QUARANTINE_BUCKET, key)}`, {
			headers: this.headers(),
		});
		if (!response.ok) throw storageFailure("download", response);
		return new Uint8Array(await response.arrayBuffer());
	}

	async createSignedDownloadUrl(key: string, expiresInSeconds: number): Promise<string> {
		if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 3600) {
			throw new Error("Signed download expiry must be between 1 and 3600 seconds");
		}
		const response = await this.fetchFn(`${this.baseUrl}/object/sign/${objectPath(SELENA_QUARANTINE_BUCKET, key)}`, {
			method: "POST",
			headers: { ...this.headers(), "content-type": "application/json" },
			body: JSON.stringify({ expiresIn: expiresInSeconds, download: true }),
		});
		if (!response.ok) throw storageFailure("signed URL", response);
		const body = (await response.json()) as { signedURL?: unknown };
		if (typeof body.signedURL !== "string" || !body.signedURL.startsWith("/")) {
			throw new Error("Supabase Storage returned an invalid signed URL");
		}
		return new URL(body.signedURL.replace(/^\//, ""), `${this.baseUrl}/`).toString();
	}
}

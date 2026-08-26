import { createHash, createHmac } from "node:crypto";

/**
 * Signed, expiring access to raw evidence objects in an S3-compatible store.
 *
 * Addendum §7: a client never receives a permanent object URL — tenant
 * authorization happens in the repository read (rawEvidenceFor, which also
 * audits), and this layer only turns the reference that read returned into a
 * short-lived link. Unconfigured is a legal state: the caller answers
 * "unavailable" honestly instead of failing.
 *
 * Signing is SigV4 presign implemented on node:crypto — deliberately no SDK
 * dependency for one GET signature.
 */

export type RawEvidenceStorageConfig = {
	/** e.g. https://s3.eu-central-1.example.com — HTTPS only. */
	endpoint: string;
	bucket: string;
	region: string;
	accessKeyId: string;
	secretAccessKey: string;
};

export function rawEvidenceStorageFromEnv(
	env: Record<string, string | undefined> = process.env,
): RawEvidenceStorageConfig | null {
	const endpoint = env.SELENA_EVIDENCE_S3_ENDPOINT?.trim();
	const bucket = env.SELENA_EVIDENCE_S3_BUCKET?.trim();
	const region = env.SELENA_EVIDENCE_S3_REGION?.trim();
	const accessKeyId = env.SELENA_EVIDENCE_S3_ACCESS_KEY_ID?.trim();
	const secretAccessKey = env.SELENA_EVIDENCE_S3_SECRET_ACCESS_KEY?.trim();
	if (!endpoint || !bucket || !region || !accessKeyId || !secretAccessKey) return null;
	if (!endpoint.startsWith("https://")) return null;
	return { endpoint, bucket, region, accessKeyId, secretAccessKey };
}

/** Where a run's raw payload lives, by the reference stored on the run row. */
export function evidenceObjectKey(rawResponseReference: string): string {
	// The reference is opaque and can contain ':'; encode each path segment so
	// the key round-trips through URL signing unchanged.
	return `raw-evidence/${encodeURIComponent(rawResponseReference)}`;
}

const rfc3986 = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function presignEvidenceUrl(
	config: RawEvidenceStorageConfig,
	objectKey: string,
	opts: { now: Date; expiresInSeconds: number },
): { url: string; expiresAt: Date } {
	const { now, expiresInSeconds } = opts;
	const amzDate = `${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
	const shortDate = amzDate.slice(0, 8);
	const scope = `${shortDate}/${config.region}/s3/aws4_request`;
	const host = new URL(config.endpoint).host;
	const path = `/${config.bucket}/${objectKey.split("/").map(rfc3986).join("/")}`;

	const query: [string, string][] = [
		["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
		["X-Amz-Credential", `${config.accessKeyId}/${scope}`],
		["X-Amz-Date", amzDate],
		["X-Amz-Expires", String(expiresInSeconds)],
		["X-Amz-SignedHeaders", "host"],
	];
	const canonicalQuery = query
		.map(([key, value]) => `${rfc3986(key)}=${rfc3986(value)}`)
		.sort()
		.join("&");

	const canonicalRequest = ["GET", path, canonicalQuery, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
	const stringToSign = [
		"AWS4-HMAC-SHA256",
		amzDate,
		scope,
		createHash("sha256").update(canonicalRequest).digest("hex"),
	].join("\n");
	const dateKey = createHmac("sha256", `AWS4${config.secretAccessKey}`).update(shortDate).digest();
	const regionKey = createHmac("sha256", dateKey).update(config.region).digest();
	const serviceKey = createHmac("sha256", regionKey).update("s3").digest();
	const signingKey = createHmac("sha256", serviceKey).update("aws4_request").digest();
	const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

	return {
		url: `${config.endpoint}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`,
		expiresAt: new Date(now.getTime() + expiresInSeconds * 1000),
	};
}

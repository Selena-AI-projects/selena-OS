import { describe, expect, it } from "vitest";
import {
	evidenceObjectKey,
	presignEvidenceUrl,
	rawEvidenceStorageFromEnv,
} from "./selena-raw-evidence-storage";

const CONFIG = {
	endpoint: "https://s3.example.com",
	bucket: "evidence",
	region: "eu-central-1",
	accessKeyId: "AKIDEXAMPLE",
	secretAccessKey: "secret",
};

describe("rawEvidenceStorageFromEnv", () => {
	it("is disabled until every variable is present", () => {
		expect(rawEvidenceStorageFromEnv({})).toBeNull();
		expect(
			rawEvidenceStorageFromEnv({
				SELENA_EVIDENCE_S3_ENDPOINT: "https://s3.example.com",
				SELENA_EVIDENCE_S3_BUCKET: "evidence",
				SELENA_EVIDENCE_S3_REGION: "eu-central-1",
				SELENA_EVIDENCE_S3_ACCESS_KEY_ID: "AKIDEXAMPLE",
			}),
		).toBeNull();
	});

	it("refuses a non-HTTPS endpoint", () => {
		expect(
			rawEvidenceStorageFromEnv({
				SELENA_EVIDENCE_S3_ENDPOINT: "http://s3.example.com",
				SELENA_EVIDENCE_S3_BUCKET: "evidence",
				SELENA_EVIDENCE_S3_REGION: "eu-central-1",
				SELENA_EVIDENCE_S3_ACCESS_KEY_ID: "AKIDEXAMPLE",
				SELENA_EVIDENCE_S3_SECRET_ACCESS_KEY: "secret",
			}),
		).toBeNull();
	});
});

describe("presignEvidenceUrl", () => {
	const now = new Date("2026-08-23T12:00:00Z");

	it("signs a URL whose expiry follows the clock, not the wall", () => {
		const { url, expiresAt } = presignEvidenceUrl(CONFIG, evidenceObjectKey("stub:sha256:abc"), {
			now,
			expiresInSeconds: 600,
		});
		expect(expiresAt.toISOString()).toBe("2026-08-23T12:10:00.000Z");
		expect(url).toContain("https://s3.example.com/evidence/raw-evidence/");
		expect(url).toContain("X-Amz-Date=20260823T120000Z");
		expect(url).toContain("X-Amz-Expires=600");
		expect(url).toContain(`X-Amz-Credential=${encodeURIComponent("AKIDEXAMPLE/20260823/eu-central-1/s3/aws4_request")}`);
		expect(url).toMatch(/X-Amz-Signature=[0-9a-f]{64}$/);
	});

	it("is deterministic for the same instant and differs across keys", () => {
		const a = presignEvidenceUrl(CONFIG, evidenceObjectKey("stub:sha256:abc"), { now, expiresInSeconds: 600 });
		const b = presignEvidenceUrl(CONFIG, evidenceObjectKey("stub:sha256:abc"), { now, expiresInSeconds: 600 });
		const c = presignEvidenceUrl(CONFIG, evidenceObjectKey("stub:sha256:other"), { now, expiresInSeconds: 600 });
		expect(a.url).toBe(b.url);
		expect(c.url).not.toBe(a.url);
		// The secret itself never appears in the URL.
		expect(a.url).not.toContain("secret");
	});
});

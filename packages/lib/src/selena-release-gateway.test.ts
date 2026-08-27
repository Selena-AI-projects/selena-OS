import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	assertImmutablePublicationPackage,
	signReleaseManifest,
	verifyReleaseManifest,
} from "./selena-release-gateway";

const packageFixture = {
	schemaVersion: "selena.publication-package/v1",
	releaseIntentId: "10000000-0000-0000-0000-000000000001",
	destination: { integrationId: "linkedin-integration-a", platform: "linkedin_page" },
	schedule: { notBefore: "2026-08-27T12:00:00.000Z", timezone: "UTC" },
	content: { body: "Verified content", contentHash: "a".repeat(64) },
	assets: [],
};

describe("Selena Release Gateway signature", () => {
	it("signs the exact immutable publication package", () => {
		const keys = generateKeyPairSync("ed25519");
		const privateKey = keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
		const publicKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
		const signed = signReleaseManifest(packageFixture, privateKey);
		expect(verifyReleaseManifest(packageFixture, signed.signature, publicKey)).toBe(true);
		expect(
			verifyReleaseManifest(
				{ ...packageFixture, content: { ...packageFixture.content, body: "Changed" } },
				signed.signature,
				publicKey,
			),
		).toBe(false);
	});

	it("rejects incomplete or wrong-version packages before signing", () => {
		expect(() => assertImmutablePublicationPackage({})).toThrow("version");
		expect(() =>
			assertImmutablePublicationPackage({ schemaVersion: "selena.publication-package/v1", releaseIntentId: "id" }),
		).toThrow("incomplete");
	});
});

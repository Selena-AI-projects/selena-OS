import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	assertImmutablePublicationPackage,
	ensureGatewaySigningKey,
	generateGatewaySigningKey,
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

describe("Selena Release Gateway signing key custody", () => {
	it("mints a key that actually signs and verifies a manifest", () => {
		const key = generateGatewaySigningKey();
		const signed = signReleaseManifest(packageFixture, key.privateKeyPem);
		expect(verifyReleaseManifest(packageFixture, signed.signature, key.publicKeyPem)).toBe(true);
	});

	it("passes a freshly minted candidate to the database and returns what custody holds", async () => {
		const calls: unknown[][] = [];
		const stored = {
			version: "k-stored",
			public_key_pem: "-----BEGIN PUBLIC KEY-----stored",
			private_key_pem: "-----BEGIN PRIVATE KEY-----stored",
		};
		const key = await ensureGatewaySigningKey({
			query: async (_text, values) => {
				calls.push(values);
				return { rows: [stored] };
			},
		});
		expect(key).toEqual({
			version: "k-stored",
			publicKeyPem: "-----BEGIN PUBLIC KEY-----stored",
			privateKeyPem: "-----BEGIN PRIVATE KEY-----stored",
		});
		// The candidate is offered, not assumed: what comes back is custody's answer.
		expect(calls).toHaveLength(1);
		expect(calls[0]?.[0]).not.toBe("k-stored");
		expect(String(calls[0]?.[2])).toContain("BEGIN PRIVATE KEY");
	});

	it("mints a different candidate on every call so two replicas never offer the same key", async () => {
		const offered: string[] = [];
		const query = async (_text: string, values: unknown[]) => {
			offered.push(String(values[0]));
			return {
				rows: [
					{
						version: String(values[0]),
						public_key_pem: String(values[1]),
						private_key_pem: String(values[2]),
					},
				],
			};
		};
		await ensureGatewaySigningKey({ query });
		await ensureGatewaySigningKey({ query });
		expect(offered[0]).not.toEqual(offered[1]);
	});

	it("refuses to start on an empty answer rather than signing with nothing", async () => {
		await expect(ensureGatewaySigningKey({ query: async () => ({ rows: [] }) })).rejects.toThrow(
			"could not obtain a signing key",
		);
	});

	it("refuses a row whose key columns are not strings", async () => {
		await expect(
			ensureGatewaySigningKey({
				query: async () => ({ rows: [{ version: "k-1", public_key_pem: null, private_key_pem: 7 }] }),
			}),
		).rejects.toThrow("malformed");
	});
});

import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { canonicalJson, sha256 } from "./selena-control-room";

export const SELENA_PUBLICATION_PACKAGE_VERSION = "selena.publication-package/v1";

export type SignedReleaseManifest = {
	canonicalManifest: string;
	manifestHash: string;
	signature: string;
	signatureAlgorithm: "Ed25519";
};

export function canonicalizePublicationPackage(manifest: unknown): string {
	assertImmutablePublicationPackage(manifest);
	return canonicalJson(manifest);
}

export function signReleaseManifest(manifest: unknown, privateKeyPem: string): SignedReleaseManifest {
	const canonicalManifest = canonicalizePublicationPackage(manifest);
	const manifestHash = sha256(JSON.parse(canonicalManifest));
	const signature = sign(null, Buffer.from(manifestHash, "utf8"), createPrivateKey(privateKeyPem)).toString(
		"base64url",
	);
	return { canonicalManifest, manifestHash, signature, signatureAlgorithm: "Ed25519" };
}

export function verifyReleaseManifest(manifest: unknown, signature: string, publicKeyPem: string): boolean {
	const manifestHash = sha256(manifest);
	return verify(
		null,
		Buffer.from(manifestHash, "utf8"),
		createPublicKey(publicKeyPem),
		Buffer.from(signature, "base64url"),
	);
}

export function assertImmutablePublicationPackage(manifest: unknown): void {
	if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
		throw new Error("Publication package must be an object");
	}
	const packageRecord = manifest as Record<string, unknown>;
	if (packageRecord.schemaVersion !== SELENA_PUBLICATION_PACKAGE_VERSION) {
		throw new Error("Publication package version is invalid");
	}
	if (typeof packageRecord.releaseIntentId !== "string" || !Array.isArray(packageRecord.assets)) {
		throw new Error("Publication package is incomplete");
	}
	// Ensure a caller cannot exploit JavaScript property order to obtain a
	// different byte representation from the exact signed package.
	canonicalJson(manifest);
}

export type GatewaySigningKey = {
	version: string;
	publicKeyPem: string;
	privateKeyPem: string;
};

// Structural, so this module keeps working against a pg Pool, a pooled client
// or a test double without taking a dependency on the driver.
type SigningKeyQueryable = {
	query: (text: string, values: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

export function generateGatewaySigningKey(version: string = `k-${randomUUID()}`): GatewaySigningKey {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	return {
		version,
		publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
		privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
	};
}

/**
 * Returns the key the gateway signs with, minting one on the first boot.
 *
 * A candidate is generated before the call rather than after a lookup finds
 * nothing: two replicas booting together would otherwise race, and the database
 * settles the race by keeping whichever candidate arrived first. The loser's
 * candidate is discarded, never stored, and the winner's key comes back to
 * both — so a restart cannot silently change the key that signed yesterday's
 * manifests.
 */
export async function ensureGatewaySigningKey(client: SigningKeyQueryable): Promise<GatewaySigningKey> {
	const candidate = generateGatewaySigningKey();
	const result = await client.query(
		"SELECT version, public_key_pem, private_key_pem FROM selena_release.ensure_gateway_signing_key($1, $2, $3)",
		[candidate.version, candidate.publicKeyPem, candidate.privateKeyPem],
	);
	const row = result.rows[0];
	if (!row) throw new Error("Release Gateway could not obtain a signing key");
	const version = row.version;
	const publicKeyPem = row.public_key_pem;
	const privateKeyPem = row.private_key_pem;
	if (typeof version !== "string" || typeof publicKeyPem !== "string" || typeof privateKeyPem !== "string") {
		throw new Error("Release Gateway signing key is malformed");
	}
	return { version, publicKeyPem, privateKeyPem };
}

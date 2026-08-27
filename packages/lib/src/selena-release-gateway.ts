import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
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

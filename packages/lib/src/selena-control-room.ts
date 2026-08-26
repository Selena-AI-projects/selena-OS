import { createHash } from "node:crypto";

export type ReleaseBlockReason =
	| "KILL_SWITCH_ACTIVE"
	| "ACCOUNT_NOT_ALLOWLISTED"
	| "APPROVAL_MISSING"
	| "APPROVAL_EXPIRED"
	| "CONTENT_HASH_MISMATCH"
	| "ASSET_NOT_READY"
	| "ASSET_HASH_MISMATCH"
	| "POLICY_VERSION_MISMATCH"
	| "DISCLOSURE_MISMATCH"
	| "EVIDENCE_MISSING"
	| "EVIDENCE_EXPIRED"
	| "RIGHTS_MISSING"
	| "RIGHTS_EXPIRED"
	| "CONSENT_MISSING"
	| "CONSENT_EXPIRED";

export type ReleaseGateInput = {
	killSwitchActive: boolean;
	accountAllowlisted: boolean;
	humanApproval: boolean;
	approvalExpired: boolean;
	contentHashMatches: boolean;
	assetsReady: boolean;
	assetHashMatches: boolean;
	policyVersionMatches: boolean;
	disclosureMatches: boolean;
	evidencePresent: boolean;
	evidenceValid: boolean;
	rightsPresent: boolean;
	rightsValid: boolean;
	consentPresent: boolean;
	consentValid: boolean;
};

export type ReleaseGateResult = { allowed: true } | { allowed: false; reason: ReleaseBlockReason };

export type HumanApprovalActor = {
	authType: "session" | "api_key";
	role: "owner" | "member" | "viewer";
};

export type PublicationDispatchObservation = "NOT_SENT" | "REJECTED" | "CONFIRMED" | "AMBIGUOUS";

export type PublicationDispatchDisposition =
	| { status: "RETRY_SAFE" }
	| { status: "FAILED" }
	| { status: "CONFIRMED" }
	| { status: "RECONCILE_REQUIRED" };

/** Serializes an object deterministically before it becomes a security binding. */
export function canonicalJson(value: unknown): string {
	return serializeCanonicalJson(value, new Set<object>());
}

function serializeCanonicalJson(value: unknown, ancestors: Set<object>): string {
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
	if (typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("Canonical JSON does not permit non-finite numbers");
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		if (ancestors.has(value)) throw new Error("Canonical JSON does not permit cyclic values");
		ancestors.add(value);
		const serialized = `[${value.map((entry) => serializeCanonicalJson(entry, ancestors)).join(",")}]`;
		ancestors.delete(value);
		return serialized;
	}
	if (typeof value === "object") {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new Error("Canonical JSON only permits plain objects");
		}
		if (ancestors.has(value)) throw new Error("Canonical JSON does not permit cyclic values");
		ancestors.add(value);
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record).map((key) => ({ original: key, normalized: key.normalize("NFC") }));
		if (new Set(keys.map((key) => key.normalized)).size !== keys.length) {
			throw new Error("Canonical JSON does not permit duplicate normalized object keys");
		}
		const serialized = `{${keys
			.sort((left, right) => left.normalized.localeCompare(right.normalized, "en"))
			.map((key) => `${JSON.stringify(key.normalized)}:${serializeCanonicalJson(record[key.original], ancestors)}`)
			.join(",")}}`;
		ancestors.delete(value);
		return serialized;
	}
	throw new Error(`Canonical JSON does not permit ${typeof value}`);
}

export function sha256(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function contentVersionHash(input: {
	body: string;
	ctaUrl: string;
	claims: unknown;
	evidence: unknown;
	disclosure: unknown;
	policyVersion: string;
}): string {
	return sha256({
		body: input.body,
		claims: input.claims,
		ctaUrl: input.ctaUrl,
		disclosure: input.disclosure,
		evidence: input.evidence,
		policyVersion: input.policyVersion,
	});
}

export function assetBundleHash(assets: ReadonlyArray<{ id: string; sha256: string }>): string {
	return sha256(
		assets
			.map((asset) => ({ id: asset.id, sha256: asset.sha256 }))
			.sort((left, right) => left.id.localeCompare(right.id)),
	);
}

export function approvalBindingHash(input: {
	brandId: string;
	channel: string;
	channelAccountId: string;
	contentHash: string;
	assetBundleHash: string;
	policyVersion: string;
	disclosure: unknown;
}): string {
	return sha256({
		assetBundleHash: input.assetBundleHash,
		brandId: input.brandId,
		channel: input.channel,
		channelAccountId: input.channelAccountId,
		contentHash: input.contentHash,
		disclosure: input.disclosure,
		policyVersion: input.policyVersion,
	});
}

/** Stable across duplicate user actions, but changes when an approved binding changes. */
export function releaseIntentIdempotencyKey(input: {
	approvalId: string;
	bindingHash: string;
	channelAccountId: string;
}): string {
	return sha256({
		approvalId: input.approvalId,
		bindingHash: input.bindingHash,
		channelAccountId: input.channelAccountId,
		intentVersion: "selena.release-intent/v1",
	});
}

export type OpaqueWorkflowPayload = {
	correlationId: string;
	eventType: "release.intent_queued";
	eventVersion: 1;
	releaseIntentId: string;
};

/** Trigger payloads carry identifiers only; canonical state is always re-read by a future service. */
export function createOpaqueWorkflowPayload(input: {
	correlationId: string;
	releaseIntentId: string;
}): OpaqueWorkflowPayload {
	if (!input.correlationId || !input.releaseIntentId) throw new Error("Opaque workflow identifiers are required");
	return {
		correlationId: input.correlationId,
		eventType: "release.intent_queued",
		eventVersion: 1,
		releaseIntentId: input.releaseIntentId,
	};
}

export function evaluateReleaseGate(input: ReleaseGateInput): ReleaseGateResult {
	if (input.killSwitchActive) return { allowed: false, reason: "KILL_SWITCH_ACTIVE" };
	if (!input.accountAllowlisted) return { allowed: false, reason: "ACCOUNT_NOT_ALLOWLISTED" };
	if (!input.humanApproval) return { allowed: false, reason: "APPROVAL_MISSING" };
	if (input.approvalExpired) return { allowed: false, reason: "APPROVAL_EXPIRED" };
	if (!input.contentHashMatches) return { allowed: false, reason: "CONTENT_HASH_MISMATCH" };
	if (!input.assetsReady) return { allowed: false, reason: "ASSET_NOT_READY" };
	if (!input.assetHashMatches) return { allowed: false, reason: "ASSET_HASH_MISMATCH" };
	if (!input.policyVersionMatches) return { allowed: false, reason: "POLICY_VERSION_MISMATCH" };
	if (!input.disclosureMatches) return { allowed: false, reason: "DISCLOSURE_MISMATCH" };
	if (!input.evidencePresent) return { allowed: false, reason: "EVIDENCE_MISSING" };
	if (!input.evidenceValid) return { allowed: false, reason: "EVIDENCE_EXPIRED" };
	if (!input.rightsPresent) return { allowed: false, reason: "RIGHTS_MISSING" };
	if (!input.rightsValid) return { allowed: false, reason: "RIGHTS_EXPIRED" };
	if (!input.consentPresent) return { allowed: false, reason: "CONSENT_MISSING" };
	if (!input.consentValid) return { allowed: false, reason: "CONSENT_EXPIRED" };
	return { allowed: true };
}

/** Human approval is deliberately unavailable to API and service identities. */
export function isInteractiveOwnerSession(actor: HumanApprovalActor): boolean {
	return actor.authType === "session" && actor.role === "owner";
}

/** Ambiguous provider outcomes must reconcile before any additional publish attempt. */
export function classifyPublicationDispatch(
	observation: PublicationDispatchObservation,
): PublicationDispatchDisposition {
	if (observation === "NOT_SENT") return { status: "RETRY_SAFE" };
	if (observation === "REJECTED") return { status: "FAILED" };
	if (observation === "CONFIRMED") return { status: "CONFIRMED" };
	return { status: "RECONCILE_REQUIRED" };
}

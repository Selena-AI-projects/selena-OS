import { describe, expect, it } from "vitest";
import {
	approvalBindingHash,
	assetBundleHash,
	canonicalJson,
	classifyPublicationDispatch,
	contentVersionHash,
	createOpaqueWorkflowPayload,
	describeOrigin,
	evaluateReleaseGate,
	isInteractiveOwnerSession,
	releaseIntentIdempotencyKey,
} from "./selena-control-room";

const permittedGate = {
	killSwitchActive: false,
	accountAllowlisted: true,
	humanApproval: true,
	approvalExpired: false,
	contentHashMatches: true,
	assetsReady: true,
	assetHashMatches: true,
	policyVersionMatches: true,
	disclosureMatches: true,
	evidencePresent: true,
	evidenceValid: true,
	rightsPresent: true,
	rightsValid: true,
	consentPresent: true,
	consentValid: true,
} as const;

describe("Selena Control Room release gate", () => {
	it("uses stable object ordering for security bindings", () => {
		expect(canonicalJson({ b: 2, a: { z: true, y: ["x"] } })).toBe(canonicalJson({ a: { y: ["x"], z: true }, b: 2 }));
	});

	it("normalizes Unicode and rejects ambiguous or non-JSON input", () => {
		expect(canonicalJson({ title: "Cafe\u0301" })).toBe(canonicalJson({ title: "Café" }));
		expect(() => canonicalJson({ Café: true, "Cafe\u0301": false })).toThrow("duplicate normalized object keys");
		expect(() => canonicalJson(new Date())).toThrow("plain objects");
	});

	it("invalidates an approval when protected content changes", () => {
		const first = contentVersionHash({
			body: "A verified launch update.",
			ctaUrl: "https://selena.example/brief",
			claims: [],
			evidence: [],
			disclosure: { paid: false },
			policyVersion: "brand-pack/v1",
		});
		const changed = contentVersionHash({
			body: "A verified launch update!",
			ctaUrl: "https://selena.example/brief",
			claims: [],
			evidence: [],
			disclosure: { paid: false },
			policyVersion: "brand-pack/v1",
		});

		expect(first).not.toBe(changed);
		expect(evaluateReleaseGate({ ...permittedGate, contentHashMatches: false })).toEqual({
			allowed: false,
			reason: "CONTENT_HASH_MISMATCH",
		});
	});

	it("binds asset order deterministically and blocks expired rights", () => {
		const assets = [
			{ id: "asset-b", sha256: "b" },
			{ id: "asset-a", sha256: "a" },
		];
		expect(assetBundleHash(assets)).toBe(assetBundleHash([...assets].reverse()));
		expect(evaluateReleaseGate({ ...permittedGate, rightsValid: false })).toEqual({
			allowed: false,
			reason: "RIGHTS_EXPIRED",
		});
	});

	it("blocks non-ready assets and every missing or expired approval dependency", () => {
		expect(evaluateReleaseGate({ ...permittedGate, humanApproval: false })).toEqual({
			allowed: false,
			reason: "APPROVAL_MISSING",
		});
		expect(evaluateReleaseGate({ ...permittedGate, assetsReady: false })).toEqual({
			allowed: false,
			reason: "ASSET_NOT_READY",
		});
		expect(evaluateReleaseGate({ ...permittedGate, assetHashMatches: false })).toEqual({
			allowed: false,
			reason: "ASSET_HASH_MISMATCH",
		});
		expect(evaluateReleaseGate({ ...permittedGate, evidenceValid: false })).toEqual({
			allowed: false,
			reason: "EVIDENCE_EXPIRED",
		});
		expect(evaluateReleaseGate({ ...permittedGate, evidencePresent: false })).toEqual({
			allowed: false,
			reason: "EVIDENCE_MISSING",
		});
		expect(evaluateReleaseGate({ ...permittedGate, rightsPresent: false })).toEqual({
			allowed: false,
			reason: "RIGHTS_MISSING",
		});
		expect(evaluateReleaseGate({ ...permittedGate, consentValid: false })).toEqual({
			allowed: false,
			reason: "CONSENT_EXPIRED",
		});
		expect(evaluateReleaseGate({ ...permittedGate, consentPresent: false })).toEqual({
			allowed: false,
			reason: "CONSENT_MISSING",
		});
	});

	it("binds the target account and disclosure to the approval", () => {
		const base = {
			brandId: "selena",
			channel: "LINKEDIN",
			contentHash: "content",
			assetBundleHash: "assets",
			policyVersion: "brand-pack/v1",
			disclosure: { paid: false },
		};
		expect(approvalBindingHash({ ...base, channelAccountId: "account-a" })).not.toBe(
			approvalBindingHash({ ...base, channelAccountId: "account-b" }),
		);
		expect(approvalBindingHash({ ...base, channelAccountId: "account-a" })).not.toBe(
			approvalBindingHash({ ...base, brandId: "other-brand", channelAccountId: "account-a" }),
		);
		expect(evaluateReleaseGate({ ...permittedGate, disclosureMatches: false })).toEqual({
			allowed: false,
			reason: "DISCLOSURE_MISMATCH",
		});
	});

	it("keeps duplicate release-intent requests stable while protecting the approval binding", () => {
		const base = { approvalId: "approval-a", bindingHash: "binding-a", channelAccountId: "account-a" };
		expect(releaseIntentIdempotencyKey(base)).toBe(releaseIntentIdempotencyKey(base));
		expect(releaseIntentIdempotencyKey(base)).not.toBe(
			releaseIntentIdempotencyKey({ ...base, bindingHash: "binding-b" }),
		);
		expect(createOpaqueWorkflowPayload({ correlationId: "correlation-a", releaseIntentId: "intent-a" })).toEqual({
			correlationId: "correlation-a",
			eventType: "release.intent_queued",
			eventVersion: 1,
			releaseIntentId: "intent-a",
		});
	});

	it("blocks an unallowlisted target account and an active kill switch", () => {
		expect(evaluateReleaseGate({ ...permittedGate, accountAllowlisted: false })).toEqual({
			allowed: false,
			reason: "ACCOUNT_NOT_ALLOWLISTED",
		});
		expect(evaluateReleaseGate({ ...permittedGate, killSwitchActive: true })).toEqual({
			allowed: false,
			reason: "KILL_SWITCH_ACTIVE",
		});
	});

	it("does not treat a service identity as a human approver", () => {
		expect(isInteractiveOwnerSession({ authType: "api_key", role: "owner" })).toBe(false);
		expect(isInteractiveOwnerSession({ authType: "session", role: "member" })).toBe(false);
		expect(isInteractiveOwnerSession({ authType: "session", role: "owner" })).toBe(true);
	});

	it("requires reconciliation instead of blind retry after an ambiguous provider result", () => {
		expect(classifyPublicationDispatch("NOT_SENT")).toEqual({ status: "RETRY_SAFE" });
		expect(classifyPublicationDispatch("AMBIGUOUS")).toEqual({ status: "RECONCILE_REQUIRED" });
	});
});

describe("describing where a version came from", () => {
	it("names Control Room for a version written here", () => {
		expect(describeOrigin({})).toEqual({
			source: "Control Room",
			synthetic: false,
			qaFailed: false,
			needsVerification: false,
		});
		expect(describeOrigin(null).source).toBe("Control Room");
	});

	it("names Aether and the kind of source, and says when the source is synthetic", () => {
		const projected = {
			origin: { system: "aether", project_id: "p", event_id: "e" },
			source: { kind: "SYNTHETIC_FIXTURE", ref: "aether://fixtures/growth-draft/v1", rights: "synthetic" },
			qa_results: [{ check: "NOVELTY", verdict: "UNKNOWN" }],
			qa_failed: false,
			needs_verification: true,
			synthetic: true,
		};
		expect(describeOrigin(projected)).toEqual({
			source: "Aether · SYNTHETIC_FIXTURE",
			synthetic: true,
			qaFailed: false,
			needsVerification: true,
		});
		expect(describeOrigin({ ...projected, source: { kind: "OWN" }, synthetic: false, qa_failed: true })).toMatchObject({
			source: "Aether · OWN",
			synthetic: false,
			qaFailed: true,
		});
	});
});

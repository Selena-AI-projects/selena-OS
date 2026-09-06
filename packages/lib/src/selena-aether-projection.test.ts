import { describe, expect, it } from "vitest";
import fixtures from "./contracts/control-room-event.v1.1.fixtures.json" with { type: "json" };
import { acceptEvent, isContentDraftEvent } from "./selena-aether-bridge";
import {
	PROJECTION_ACTOR,
	ProjectionRejected,
	projectDraftEvent,
	type ResolvedBinding,
} from "./selena-aether-projection";
import { disclosureBlocksApproval, evaluateReleaseGate, type ReleaseGateInput } from "./selena-control-room";

const SECRETS = [fixtures.secret];
function accepted(name: string) {
	const entry = fixtures.cases.find((c) => c.name === name);
	if (!entry) throw new Error(`fixture ${name} missing`);
	return acceptEvent(
		entry.body,
		{ signature: entry.signature, timestamp: entry.timestamp },
		SECRETS,
		new Date(Date.parse(entry.timestamp)),
	).envelope;
}
const binding: ResolvedBinding = {
	bindingId: "b",
	organizationId: "org-a",
	brandId: "brand-a",
	aetherBusinessKey: "selena",
};

const openGate: ReleaseGateInput = {
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
};

describe("projecting a material event", () => {
	it("maps the article into a content version input for the bound brand", () => {
		const envelope = accepted("accepted_article");
		const input = projectDraftEvent(envelope, binding, "policy-1");
		expect(input.organizationId).toBe("org-a");
		expect(input.brandId).toBe("brand-a");
		expect(input.kind).toBe("ARTICLE");
		expect(input.externalRef).toBe(envelope.aggregate_id);
		expect(input.version).toBe(1);
		expect(input.ctaUrl).toBe("https://www.selenasystems.com/visibility");
		expect(input.createdBy).toBe(PROJECTION_ACTOR);
		expect(input.disclosure.synthetic).toBe(true);
		expect(input.disclosure.origin.system).toBe("aether");
		expect(input.contentHash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("gives the two materials of one brief the same brief_ref and different aggregates", () => {
		const article = projectDraftEvent(accepted("accepted_article"), binding, "policy-1");
		const social = projectDraftEvent(accepted("accepted_social"), binding, "policy-1");
		expect(article.briefRef).toBe(social.briefRef);
		expect(article.externalRef).not.toBe(social.externalRef);
		expect(article.kind).toBe("ARTICLE");
		expect(social.kind).toBe("SOCIAL_ADAPTATION");
	});

	it("refuses a material whose business key is not the binding's", () => {
		expect(() =>
			projectDraftEvent(accepted("accepted_article"), { ...binding, aetherBusinessKey: "kora" }, "p"),
		).toThrow(ProjectionRejected);
		try {
			projectDraftEvent(accepted("accepted_article"), { ...binding, aetherBusinessKey: "kora" }, "p");
		} catch (error) {
			expect((error as ProjectionRejected).code).toBe("BUSINESS_KEY_MISMATCH");
		}
	});

	it("refuses a task event as a material", () => {
		const envelope = accepted("v1_event_still_accepted");
		expect(isContentDraftEvent(envelope)).toBe(false);
		expect(() => projectDraftEvent(envelope, binding, "p")).toThrow(/NOT_A_MATERIAL/);
	});

	it("marks QA failure and unknown claims in the disclosure the gate reads", () => {
		const clean = projectDraftEvent(accepted("accepted_article"), binding, "p");
		// The synthetic fixture carries one UNKNOWN claim on purpose.
		expect(clean.disclosure.needs_verification).toBe(true);
		expect(clean.disclosure.qa_failed).toBe(false);
		const failed = projectDraftEvent(accepted("qa_fail_is_still_accepted"), binding, "p");
		expect(failed.disclosure.qa_failed).toBe(true);
		const unknown = projectDraftEvent(accepted("qa_unknown_is_still_accepted"), binding, "p");
		expect(unknown.disclosure.needs_verification).toBe(true);
	});

	it("changes the content hash when the policy version changes", () => {
		const a = projectDraftEvent(accepted("accepted_article"), binding, "policy-1");
		const b = projectDraftEvent(accepted("accepted_article"), binding, "policy-2");
		expect(a.contentHash).not.toBe(b.contentHash);
	});
});

describe("what QA does to approval and release", () => {
	it("blocks the release gate before any approval is considered", () => {
		expect(evaluateReleaseGate({ ...openGate, qaFailed: true })).toEqual({ allowed: false, reason: "QA_FAILED" });
		expect(evaluateReleaseGate({ ...openGate, needsVerification: true })).toEqual({
			allowed: false,
			reason: "NEEDS_VERIFICATION",
		});
		expect(evaluateReleaseGate({ ...openGate, humanApproval: false, qaFailed: true })).toEqual({
			allowed: false,
			reason: "QA_FAILED",
		});
		expect(evaluateReleaseGate(openGate)).toEqual({ allowed: true });
	});

	it("reads the flags from a projected disclosure and ignores a human-authored one", () => {
		const failed = projectDraftEvent(accepted("qa_fail_is_still_accepted"), binding, "p").disclosure;
		// The fixture keeps its UNKNOWN claim, so both flags are raised.
		expect(disclosureBlocksApproval(failed)).toEqual({ qaFailed: true, needsVerification: true });
		expect(disclosureBlocksApproval({})).toEqual({ qaFailed: false, needsVerification: false });
		expect(disclosureBlocksApproval(null)).toEqual({ qaFailed: false, needsVerification: false });
	});
});

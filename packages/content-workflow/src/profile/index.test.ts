import { describe, expect, it } from "vitest";
import {
	allowedClaimFacts,
	ContentProfileError,
	normalizeProfile,
	type ProjectProfileInput,
	profileHash,
	validateDecision,
} from "./index";

const input: ProjectProfileInput = {
	languages: ["en"],
	audience: { primary: "Food hall guests", secondary: [], needs: ["menus"] },
	voice: { traits: ["warm"], examples: [], exclusions: ["unverified claims"] },
	ctaRules: ["Visit the website"],
	visualRules: { palette: ["terracotta"], imagery: ["real food"], avoid: [] },
	claimRules: { requireSources: true, allowedStates: ["VERIFIED"] },
	facts: [{ id: "city", statement: "Bali", state: "VERIFIED", sourceRefs: ["https://example.com/kora"] }],
	sourceRefs: [{ uri: "https://example.com/kora", title: "KORA" }],
};

describe("project profile domain", () => {
	it("normalizes equivalent input to a stable hash", () => {
		const first = normalizeProfile(input);
		const second = normalizeProfile({ ...input, audience: { ...input.audience, secondary: [] } });
		expect(profileHash(first)).toBe(profileHash(second));
	});

	it("requires evidence for verified facts", () => {
		const verifiedFact = input.facts?.[0];
		if (!verifiedFact) throw new Error("test fixture is missing a verified fact");
		try {
			normalizeProfile({ ...input, facts: [{ ...verifiedFact, sourceRefs: [] }] });
			throw new Error("expected normalizeProfile to reject the fact");
		} catch (error) {
			expect(error).toBeInstanceOf(ContentProfileError);
			expect((error as ContentProfileError).code).toBe("VERIFIED_FACT_REQUIRES_SOURCE");
		}
	});

	it("requires a reason when revoking", () => {
		try {
			validateDecision({ organizationId: "org", brandId: "brand", profileVersionId: "v1", decision: "REVOKED" });
			throw new Error("expected validateDecision to reject the revocation");
		} catch (error) {
			expect(error).toBeInstanceOf(ContentProfileError);
			expect((error as ContentProfileError).code).toBe("REVOCATION_REASON_REQUIRED");
		}
	});

	it("keeps prohibited facts out of factual claim context", () => {
		const facts = input.facts ?? [];
		const profile = normalizeProfile({
			...input,
			facts: [
				...facts,
				{ id: "unknown", statement: "Unverified", state: "UNKNOWN", sourceRefs: [] },
				{ id: "prohibited", statement: "Do not claim this", state: "PROHIBITED", sourceRefs: [] },
			],
		});
		expect(allowedClaimFacts(profile).map((fact) => fact.id)).toEqual(["city"]);
	});
});

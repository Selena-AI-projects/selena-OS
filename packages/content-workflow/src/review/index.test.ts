import { describe, expect, it } from "vitest";
import {
	assertApprovableAssetBundle,
	ContentReviewError,
	type ReviewableAsset,
	stageForDecision,
	validateEditorialDecision,
} from "./index";

const future = new Date(Date.now() + 86_400_000).toISOString();
const past = new Date(Date.now() - 86_400_000).toISOString();

function cleanAsset(overrides: Partial<ReviewableAsset> = {}): ReviewableAsset {
	return {
		id: "a1",
		sha256: "0".repeat(64),
		scanStatus: "CLEAN",
		rightsExpiresAt: future,
		consentExpiresAt: future,
		...overrides,
	};
}

describe("editorial review domain", () => {
	it("requires a reason for every non-approval", () => {
		expect(() => validateEditorialDecision({ decision: "CHANGES_REQUESTED" })).toThrowError(ContentReviewError);
		expect(() => validateEditorialDecision({ decision: "REJECTED", reason: "  " })).toThrowError(/reason/);
		expect(() => validateEditorialDecision({ decision: "APPROVED" })).not.toThrow();
		expect(() => validateEditorialDecision({ decision: "REJECTED", reason: "off-brand claims" })).not.toThrow();
	});

	it("lets an empty asset bundle through and a clean one too", () => {
		expect(() => assertApprovableAssetBundle([])).not.toThrow();
		expect(() => assertApprovableAssetBundle([cleanAsset()])).not.toThrow();
	});

	it("refuses a bundle with any non-clean asset", () => {
		for (const scanStatus of ["QUARANTINED", "SCANNING", "REJECTED"] as const) {
			try {
				assertApprovableAssetBundle([cleanAsset(), cleanAsset({ id: "a2", scanStatus })]);
				throw new Error("expected the bundle to be refused");
			} catch (error) {
				expect(error).toBeInstanceOf(ContentReviewError);
				expect((error as ContentReviewError).code).toBe("ASSET_NOT_CLEAN");
			}
		}
	});

	it("refuses expired or missing rights and consent", () => {
		try {
			assertApprovableAssetBundle([cleanAsset({ rightsExpiresAt: past })]);
			throw new Error("expected rights to be refused");
		} catch (error) {
			expect((error as ContentReviewError).code).toBe("ASSET_RIGHTS_EXPIRED");
		}
		try {
			assertApprovableAssetBundle([cleanAsset({ consentExpiresAt: null })]);
			throw new Error("expected consent to be refused");
		} catch (error) {
			expect((error as ContentReviewError).code).toBe("ASSET_CONSENT_EXPIRED");
		}
	});

	it("maps decisions to workflow stages", () => {
		expect(stageForDecision("APPROVED")).toBe("APPROVED");
		expect(stageForDecision("CHANGES_REQUESTED")).toBe("SCRIPT_DRAFTED");
		expect(stageForDecision("REJECTED")).toBe("ARCHIVED");
	});
});

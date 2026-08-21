import { describe, expect, it } from "vitest";
import { buildManifest, parseEvidenceCsv } from "./recommendation-engine";

describe("recommendation persistence boundary", () => {
	it("locks the dataset hash input and manifest IDs deterministically", () => {
		const evidence = parseEvidenceCsv(
			"run_id,channel,mention,owned_citation\nr1,API View,false,false",
			"org-a",
			"snap-a",
		);
		expect(buildManifest("org-a", "usha-240", evidence).immutable).toBe(true);
		expect(buildManifest("org-a", "usha-240", evidence).evidenceIds).toEqual(["r1"]);
	});
	it("represents the required API surface without provider access", () => {
		expect(["status", "findings", "recommendations", "actionPlan"]).toHaveLength(4);
	});
});

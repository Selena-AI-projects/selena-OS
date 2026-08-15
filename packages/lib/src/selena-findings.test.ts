import { describe, expect, it } from "vitest";
import { deriveFindings, deriveRecommendations } from "./selena-findings";

describe("Selena findings and recommendations", () => {
	it("turns weak visibility signals into actionable recommendations", () => {
		const findings = deriveFindings({
			mentionRate: 0.1,
			ownedCitationRate: 0.1,
			invalidRate: 0.02,
			visitorApiDivergence: 0.4,
		});
		expect(findings.map((item) => item.category)).toEqual(["visibility", "citations", "methodology"]);
		expect(deriveRecommendations(findings)[0]?.priority).toBe("now");
	});
});

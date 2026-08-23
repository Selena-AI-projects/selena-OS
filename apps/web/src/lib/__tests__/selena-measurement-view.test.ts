import { describe, expect, it } from "vitest";
import type { LedgerGroup } from "@workspace/lib/selena-ledger-metrics";
import { formatShare, groupView, scenarioKindsFrom } from "@/lib/selena-measurement-view";

describe("scenarioKindsFrom", () => {
	it("maps only the two known kinds and leaves the rest unclassified", () => {
		const kinds = scenarioKindsFrom([
			{ id: "s1", intentType: "branded" },
			{ id: "s2", intentType: "discovery" },
			{ id: "s3", intentType: "comparison" },
		]);
		expect(kinds.get("s1")).toBe("branded");
		expect(kinds.get("s2")).toBe("discovery");
		expect(kinds.has("s3")).toBe(false);
	});
});

describe("groupView", () => {
	it("renders an empty group as unknown, never as 0%", () => {
		const group: LedgerGroup = { status: "UNKNOWN", reason: "NO_MEASURED_RUNS", runs: 3 };
		expect(groupView(group)).toEqual({ state: "unknown", runs: 3 });
	});

	it("separates measured from stored-but-unmeasured runs", () => {
		const group = {
			status: "MEASURED",
			metrics: {
				totalRuns: 6,
				validRuns: 5,
				unmeasuredRuns: 2,
				invalidRate: null,
				mentionCoverage: 0.5,
				stableMentionRate: null,
				ownedCitationRate: null,
				citationCoverage: null,
				averageBrandPosition: 2,
				relativeMentionShare: { brand: null, competitors: [] },
				visitorApiDivergence: { visitorMentionRate: null, apiMentionRate: null, divergence: null },
				captureModes: {},
			},
		} as LedgerGroup;
		expect(groupView(group)).toEqual({
			state: "measured",
			measuredRuns: 3,
			unmeasuredRuns: 2,
			mentionCoverage: "50%",
			averageBrandPosition: 2,
		});
	});
});

describe("formatShare", () => {
	it("keeps unmeasured null instead of inventing a number", () => {
		expect(formatShare(null)).toBeNull();
		expect(formatShare(undefined)).toBeNull();
	});

	it("formats a real 0 as 0% — measured absence is not unknown", () => {
		expect(formatShare(0)).toBe("0%");
		expect(formatShare(2 / 3)).toBe("67%");
	});
});

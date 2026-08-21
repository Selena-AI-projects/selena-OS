import { describe, expect, it } from "vitest";
import { type LedgerRow, computeLedgerMetrics, computeLedgerReport } from "./selena-ledger-metrics";

const row = (overrides: Partial<LedgerRow>): LedgerRow => ({
	scenarioId: "s1",
	system: "chatgpt",
	channel: "visitor_view",
	validity: "VALID",
	mention: false,
	position: null,
	ownedCitation: false,
	citations: [],
	competitors: [],
	...overrides,
});

describe("computeLedgerMetrics", () => {
	it("computes every §12 rate from one coherent set of rows", () => {
		const rows: LedgerRow[] = [
			row({ mention: true, position: 1, ownedCitation: true, citations: [{ url: "https://a", domain: "a" }] }),
			row({ mention: true, position: 3, competitors: ["Rival"], citations: [{ url: "https://b", domain: "b" }] }),
			row({ scenarioId: "s2", competitors: ["Rival", "Other"] }),
			row({ scenarioId: "s2", channel: "api_view", validity: "INVALID" }),
		];
		const metrics = computeLedgerMetrics(rows);
		expect(metrics.totalRuns).toBe(4);
		expect(metrics.validRuns).toBe(3);
		expect(metrics.invalidRate).toBeCloseTo(1 / 4);
		expect(metrics.mentionRate).toBeCloseTo(2 / 3);
		// s1×chatgpt mentions on every repeat; s2×chatgpt never does.
		expect(metrics.stableMentionRate).toBeCloseTo(1 / 2);
		expect(metrics.ownedCitationRate).toBeCloseTo(1 / 3);
		expect(metrics.citationCoverage).toBeCloseTo(2 / 3);
		expect(metrics.averagePosition).toBeCloseTo(2);
		// 2 brand mentions against 3 competitor appearances.
		expect(metrics.shareOfVoice.brand).toBeCloseTo(2 / 5);
		expect(metrics.shareOfVoice.competitors).toEqual([
			{ name: "Rival", mentions: 2, share: 2 / 5 },
			{ name: "Other", mentions: 1, share: 1 / 5 },
		]);
	});

	it("averages position over mentions only and reports null when nothing mentions", () => {
		const metrics = computeLedgerMetrics([row({}), row({ scenarioId: "s2" })]);
		expect(metrics.mentionRate).toBe(0);
		expect(metrics.averagePosition).toBeNull();
		expect(metrics.shareOfVoice.brand).toBeNull();
	});

	it("keeps unmeasured VALID rows out of evidence denominators instead of scoring them as non-mentions", () => {
		// Five measured rows all mention the brand; five stored without
		// extraction. The true mention rate among measured evidence is 100%.
		const rows: LedgerRow[] = [
			...Array.from({ length: 5 }, (_, i) =>
				row({ scenarioId: `s${i}`, mention: true, position: 1, citations: [{ url: `https://a/${i}`, domain: "a" }] }),
			),
			...Array.from({ length: 5 }, (_, i) =>
				row({
					scenarioId: `s${i}`,
					mention: null,
					ownedCitation: null,
					citations: null,
					competitors: null,
					system: null,
				}),
			),
		];
		const metrics = computeLedgerMetrics(rows);
		expect(metrics.validRuns).toBe(10);
		expect(metrics.unmeasuredRuns).toBe(5);
		expect(metrics.mentionRate).toBe(1);
		expect(metrics.stableMentionRate).toBe(1);
		expect(metrics.citationCoverage).toBe(1);
	});

	it("keeps unfinished rows out of every denominator", () => {
		const metrics = computeLedgerMetrics([row({ validity: null }), row({ mention: true, position: 1 })]);
		expect(metrics.totalRuns).toBe(1);
		expect(metrics.invalidRate).toBe(0);
		expect(metrics.mentionRate).toBe(1);
	});

	it("reports visitor/API divergence and leaves it null when one side is absent", () => {
		const both = computeLedgerMetrics([
			row({ mention: true, position: 1 }),
			row({ channel: "api_view", mention: false }),
		]);
		expect(both.visitorApiDivergence.visitorMentionRate).toBe(1);
		expect(both.visitorApiDivergence.apiMentionRate).toBe(0);
		expect(both.visitorApiDivergence.divergence).toBe(1);

		const visitorOnly = computeLedgerMetrics([row({ mention: true, position: 2 })]);
		expect(visitorOnly.visitorApiDivergence.apiMentionRate).toBeNull();
		expect(visitorOnly.visitorApiDivergence.divergence).toBeNull();
	});

	it("recognizes dispatch-style channel names", () => {
		const metrics = computeLedgerMetrics([
			row({ channel: "VISITOR", mention: true, position: 1 }),
			row({ channel: "API" }),
		]);
		expect(metrics.visitorApiDivergence.visitorMentionRate).toBe(1);
		expect(metrics.visitorApiDivergence.apiMentionRate).toBe(0);
	});
});

describe("computeLedgerReport", () => {
	it("keeps branded and discovery apart and never guesses a bucket", () => {
		const rows = [
			row({ scenarioId: "branded-1", mention: true, position: 1 }),
			row({ scenarioId: "discovery-1" }),
			row({ scenarioId: "unknown-1", mention: true, position: 2 }),
		];
		const report = computeLedgerReport(
			rows,
			new Map([
				["branded-1", "branded"],
				["discovery-1", "discovery"],
			]),
		);
		expect(report.branded?.mentionRate).toBe(1);
		expect(report.discovery?.mentionRate).toBe(0);
		expect(report.unclassifiedRuns).toBe(1);
	});

	it("returns null blocks rather than empty-set rates", () => {
		const report = computeLedgerReport([row({})], new Map());
		expect(report.branded).toBeNull();
		expect(report.discovery).toBeNull();
		expect(report.unclassifiedRuns).toBe(1);
	});
});

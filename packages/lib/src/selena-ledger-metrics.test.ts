import { describe, expect, it } from "vitest";
import { computeLedgerMetrics, computeLedgerReport, type LedgerMention, type LedgerRow } from "./selena-ledger-metrics";

const row = (runId: string, overrides: Partial<LedgerRow> = {}): LedgerRow => ({
	runId,
	scenarioId: "s1",
	system: "chatgpt",
	channel: "visitor_view",
	validity: "VALID",
	extractorVersion: "selena-extract/1",
	ownedCitation: false,
	citations: [],
	finishedAt: null,
	...overrides,
});

const brand = (runId: string, ordinalPosition: number | null = null): LedgerMention => ({
	runId,
	entityType: "BRAND",
	name: "KORA",
	ordinalPosition,
});

const competitor = (runId: string, name: string, ordinalPosition: number | null = null): LedgerMention => ({
	runId,
	entityType: "COMPETITOR",
	name,
	ordinalPosition,
});

describe("computeLedgerMetrics", () => {
	it("computes every §12 rate from one coherent set of rows", () => {
		const rows: LedgerRow[] = [
			row("r1", { ownedCitation: true, citations: [{ url: "https://a", domain: "a" }] }),
			row("r2", { citations: [{ url: "https://b", domain: "b" }] }),
			row("r3", { scenarioId: "s2" }),
			row("r4", { scenarioId: "s2", channel: "api_view", validity: "INVALID", extractorVersion: null }),
		];
		const mentions = [
			brand("r1", 1),
			brand("r2", 3),
			competitor("r2", "Rival", 1),
			competitor("r3", "Rival"),
			competitor("r3", "Other"),
		];
		const metrics = computeLedgerMetrics(rows, mentions);
		expect(metrics.totalRuns).toBe(4);
		expect(metrics.validRuns).toBe(3);
		expect(metrics.invalidRate).toBeCloseTo(1 / 4);
		expect(metrics.mentionCoverage).toBeCloseTo(2 / 3);
		// s1×chatgpt mentions on every repeat; s2×chatgpt never does.
		expect(metrics.stableMentionRate).toBeCloseTo(1 / 2);
		expect(metrics.ownedCitationRate).toBeCloseTo(1 / 3);
		expect(metrics.citationCoverage).toBeCloseTo(2 / 3);
		expect(metrics.averageBrandPosition).toBeCloseTo(2);
		// 2 brand mentions against 3 competitor appearances.
		expect(metrics.relativeMentionShare.brand).toBeCloseTo(2 / 5);
		expect(metrics.relativeMentionShare.competitors).toEqual([
			{ name: "Rival", mentions: 2, share: 2 / 5 },
			{ name: "Other", mentions: 1, share: 1 / 5 },
		]);
	});

	it("averages position over mentions only and reports null when nothing mentions", () => {
		const metrics = computeLedgerMetrics([row("r1"), row("r2", { scenarioId: "s2" })], []);
		expect(metrics.mentionCoverage).toBe(0);
		expect(metrics.averageBrandPosition).toBeNull();
		expect(metrics.relativeMentionShare.brand).toBeNull();
	});

	it("counts a mention with no ranking as a mention without a position", () => {
		const metrics = computeLedgerMetrics([row("r1")], [brand("r1")]);
		expect(metrics.mentionCoverage).toBe(1);
		expect(metrics.averageBrandPosition).toBeNull();
	});

	it("keeps unmeasured VALID rows out of evidence denominators instead of scoring them as non-mentions", () => {
		// Five measured rows all mention the brand; five stored without
		// extraction. The true mention rate among measured evidence is 100%.
		const rows: LedgerRow[] = [
			...Array.from({ length: 5 }, (_, i) =>
				row(`m${i}`, { scenarioId: `s${i}`, citations: [{ url: `https://a/${i}`, domain: "a" }] }),
			),
			...Array.from({ length: 5 }, (_, i) =>
				row(`u${i}`, {
					scenarioId: `s${i}`,
					extractorVersion: null,
					ownedCitation: null,
					citations: null,
					system: null,
				}),
			),
		];
		const metrics = computeLedgerMetrics(
			rows,
			Array.from({ length: 5 }, (_, i) => brand(`m${i}`, 1)),
		);
		expect(metrics.validRuns).toBe(10);
		expect(metrics.unmeasuredRuns).toBe(5);
		expect(metrics.mentionCoverage).toBe(1);
		expect(metrics.stableMentionRate).toBe(1);
		expect(metrics.citationCoverage).toBe(1);
	});

	it("keeps unfinished rows out of every denominator", () => {
		const metrics = computeLedgerMetrics([row("r1", { validity: null }), row("r2")], [brand("r2", 1)]);
		expect(metrics.totalRuns).toBe(1);
		expect(metrics.invalidRate).toBe(0);
		expect(metrics.mentionCoverage).toBe(1);
	});

	it("ignores mention rows that belong to runs outside the set being measured", () => {
		const metrics = computeLedgerMetrics(
			[row("r1")],
			[brand("other-cycle-run", 1), competitor("other-cycle-run", "X")],
		);
		expect(metrics.mentionCoverage).toBe(0);
		expect(metrics.relativeMentionShare.competitors).toEqual([]);
	});

	it("lets a duplicated mention row neither inflate coverage nor move the average", () => {
		const metrics = computeLedgerMetrics(
			[row("r1"), row("r2", { scenarioId: "s2" })],
			[brand("r1", 4), brand("r1", 2), competitor("r1", "Rival"), competitor("r1", "Rival")],
		);
		expect(metrics.mentionCoverage).toBe(1 / 2);
		expect(metrics.averageBrandPosition).toBe(2);
		expect(metrics.relativeMentionShare.competitors).toEqual([{ name: "Rival", mentions: 1, share: 1 / 2 }]);
	});

	it("reports visitor/API divergence and leaves it null when one side is absent", () => {
		const both = computeLedgerMetrics([row("r1"), row("r2", { channel: "api_view" })], [brand("r1", 1)]);
		expect(both.visitorApiDivergence.visitorMentionRate).toBe(1);
		expect(both.visitorApiDivergence.apiMentionRate).toBe(0);
		expect(both.visitorApiDivergence.divergence).toBe(1);

		const visitorOnly = computeLedgerMetrics([row("r1")], [brand("r1", 2)]);
		expect(visitorOnly.visitorApiDivergence.apiMentionRate).toBeNull();
		expect(visitorOnly.visitorApiDivergence.divergence).toBeNull();
	});

	it("recognizes dispatch-style channel names", () => {
		const metrics = computeLedgerMetrics(
			[row("r1", { channel: "VISITOR" }), row("r2", { channel: "API" })],
			[brand("r1", 1)],
		);
		expect(metrics.visitorApiDivergence.visitorMentionRate).toBe(1);
		expect(metrics.visitorApiDivergence.apiMentionRate).toBe(0);
	});
});

describe("computeLedgerReport", () => {
	it("keeps branded and discovery apart and never guesses a bucket", () => {
		const rows = [
			row("r1", { scenarioId: "branded-1" }),
			row("r2", { scenarioId: "discovery-1" }),
			row("r3", { scenarioId: "unknown-1" }),
		];
		const report = computeLedgerReport(
			rows,
			[brand("r1", 1), brand("r3", 2)],
			new Map([
				["branded-1", "branded"],
				["discovery-1", "discovery"],
			]),
		);
		expect(report.branded?.mentionCoverage).toBe(1);
		expect(report.discovery?.mentionCoverage).toBe(0);
		expect(report.unclassifiedRuns).toBe(1);
	});

	it("returns null blocks rather than empty-set rates", () => {
		const report = computeLedgerReport([row("r1")], [], new Map());
		expect(report.branded).toBeNull();
		expect(report.discovery).toBeNull();
		expect(report.unclassifiedRuns).toBe(1);
	});
});

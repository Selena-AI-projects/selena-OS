import { describe, expect, it } from "vitest";
import { CITATION_GAP_FORMULA_VERSION, computeCitationGaps } from "./selena-citation-gap";
import type { LedgerMention, LedgerRow } from "./selena-ledger-metrics";

const cite = (domain: string, path = "/") => ({ url: `https://${domain}${path}`, domain });

const row = (runId: string, overrides: Partial<LedgerRow> = {}): LedgerRow => ({
	runId,
	scenarioId: "s1",
	system: "chatgpt",
	channel: "api_view",
	validity: "VALID",
	extractorVersion: "selena-extract/1",
	ownedCitation: false,
	citations: [],
	finishedAt: new Date("2026-08-21T10:00:00.000Z"),
	captureMode: "live_search",
	...overrides,
});

const brand = (runId: string): LedgerMention => ({
	runId,
	entityType: "BRAND",
	name: "KORA Food Hall",
	ordinalPosition: 1,
	captureMode: "live_search",
});

const competitor = (runId: string, name: string): LedgerMention => ({
	runId,
	entityType: "COMPETITOR",
	name,
	ordinalPosition: 1,
	captureMode: "live_search",
});

const OWNED = ["korafoodhall.com"];

describe("computeCitationGaps", () => {
	it("reports a source seen only alongside competitors as a gap", () => {
		const report = computeCitationGaps({
			rows: [row("r1", { citations: [cite("guide.example")] }), row("r2", { citations: [cite("guide.example")] })],
			mentions: [competitor("r1", "Rival Cafe"), competitor("r2", "Rival Cafe")],
			ownedDomains: OWNED,
		});
		expect(report.formulaVersion).toBe(CITATION_GAP_FORMULA_VERSION);
		expect(report.gaps).toHaveLength(1);
		const [gap] = report.gaps;
		expect(gap.domain).toBe("guide.example");
		expect(gap.gapType).toBe("COMPETITOR_ONLY_SOURCE");
		expect(gap.competitorCitationCount).toBe(2);
		expect(gap.ownedCitationCount).toBe(0);
		expect(gap.evidenceRunIds).toEqual(["r1", "r2"]);
	});

	it("feeds Visitor View evidence into the same canonical formula", () => {
		// Surface-displayed sources arrive as extraction citations on
		// visitor_view rows; there is one gap number, not a per-channel fork.
		const report = computeCitationGaps({
			rows: [
				row("v1", { channel: "visitor_view", system: "chatgpt", citations: [cite("guide.example")] }),
				row("v2", { channel: "visitor_view", system: "perplexity", citations: [cite("guide.example")] }),
			],
			mentions: [competitor("v1", "Rival Cafe"), competitor("v2", "Rival Cafe")],
			ownedDomains: OWNED,
		});
		expect(report.formulaVersion).toBe(CITATION_GAP_FORMULA_VERSION);
		expect(report.gaps).toHaveLength(1);
		expect(report.gaps[0].domain).toBe("guide.example");
		expect(report.gaps[0].competitorCitationCount).toBe(2);
	});

	it("does not call a source a gap once it has turned up in an answer naming the brand", () => {
		const report = computeCitationGaps({
			rows: [
				row("r1", { citations: [cite("guide.example")] }),
				row("r2", { citations: [cite("guide.example")] }),
				row("r3", { citations: [cite("guide.example")] }),
			],
			mentions: [competitor("r1", "Rival Cafe"), competitor("r2", "Rival Cafe"), brand("r3")],
			ownedDomains: OWNED,
		});
		expect(report.gaps).toEqual([]);
		expect(report.sources[0].ownedCitationCount).toBe(1);
		expect(report.sources[0].competitorCitationCount).toBe(2);
	});

	it("leaves the brand's own pages out of the opportunity map", () => {
		const report = computeCitationGaps({
			rows: [
				row("r1", { citations: [cite("korafoodhall.com"), cite("menu.korafoodhall.com"), cite("guide.example")] }),
			],
			mentions: [competitor("r1", "Rival Cafe")],
			ownedDomains: OWNED,
		});
		expect(report.sources.map((source) => source.domain)).toEqual(["guide.example"]);
	});

	it("computes over measured evidence only", () => {
		const report = computeCitationGaps({
			rows: [
				row("r1", { validity: "INVALID", citations: [cite("guide.example")] }),
				row("r2", { extractorVersion: null, citations: [cite("guide.example")] }),
				row("r3", { validity: null, citations: [cite("guide.example")] }),
			],
			mentions: [competitor("r1", "Rival Cafe"), competitor("r2", "Rival Cafe")],
			ownedDomains: OWNED,
		});
		expect(report.measuredRuns).toBe(0);
		expect(report.sources).toEqual([]);
	});

	it("measures how reliably a source comes back across the repeats of one question", () => {
		const rows = [
			row("r1", { citations: [cite("steady.example"), cite("rare.example")] }),
			row("r2", { citations: [cite("steady.example")] }),
			row("r3", { citations: [cite("steady.example")] }),
		];
		const mentions = ["r1", "r2", "r3"].map((runId) => competitor(runId, "Rival Cafe"));
		const report = computeCitationGaps({ rows, mentions, ownedDomains: OWNED });
		const byDomain = new Map(report.sources.map((source) => [source.domain, source]));
		expect(byDomain.get("steady.example")?.repeatStability).toBe(1);
		expect(byDomain.get("rare.example")?.repeatStability).toBeCloseTo(1 / 3);
	});

	it("counts a source cited twice in one answer as one sighting in that run", () => {
		const report = computeCitationGaps({
			rows: [row("r1", { citations: [cite("guide.example", "/a"), cite("guide.example", "/b")] })],
			mentions: [competitor("r1", "Rival Cafe")],
			ownedDomains: OWNED,
		});
		const [source] = report.sources;
		expect(source.evidenceRunIds).toEqual(["r1"]);
		expect(source.competitorCitationCount).toBe(1);
		expect(source.repeatStability).toBe(1);
		expect(source.urls).toEqual(["https://guide.example/a", "https://guide.example/b"]);
	});

	it("raises priority only on signals a reader can check", () => {
		const spread = computeCitationGaps({
			rows: [
				row("r1", { citations: [cite("guide.example")] }),
				row("r2", { scenarioId: "s2", system: "perplexity", citations: [cite("guide.example")] }),
			],
			mentions: [competitor("r1", "Rival Cafe"), competitor("r2", "Other Place")],
			ownedDomains: OWNED,
		});
		expect(spread.sources[0].priorityBand).toBe("HIGH");
		expect(spread.sources[0].competitorNames).toEqual(["Other Place", "Rival Cafe"]);

		const narrow = computeCitationGaps({
			rows: [row("r1", { citations: [cite("guide.example")] })],
			mentions: [competitor("r1", "Rival Cafe")],
			ownedDomains: OWNED,
		});
		expect(narrow.sources[0].priorityBand).toBe("LOW");
	});

	it("dates a source by the runs that saw it", () => {
		const report = computeCitationGaps({
			rows: [
				row("r1", { finishedAt: new Date("2026-08-20T09:00:00.000Z"), citations: [cite("guide.example")] }),
				row("r2", { finishedAt: new Date("2026-08-22T09:00:00.000Z"), citations: [cite("guide.example")] }),
			],
			mentions: [competitor("r1", "Rival Cafe")],
			ownedDomains: OWNED,
		});
		expect(report.sources[0].firstSeen?.toISOString()).toBe("2026-08-20T09:00:00.000Z");
		expect(report.sources[0].lastSeen?.toISOString()).toBe("2026-08-22T09:00:00.000Z");
	});

	it("ignores citation entries that carry no usable url or domain", () => {
		const report = computeCitationGaps({
			rows: [
				row("r1", { citations: [{ url: "  ", domain: "guide.example" }, { url: "https://x", domain: "" }, "nope"] }),
			],
			mentions: [competitor("r1", "Rival Cafe")],
			ownedDomains: OWNED,
		});
		expect(report.sources).toEqual([]);
	});
});

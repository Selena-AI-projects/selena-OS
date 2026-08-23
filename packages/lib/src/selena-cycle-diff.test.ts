import { describe, expect, it } from "vitest";
import { computeCycleDiff, CYCLE_DIFF_FORMULA_VERSION } from "./selena-cycle-diff";
import type { LedgerMention, LedgerRow } from "./selena-ledger-metrics";

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
	captureMode: "training_data",
	...overrides,
});

const brand = (runId: string, position: number | null = 1): LedgerMention => ({
	runId,
	entityType: "BRAND",
	name: "KORA Food Hall",
	ordinalPosition: position,
	captureMode: "training_data",
});

describe("computeCycleDiff", () => {
	it("reports a mention that appeared, with the runs that prove it", () => {
		const report = computeCycleDiff(
			{ rows: [row("b1")], mentions: [] },
			{ rows: [row("c1")], mentions: [brand("c1")] },
		);
		expect(report.formulaVersion).toBe(CYCLE_DIFF_FORMULA_VERSION);
		expect(report.changes).toEqual([
			{
				type: "MENTION_APPEARED",
				scenarioId: "s1",
				system: "chatgpt",
				evidence: { baseRunIds: ["b1"], compareRunIds: ["c1"] },
			},
		]);
	});

	it("reports a disappearance and a position shift separately", () => {
		const report = computeCycleDiff(
			{
				rows: [row("b1"), row("b2", { scenarioId: "s2" })],
				mentions: [brand("b1", 1), brand("b2", 2)],
			},
			{
				rows: [row("c1"), row("c2", { scenarioId: "s2" })],
				mentions: [brand("c2", 4)],
			},
		);
		expect(report.changes).toEqual([
			{
				type: "MENTION_DISAPPEARED",
				scenarioId: "s1",
				system: "chatgpt",
				evidence: { baseRunIds: ["b1"], compareRunIds: ["c1"] },
			},
			{
				type: "POSITION_SHIFTED",
				scenarioId: "s2",
				system: "chatgpt",
				basePosition: 2,
				comparePosition: 4,
				evidence: { baseRunIds: ["b2"], compareRunIds: ["c2"] },
			},
		]);
	});

	it("marks a group present in only one cycle UNKNOWN instead of averaging it", () => {
		const report = computeCycleDiff(
			{ rows: [row("b1", { system: "chatgpt" })], mentions: [] },
			{ rows: [row("c1", { system: "perplexity" })], mentions: [brand("c1")] },
		);
		expect(report.changes).toEqual([]);
		expect(report.groups).toEqual([
			{ scenarioId: "s1", system: "chatgpt", status: "UNKNOWN", reason: "NOT_IN_COMPARE" },
			{ scenarioId: "s1", system: "perplexity", status: "UNKNOWN", reason: "NOT_IN_BASE" },
		]);
	});

	it("keeps unmeasured runs out of the comparison entirely", () => {
		const report = computeCycleDiff(
			{ rows: [row("b1", { validity: "INVALID" }), row("b2", { extractorVersion: null })], mentions: [] },
			{ rows: [row("c1")], mentions: [brand("c1")] },
		);
		// The base group has no measured runs, so it does not exist on that
		// side and the pair is incomparable — not a fabricated appearance.
		expect(report.changes).toEqual([]);
		expect(report.groups).toEqual([{ scenarioId: "s1", system: "chatgpt", status: "UNKNOWN", reason: "NOT_IN_BASE" }]);
	});

	it("diffs cited sources by domain in both directions", () => {
		const cite = (domain: string) => [{ url: `https://${domain}/x`, domain }];
		const report = computeCycleDiff(
			{ rows: [row("b1", { citations: cite("old.example") })], mentions: [brand("b1")] },
			{ rows: [row("c1", { citations: cite("new.example") })], mentions: [brand("c1")] },
		);
		expect(report.changes).toEqual([
			{
				type: "SOURCE_APPEARED",
				scenarioId: "s1",
				system: "chatgpt",
				domain: "new.example",
				evidence: { baseRunIds: ["b1"], compareRunIds: ["c1"] },
			},
			{
				type: "SOURCE_DISAPPEARED",
				scenarioId: "s1",
				system: "chatgpt",
				domain: "old.example",
				evidence: { baseRunIds: ["b1"], compareRunIds: ["c1"] },
			},
		]);
	});

	it("never says why — the report carries no causal field", () => {
		const report = computeCycleDiff(
			{ rows: [row("b1")], mentions: [] },
			{ rows: [row("c1")], mentions: [brand("c1")] },
		);
		expect(JSON.stringify(report).toLowerCase()).not.toContain("because");
	});
});

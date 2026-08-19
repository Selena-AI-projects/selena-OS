import { describe, expect, it } from "vitest";
import { expectedRunsFromScope, measurementScopeSchema, parseMeasurementScope } from "./measurement-scope";

const scenarioA = "00000000-0000-4000-8000-00000000000a";
const scenarioB = "00000000-0000-4000-8000-00000000000b";

const scope = {
	scenarios: [scenarioA, scenarioB],
	systems: [
		{ systemId: "chatgpt", channel: "VISITOR" as const },
		{ systemId: "perplexity", channel: "API" as const },
	],
	repeats: 3,
};

describe("measurementScopeSchema", () => {
	it("accepts a valid scope", () => {
		expect(measurementScopeSchema.parse(scope)).toEqual(scope);
	});

	it("rejects empty scenarios, empty systems and zero repeats", () => {
		expect(() => measurementScopeSchema.parse({ ...scope, scenarios: [] })).toThrow();
		expect(() => measurementScopeSchema.parse({ ...scope, systems: [] })).toThrow();
		expect(() => measurementScopeSchema.parse({ ...scope, repeats: 0 })).toThrow();
		expect(() => measurementScopeSchema.parse({ ...scope, repeats: 1.5 })).toThrow();
	});

	it("rejects duplicate scenarios and duplicate systems: the dispatch key could not tell them apart", () => {
		expect(() => measurementScopeSchema.parse({ ...scope, scenarios: [scenarioA, scenarioA] })).toThrow();
		expect(() =>
			measurementScopeSchema.parse({
				...scope,
				systems: [
					{ systemId: "chatgpt", channel: "VISITOR" },
					{ systemId: "chatgpt", channel: "API" },
				],
			}),
		).toThrow();
	});
});

describe("expectedRunsFromScope", () => {
	it("multiplies scenarios by systems by repeats", () => {
		expect(expectedRunsFromScope(measurementScopeSchema.parse(scope))).toBe(12);
		expect(expectedRunsFromScope(measurementScopeSchema.parse({ ...scope, repeats: 1 }))).toBe(4);
	});
});

describe("parseMeasurementScope", () => {
	it("returns the scope from a lock snapshot", () => {
		expect(parseMeasurementScope({ measurementScope: scope, other: "block" })).toEqual(scope);
	});

	it("returns null without throwing when the block is absent", () => {
		expect(parseMeasurementScope({})).toBeNull();
		expect(parseMeasurementScope({ measurementScope: null })).toBeNull();
		expect(parseMeasurementScope(null)).toBeNull();
		expect(parseMeasurementScope("snapshot")).toBeNull();
	});

	it("throws when the block is present but malformed", () => {
		expect(() => parseMeasurementScope({ measurementScope: { scenarios: [], systems: [], repeats: 0 } })).toThrow();
	});
});

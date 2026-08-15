import { describe, expect, it } from "vitest";
import { assertDirectDispatchAllowed, cardinalityExceeded, isMaintenanceEnabled } from "./controlled-cycle";

const base = {
	activeMaintenanceJobs: 0,
	activeCohortJobs: 0,
	cohortId: "cohort-1",
	expectedJobs: 6,
	expectedProviderCalls: 90,
	seenCohortIds: new Set<string>(),
};

describe("controlled cycle guards", () => {
	it("defaults maintenance to enabled", () => {
		expect(isMaintenanceEnabled(undefined)).toBe(true);
		expect(isMaintenanceEnabled("true")).toBe(true);
	});

	it("supports maintenance disabled", () => {
		expect(isMaintenanceEnabled("false")).toBe(false);
	});

	it("blocks direct dispatch while maintenance is active", () => {
		expect(() => assertDirectDispatchAllowed({ ...base, activeMaintenanceJobs: 1 })).toThrow(/maintenance/);
	});

	it("blocks duplicate cohort dispatch", () => {
		expect(() => assertDirectDispatchAllowed({ ...base, seenCohortIds: new Set(["cohort-1"]) })).toThrow(
			/already exists/,
		);
	});

	it("stops when jobs or provider calls exceed the plan", () => {
		expect(cardinalityExceeded(7, 90, base)).toBe(true);
		expect(cardinalityExceeded(6, 91, base)).toBe(true);
		expect(cardinalityExceeded(6, 90, base)).toBe(false);
	});

	it("allows a clean first dispatch", () => {
		expect(() => assertDirectDispatchAllowed(base)).not.toThrow();
	});
});

import { describe, expect, it } from "vitest";
import { assertDirectDispatchAllowed, assertTransportAllowed, cardinalityExceeded, isMaintenanceEnabled } from "./controlled-cycle";

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

	it("blocks global and order stops before transport and records an audit event", () => {
		const events: string[] = [];
		for (const stop of ["globalEmergencyStop", "orderStopped"] as const) {
			const state = { ...base, [stop]: true, audit: (event: { type: string }) => events.push(event.type) };
			expect(() => assertTransportAllowed(state)).toThrow(stop === "globalEmergencyStop" ? "SELENA_GLOBAL_EMERGENCY_STOP" : "SELENA_ORDER_STOPPED");
		}
		expect(events).toEqual(["GLOBAL_EMERGENCY_STOP", "ORDER_STOPPED"]);
	});

	it("blocks the next run at expected_runs + 1", () => {
		expect(cardinalityExceeded(7, 90, base)).toBe(true);
		expect(cardinalityExceeded(6, 90, base)).toBe(false);
	});
});

import { describe, expect, it } from "vitest";
import { createNoopMeasurementAdapter, planSelenaMeasurement, prepareSelenaDispatch } from "./selena-measurement";

describe("Selena controlled measurement seam", () => {
	it("deduplicates dispatch keys without contacting a provider", async () => {
		const permit = {
			cycleId: "c1",
			organizationId: "o1",
			scenarioId: "s1",
			channel: "api_view" as const,
			dispatchKey: "k1",
		};
		expect(planSelenaMeasurement([permit, permit])).toHaveLength(1);
		expect(await createNoopMeasurementAdapter("api_view").measure(permit)).toEqual({
			dispatchKey: "k1",
			status: "queued",
		});
	});
	it("hands only approved, bounded permits to the Elmo run-policy seam", () => {
		const state = {
			activeMaintenanceJobs: 0,
			activeCohortJobs: 0,
			cohortId: "selena-c1",
			expectedJobs: 1,
			expectedProviderCalls: 1,
			seenCohortIds: new Set<string>(),
		};
		const permit = {
			cycleId: "c1",
			organizationId: "o1",
			scenarioId: "s1",
			channel: "visitor_view" as const,
			dispatchKey: "k1",
		};
		expect(prepareSelenaDispatch(state, [permit])).toEqual([permit]);
		expect(() => prepareSelenaDispatch({ ...state, activeMaintenanceJobs: 1 }, [permit])).toThrow("maintenance jobs");
		expect(() => prepareSelenaDispatch({ ...state, expectedJobs: 0 }, [permit])).toThrow("SELENA_CARDINALITY_BLOCKED");
	});
});

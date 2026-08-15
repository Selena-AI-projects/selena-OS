import { describe, expect, it } from "vitest";
import { compareMonitoringSnapshots, planMonitoringCycle } from "./selena-monitoring";

describe("Selena monitoring controls", () => {
	it("compares visibility and recommendation changes", () => {
		const changes = compareMonitoringSnapshots(
			{
				collectedAt: "a",
				mentions: 1,
				citations: 2,
				positions: { q: 5 },
				competitors: ["x"],
				recommendationStatuses: { r: "OPEN" },
			},
			{
				collectedAt: "b",
				mentions: 2,
				citations: 1,
				positions: { q: 3 },
				competitors: ["y"],
				recommendationStatuses: { r: "DONE" },
			},
		);
		expect(changes.map((item) => item.metric)).toEqual(
			expect.arrayContaining(["mentions", "citations", "position:q", "competitors", "recommendation:r"]),
		);
	});

	it("blocks duplicate, budget, and cardinality dispatches", () => {
		const base = { cycleId: "c1", projectId: "p1", expectedRuns: 1, estimatedCost: 1, budgetCap: 2 };
		const ready = planMonitoringCycle(base);
		expect(ready.state).toBe("READY");
		expect(planMonitoringCycle({ ...base, existingDispatchKeys: [ready.dispatchKey] }).state).toBe("DUPLICATE");
		expect(planMonitoringCycle({ ...base, estimatedCost: 3 }).state).toBe("BUDGET_BLOCKED");
		expect(planMonitoringCycle({ ...base, expectedRuns: 101 }).state).toBe("CARDINALITY_BLOCKED");
	});
});

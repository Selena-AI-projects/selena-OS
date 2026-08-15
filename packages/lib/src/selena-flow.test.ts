import { describe, expect, it } from "vitest";
import { runSelenaFixtureFlow } from "./selena-flow";

const quote = {
	scenarioIds: ["scenario-1"],
	systems: [{ id: "fixture-runtime", channel: "API" as const }],
	repeats: 2,
};
const pricing = { baseAmount: 1, perRunAmount: 2, qcAmount: 1, marginRate: 0, currency: "USD" };
const row = (runId: string, validity = "valid") => ({
	runId,
	cycleId: "cycle-1",
	channel: "API View",
	brand: "Brand",
	scenarioId: "scenario-1",
	scenarioText: "What does Brand offer?",
	system: "fixture",
	model: "fixture",
	timestamp: "2026-08-15T00:00:00Z",
	language: "en",
	region: "",
	validity,
	rawResponseReference: "fixture://response",
	mention: "true",
	position: "1",
	ownedCitation: "true",
	citations: "https://example.test",
	competitors: "",
	factualErrors: "",
	tokenUsage: "",
	cost: "0",
	qcStatus: "PASS",
});

describe("Selena full fixture flow", () => {
	it("runs project confirmation, quote, test checkout boundary, runtime, action plan and export", () => {
		const result = runSelenaFixtureFlow({
			tenantId: "tenant-a",
			projectName: "Brand",
			website: "https://example.test",
			brandConfirmed: true,
			quote,
			pricing,
			budgetCap: 10,
			rows: [row("r1"), row("r2")],
		});
		expect(result.state).toBe("COMPLETE");
		expect(result.quote.expectedRuns).toBe(2);
		expect(result.runs).toHaveLength(2);
		expect(result.actionPlan).toHaveProperty("findings");
		expect(result.csv).not.toContain("secret");
		expect(result.audit.map((event) => event.event)).toContain("ORDER_APPROVED_TEST_MODE");
	});
	it("handles confirmation, budget, malformed and partial runtime cases", () => {
		expect(() =>
			runSelenaFixtureFlow({
				tenantId: "tenant-a",
				projectName: "Brand",
				website: "https://example.test",
				quote,
				pricing,
				budgetCap: 10,
				rows: [row("r1")],
			}),
		).toThrow("BRAND_CONFIRMATION_REQUIRED");
		expect(
			runSelenaFixtureFlow({
				tenantId: "tenant-a",
				projectName: "Brand",
				website: "https://example.test",
				brandConfirmed: true,
				quote,
				pricing,
				budgetCap: 1,
				rows: [],
			}).state,
		).toBe("BUDGET_BLOCKED");
		expect(
			runSelenaFixtureFlow({
				tenantId: "tenant-a",
				projectName: "Brand",
				website: "https://example.test",
				brandConfirmed: true,
				quote,
				pricing,
				budgetCap: 10,
				rows: [row("r1"), row("r2", "invalid")],
			}).state,
		).toBe("PARTIAL");
	});
});

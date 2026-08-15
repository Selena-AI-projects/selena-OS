import { describe, expect, it } from "vitest";
import { calculateQuote } from "./index";

describe("quote pricing", () => {
	it("prices exact approved cardinality", () => {
		expect(
			calculateQuote(
				{
					scenarioIds: ["00000000-0000-1000-8000-000000000001"],
					systems: [{ id: "chatgpt", channel: "VISITOR" }],
					repeats: 5,
				},
				{ baseAmount: 10, perRunAmount: 1, qcAmount: 5, marginRate: 0.2, currency: "USD" },
			),
		).toEqual({ expectedRuns: 5, amount: 24, currency: "USD" });
	});
});

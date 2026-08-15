import { describe, expect, it } from "vitest";
import { assertCardinality, dispatchKey, runRequestSchema } from "./index";

describe("Selena visibility contracts", () => {
	it("builds a deterministic dispatch key", () => {
		const input = {
			orderId: "00000000-0000-1000-8000-000000000001",
			scenarioId: "00000000-0000-1000-8000-000000000002",
			systemId: "chatgpt",
			channel: "VISITOR" as const,
			repeatIndex: 2,
			configurationVersion: 3,
		};
		expect(dispatchKey(runRequestSchema.parse(input))).toBe(
			"00000000-0000-1000-8000-000000000001:00000000-0000-1000-8000-000000000002:chatgpt:2:3",
		);
	});

	it("blocks the next run at the cardinality boundary", () => {
		expect(() => assertCardinality(3, 3)).toThrow("CARDINALITY_BLOCKED");
		expect(() => assertCardinality(2, 3)).not.toThrow();
	});
});

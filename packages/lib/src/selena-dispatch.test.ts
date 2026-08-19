import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type MeasurementScope, expectedRunsFromScope, measurementScopeSchema } from "@workspace/selena-visibility-contracts";
import { describe, expect, it } from "vitest";
import { assertLockExpectedRuns, assertQcDecision, planOrderDispatch } from "./selena-dispatch";

const orderId = "00000000-0000-4000-8000-000000000001";
const scenarioA = "00000000-0000-4000-8000-00000000000a";
const scenarioB = "00000000-0000-4000-8000-00000000000b";

const scope: MeasurementScope = measurementScopeSchema.parse({
	scenarios: [scenarioA, scenarioB],
	systems: [
		{ systemId: "chatgpt", channel: "VISITOR" },
		{ systemId: "perplexity", channel: "API" },
	],
	repeats: 2,
});

describe("planOrderDispatch", () => {
	it("plans the full matrix: 2 scenarios x 2 systems x 2 repeats = 8 unique permits", () => {
		const planned = planOrderDispatch({ orderId, lockVersion: 3, scope });
		expect(planned).toHaveLength(8);
		expect(planned).toHaveLength(expectedRunsFromScope(scope));
		expect(new Set(planned.map((permit) => permit.dispatchKey)).size).toBe(8);
		expect(planned[0]).toEqual({
			dispatchKey: `${orderId}:${scenarioA}:chatgpt:0:3`,
			scenarioId: scenarioA,
			systemId: "chatgpt",
			channel: "VISITOR",
			repeatIndex: 0,
		});
	});

	it("replans identically: a second planning pass mints zero new keys", () => {
		const first = planOrderDispatch({ orderId, lockVersion: 3, scope });
		const second = planOrderDispatch({ orderId, lockVersion: 3, scope });
		const union = new Set([...first, ...second].map((permit) => permit.dispatchKey));
		expect(union.size).toBe(first.length);
		expect(second.map((permit) => permit.dispatchKey)).toEqual(first.map((permit) => permit.dispatchKey));
	});

	it("separates keys by lock version, so a re-locked order cannot collide with its past runs", () => {
		const v1 = planOrderDispatch({ orderId, lockVersion: 1, scope });
		const v2 = planOrderDispatch({ orderId, lockVersion: 2, scope });
		const union = new Set([...v1, ...v2].map((permit) => permit.dispatchKey));
		expect(union.size).toBe(v1.length + v2.length);
	});

	it("rejects a scope whose keys would collide, even when it bypassed the schema", () => {
		const tampered = {
			...scope,
			systems: [
				{ systemId: "chatgpt", channel: "VISITOR" },
				{ systemId: "chatgpt", channel: "API" },
			],
		} as MeasurementScope;
		expect(() => planOrderDispatch({ orderId, lockVersion: 3, scope: tampered })).toThrow(
			"SELENA_DISPATCH_KEY_COLLISION",
		);
	});
});

describe("assertLockExpectedRuns", () => {
	it("returns the scope cardinality when the lock committed the same number", () => {
		expect(assertLockExpectedRuns(scope, 8)).toBe(8);
	});

	it("catches a lock whose expectedRuns disagrees with its own scope", () => {
		expect(() => assertLockExpectedRuns(scope, 7)).toThrow("SELENA_EXPECTED_RUNS_MISMATCH");
		expect(() => assertLockExpectedRuns(scope, 9)).toThrow("SELENA_EXPECTED_RUNS_MISMATCH");
	});
});

describe("assertQcDecision", () => {
	it("accepts only approved/rejected", () => {
		expect(() => assertQcDecision("approved")).not.toThrow();
		expect(() => assertQcDecision("rejected")).not.toThrow();
		expect(() => assertQcDecision("APPROVED")).toThrow("QC_DECISION_INVALID");
		expect(() => assertQcDecision("maybe")).toThrow("QC_DECISION_INVALID");
		expect(() => assertQcDecision("")).toThrow("QC_DECISION_INVALID");
	});
});

describe("zero provider surface invariant", () => {
	const here = dirname(fileURLToPath(import.meta.url));
	// Dispatch mints permission records only; it must be structurally unable to
	// reach a queue, a scheduler, or the network.
	const forbidden = ["fetch(", "boss", "job-scheduler", "http://", "https://"];

	it("keeps selena-dispatch.ts free of provider-execution code", () => {
		const text = readFileSync(resolve(here, "selena-dispatch.ts"), "utf8");
		for (const marker of forbidden) {
			expect(text.includes(marker), `selena-dispatch.ts must not contain "${marker}"`).toBe(false);
		}
	});
});

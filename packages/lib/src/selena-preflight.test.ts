import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type MeasurementScope, preflightResultSchema } from "@workspace/selena-visibility-contracts";
import { describe, expect, it } from "vitest";
import { assertApprovable, evaluatePreflight, type PreflightFacts, preflightBlockers } from "./selena-preflight";

const orderId = "9f1d0b9c-0f2a-4a3b-8c4d-5e6f70819200";
const scenarioA = "11111111-1111-4111-8111-111111111111";
const scenarioB = "22222222-2222-4222-8222-222222222222";

const scope: MeasurementScope = {
	scenarios: [scenarioA, scenarioB],
	systems: [
		{ systemId: "chatgpt", channel: "VISITOR" },
		{ systemId: "perplexity", channel: "API" },
	],
	repeats: 3,
};

const clearFacts: PreflightFacts = {
	orderId,
	orderStatus: "PAID_REVIEW_REQUIRED",
	lockPresent: true,
	scope,
	lockExpectedRuns: 12,
	activePermits: 0,
	activeJobs: 0,
	maintenanceActive: false,
	providerBudgetRemaining: 400,
	orderCap: 250,
	worstCaseCost: 120,
	paymentRecorded: true,
	currency: "usd",
};

const blockersFor = (overrides: Partial<PreflightFacts>) => evaluatePreflight({ ...clearFacts, ...overrides }).blockers;

describe("selena order preflight", () => {
	it("clears an order that satisfies every rule", () => {
		const result = evaluatePreflight(clearFacts);
		expect(result.ok).toBe(true);
		expect(result.blockers).toEqual([]);
		expect(result.expectedRuns).toBe(12);
		expect(result.worstCaseCost).toEqual({ amount: 120, currency: "USD", basis: "estimated" });
		expect(() => assertApprovable(result)).not.toThrow();
	});

	it("returns a result the preflight contract accepts", () => {
		expect(() => preflightResultSchema.parse(evaluatePreflight(clearFacts))).not.toThrow();
		expect(() =>
			preflightResultSchema.parse(evaluatePreflight({ ...clearFacts, worstCaseCost: Number.NaN })),
		).not.toThrow();
	});

	it("blocks an order that is not awaiting review", () => {
		for (const status of ["DRAFT", "AWAITING_PAYMENT", "APPROVED", "QUEUED", "CANCELLED"]) {
			expect(blockersFor({ orderStatus: status })).toContain("ORDER_STATUS_PAID_REVIEW_REQUIRED");
		}
	});

	it("blocks an order whose configuration lock is missing", () => {
		expect(blockersFor({ lockPresent: false })).toContain("LOCK_PRESENT");
	});

	it("blocks a lock that carries no measurement scope", () => {
		const blockers = blockersFor({ scope: null, lockExpectedRuns: 0 });
		expect(blockers).toContain("LOCK_SCOPE_PRESENT");
		// Without a scope the run count cannot be verified either, so the
		// cardinality rule fails rather than silently passing on zeroes.
		expect(blockers).toContain("EXPECTED_RUNS_MATCH");
	});

	it("blocks a lock whose committed run count disagrees with its scope", () => {
		expect(blockersFor({ lockExpectedRuns: 11 })).toContain("EXPECTED_RUNS_MATCH");
		expect(blockersFor({ lockExpectedRuns: 13 })).toContain("EXPECTED_RUNS_MATCH");
	});

	it("blocks an order that already has permits or jobs in flight", () => {
		expect(blockersFor({ activePermits: 12 })).toContain("NO_ACTIVE_PERMITS");
		expect(blockersFor({ activeJobs: 1 })).toContain("NO_ACTIVE_JOBS");
	});

	it("blocks approval while recurring maintenance is active", () => {
		expect(blockersFor({ maintenanceActive: true })).toContain("MAINTENANCE_IDLE");
	});

	it("blocks a worst case that exceeds the order cap", () => {
		expect(blockersFor({ worstCaseCost: 251 })).toContain("WITHIN_ORDER_CAP");
		expect(blockersFor({ worstCaseCost: 250 })).not.toContain("WITHIN_ORDER_CAP");
	});

	it("blocks a worst case that exceeds the remaining provider budget", () => {
		expect(blockersFor({ providerBudgetRemaining: 0 })).toContain("WITHIN_PROVIDER_BUDGET");
		expect(blockersFor({ providerBudgetRemaining: 119.99 })).toContain("WITHIN_PROVIDER_BUDGET");
		expect(blockersFor({ providerBudgetRemaining: 120 })).not.toContain("WITHIN_PROVIDER_BUDGET");
	});

	it("blocks a cost it cannot read as a number", () => {
		const blockers = blockersFor({ worstCaseCost: Number.NaN });
		expect(blockers).toContain("WITHIN_ORDER_CAP");
		expect(blockers).toContain("WITHIN_PROVIDER_BUDGET");
		expect(blockersFor({ worstCaseCost: -1 })).toContain("WITHIN_ORDER_CAP");
	});

	it("blocks an order with no recorded payment", () => {
		expect(blockersFor({ paymentRecorded: false })).toContain("PAYMENT_RECORDED");
	});

	it("refuses approval and names every blocker", () => {
		const result = evaluatePreflight({ ...clearFacts, paymentRecorded: false, maintenanceActive: true });
		expect(result.ok).toBe(false);
		expect(() => assertApprovable(result)).toThrow(/SELENA_PREFLIGHT_BLOCKED/);
		expect(() => assertApprovable(result)).toThrow(/MAINTENANCE_IDLE/);
		expect(() => assertApprovable(result)).toThrow(/PAYMENT_RECORDED/);
		expect(preflightBlockers(result)).toEqual(result.blockers);
	});
});

describe("admin order layer zero provider surface invariant", () => {
	const here = dirname(fileURLToPath(import.meta.url));
	const sources = [resolve(here, "selena-preflight.ts")];
	// Preflight decides whether an order may be approved; approval mints
	// permits and nothing else. No queue client, no scheduler, no HTTP call may
	// enter this path, or planning an order could execute it.
	const forbidden = ["boss", "job-scheduler", "fetch(", "http://", "https://"];

	it("keeps the preflight module free of provider-execution code", () => {
		for (const source of sources) {
			const text = readFileSync(source, "utf8");
			for (const marker of forbidden) {
				expect(text.includes(marker), `${source} must not contain "${marker}"`).toBe(false);
			}
		}
	});
});

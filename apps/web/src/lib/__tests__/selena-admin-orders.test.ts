import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertApprovable, evaluatePreflight, type PreflightFacts } from "@workspace/lib/selena-preflight";
import { describe, expect, it } from "vitest";

const clearFacts: PreflightFacts = {
	orderId: "9f1d0b9c-0f2a-4a3b-8c4d-5e6f70819200",
	orderStatus: "PAID_REVIEW_REQUIRED",
	lockPresent: true,
	scope: {
		scenarios: ["11111111-1111-4111-8111-111111111111"],
		systems: [{ systemId: "chatgpt", channel: "VISITOR" }],
		repeats: 2,
	},
	lockExpectedRuns: 2,
	activePermits: 0,
	activeJobs: 0,
	maintenanceActive: false,
	providerBudgetRemaining: 100,
	orderCap: 100,
	worstCaseCost: 40,
	paymentRecorded: true,
	currency: "USD",
};

const adminOrdersSource = readFileSync(
	fileURLToPath(new URL("../../server/selena-admin-orders.ts", import.meta.url)),
	"utf8",
);

describe("selena order approval gate", () => {
	it("refuses approval while any preflight check fails", () => {
		const blocked: Array<Partial<PreflightFacts>> = [
			{ orderStatus: "AWAITING_PAYMENT" },
			{ lockPresent: false, scope: null },
			{ scope: null },
			{ lockExpectedRuns: 3 },
			{ activePermits: 2 },
			{ activeJobs: 1 },
			{ maintenanceActive: true },
			{ worstCaseCost: 101 },
			{ providerBudgetRemaining: 0 },
			{ paymentRecorded: false },
		];
		for (const override of blocked) {
			const result = evaluatePreflight({ ...clearFacts, ...override });
			expect(result.ok, JSON.stringify(override)).toBe(false);
			expect(() => assertApprovable(result)).toThrow(/SELENA_PREFLIGHT_BLOCKED/);
		}
	});

	it("allows approval only once every check passes", () => {
		expect(() => assertApprovable(evaluatePreflight(clearFacts))).not.toThrow();
	});

	it("routes approval through the preflight assertion rather than the ok flag alone", () => {
		expect(adminOrdersSource).toContain("assertApprovable(preflight)");
		// Permits are minted by the dispatch repository, which is the only
		// writer allowed to create them.
		expect(adminOrdersSource).toContain("getRepositories()).dispatch.createPermits");
	});
});

/**
 * The body of one exported declaration, up to the next one. The gates these
 * tests guard live wherever the act itself lives, which is a shared function
 * once more than one screen performs it — so a name here is a declaration,
 * not specifically a server fn.
 */
function serverFnSource(name: string): string {
	const start = adminOrdersSource.search(new RegExp(`export (?:const|async function) ${name}\\b`));
	expect(start, `${name} is missing`).toBeGreaterThan(-1);
	const rest = adminOrdersSource.slice(start + 1);
	const offset = rest.search(/\nexport (?:const|async function) /);
	return offset === -1 ? adminOrdersSource.slice(start) : adminOrdersSource.slice(start, start + 1 + offset);
}

describe("admin order layer zero provider surface invariant", () => {
	// The operator screen may hand work to the worker's queue, but it must not
	// be able to reach a provider itself.
	const forbidden = ["job-scheduler", "fetch(", "http://", "https://"];

	it("keeps the admin order module free of provider-execution code", () => {
		for (const marker of forbidden) {
			expect(adminOrdersSource.includes(marker), `selena-admin-orders.ts must not contain "${marker}"`).toBe(false);
		}
	});

	it("keeps approval free of queueing, so minting permission never starts work", () => {
		const approve = serverFnSource("approveOrder");
		for (const marker of ["boss", "enqueue"]) {
			expect(approve.includes(marker), `approveOrder must not contain "${marker}"`).toBe(false);
		}
	});
});

describe("run enqueue gate", () => {
	const enqueue = serverFnSource("enqueueOrderRunsForOrder");

	it("refuses to queue an order that approval has not moved to QUEUED", () => {
		expect(enqueue).toContain("SELENA_ORDER_NOT_QUEUED");
	});

	it("hands the execution flag to the enqueue decision instead of reading the queue first", () => {
		expect(enqueue).toContain("measurementConfigFromEnv(process.env)");
		expect(enqueue.indexOf("measurementConfigFromEnv")).toBeLessThan(enqueue.indexOf("enqueueOrderRuns("));
	});

	it("records what it queued so a run can be traced back to the operator who started it", () => {
		expect(enqueue).toContain('"RUNS_ENQUEUED"');
	});
});

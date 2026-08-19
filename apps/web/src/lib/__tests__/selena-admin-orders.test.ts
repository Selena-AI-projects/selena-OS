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
		expect(adminOrdersSource).toContain("repositories.dispatch.createPermits");
	});
});

describe("admin order layer zero provider surface invariant", () => {
	// Approving an order issues permission records; it must not be able to
	// queue, schedule, or call anything.
	const forbidden = ["boss", "job-scheduler", "fetch(", "http://", "https://"];

	it("keeps the admin order module free of provider-execution code", () => {
		for (const marker of forbidden) {
			expect(adminOrdersSource.includes(marker), `selena-admin-orders.ts must not contain "${marker}"`).toBe(false);
		}
	});
});

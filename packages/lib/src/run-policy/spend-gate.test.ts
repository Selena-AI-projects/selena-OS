import { describe, expect, it } from "vitest";
import {
	assertGlobalProviderStop,
	assertSuggestSpendAllowed,
	isGlobalProviderStopEngaged,
	SUGGEST_FREE_BUDGET_CLASS,
} from "./spend-gate";

describe("global provider stop", () => {
	it("halts every provider path, not only measurement", () => {
		expect(() => assertGlobalProviderStop({ SELENA_EMERGENCY_STOP: "true" })).toThrow("PROVIDER_CALLS_STOPPED");
		expect(isGlobalProviderStopEngaged({ SELENA_EMERGENCY_STOP: "true" })).toBe(true);
	});

	it("is only engaged by the exact value, so a typo cannot silently disarm the check", () => {
		expect(() => assertGlobalProviderStop({})).not.toThrow();
		expect(() => assertGlobalProviderStop({ SELENA_EMERGENCY_STOP: "TRUE" })).not.toThrow();
	});
});

describe("onboarding suggestion spend gate", () => {
	it("refuses a paid suggestion until the owner names the budget class", () => {
		expect(() => assertSuggestSpendAllowed({})).toThrow("SUGGEST_LLM_NOT_BUDGETED");
		expect(() => assertSuggestSpendAllowed({ SELENA_SUGGEST_LLM: "true" })).toThrow("SUGGEST_LLM_NOT_BUDGETED");
		expect(() => assertSuggestSpendAllowed({ SELENA_SUGGEST_LLM: "enabled" })).toThrow("SUGGEST_LLM_NOT_BUDGETED");
	});

	it("allows it once the class is named", () => {
		expect(() => assertSuggestSpendAllowed({ SELENA_SUGGEST_LLM: SUGGEST_FREE_BUDGET_CLASS })).not.toThrow();
	});

	it("stays refused under the global stop however it is budgeted", () => {
		expect(() =>
			assertSuggestSpendAllowed({ SELENA_SUGGEST_LLM: SUGGEST_FREE_BUDGET_CLASS, SELENA_EMERGENCY_STOP: "true" }),
		).toThrow("PROVIDER_CALLS_STOPPED");
	});
});

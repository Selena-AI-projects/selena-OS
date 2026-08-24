import { describe, expect, it } from "vitest";
import { promoCodeApplies, promoCodesFromEnv } from "./promo";

describe("promo codes", () => {
	it("applies only codes named in the env list, case- and space-insensitively", () => {
		const env = { SELENA_PROMO_CODES: "AUGUST2026, friends " };
		expect(promoCodeApplies("august2026", env)).toBe(true);
		expect(promoCodeApplies(" FRIENDS", env)).toBe(true);
		expect(promoCodeApplies("SEPTEMBER2026", env)).toBe(false);
	});

	it("applies nothing when the env is unset or empty — free passage is opt-in", () => {
		expect(promoCodeApplies("AUGUST2026", {})).toBe(false);
		expect(promoCodeApplies("", { SELENA_PROMO_CODES: "AUGUST2026" })).toBe(false);
		expect(promoCodeApplies(undefined, { SELENA_PROMO_CODES: "AUGUST2026" })).toBe(false);
		expect(promoCodesFromEnv({ SELENA_PROMO_CODES: " , ," })).toEqual([]);
	});
});

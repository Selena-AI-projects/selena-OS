import { describe, expect, it } from "vitest";
import { humanizeSelenaAdminError, humanizeSelenaError } from "../selena-workspace-errors";

describe("humanizeSelenaError", () => {
	it("names the field a profile validation issue came from", () => {
		const issues = JSON.stringify([
			{ code: "invalid_format", format: "url", path: ["publicProfiles", 0, "url"], message: "Invalid URL" },
		]);
		expect(humanizeSelenaError(new Error(issues), "ru", "fallback")).toBe(
			"«Ссылки на публичные профили» (значение 1): укажите полный адрес, например https://example.com",
		);
		expect(humanizeSelenaError(new Error(issues), "en", "fallback")).toBe(
			"«Public profile links» (entry 1): enter the full address, for example https://example.com",
		);
	});

	it("counts customer questions by line, because that is how the box is edited", () => {
		const issues = JSON.stringify([{ code: "too_small", path: ["scenarioSnapshot", 2, "text"] }]);
		expect(humanizeSelenaError(new Error(issues), "ru", "fallback")).toContain("строка 3");
	});

	it("explains collector codes instead of showing them", () => {
		expect(humanizeSelenaError(new Error("WEBSITE_DNS_FAILED"), "ru", "fallback")).toContain("сайт не найден");
		expect(humanizeSelenaError(new Error("WEBSITE_HTTP_404"), "en", "fallback")).toContain("status 404");
		expect(humanizeSelenaError(new Error("WEBSITE_HTTP_404"), "en", "fallback")).not.toContain("WEBSITE_");
	});

	it("explains a timeout and an unreachable host", () => {
		const timeout = new Error("The operation was aborted due to timeout");
		timeout.name = "TimeoutError";
		expect(humanizeSelenaError(timeout, "ru", "fallback")).toContain("слишком долго");
		expect(humanizeSelenaError(new TypeError("fetch failed"), "ru", "fallback")).toContain("связаться с сайтом");
	});

	it("falls back to the caller's sentence when the cause says nothing", () => {
		expect(humanizeSelenaError(new Error("  "), "en", "fallback")).toBe("fallback");
		expect(humanizeSelenaError(undefined, "en", "fallback")).toBe("fallback");
	});

	it("explains the suggestion gates instead of showing machine codes", () => {
		expect(humanizeSelenaError(new Error("SUGGEST_LLM_NOT_BUDGETED"), "ru", "fallback")).toContain("вручную");
		expect(humanizeSelenaError(new Error("SUGGEST_BUDGET_EXHAUSTED"), "en", "fallback")).toContain("budget");
		expect(humanizeSelenaError(new Error("SUGGEST_LLM_NOT_BUDGETED"), "en", "fallback")).not.toContain("SUGGEST_");
	});
});

describe("humanizeSelenaAdminError", () => {
	it("names the env switch for the payment and measurement gates", () => {
		expect(humanizeSelenaAdminError(new Error("SELENA_PAYMENTS_DISABLED"), "en", "fallback")).toContain(
			"SELENA_PAYMENTS_ENABLED=true",
		);
		expect(humanizeSelenaAdminError(new Error("SELENA_MEASUREMENT_DISABLED"), "ru", "fallback")).toContain(
			"SELENA_MEASUREMENT_ENABLED=true",
		);
	});

	it("explains preflight blockers and points the budget one at its env var", () => {
		const message = humanizeSelenaAdminError(
			new Error("SELENA_PREFLIGHT_BLOCKED: WITHIN_PROVIDER_BUDGET"),
			"en",
			"fallback",
		);
		expect(message).toContain("SELENA_PROVIDER_BUDGET_USD");
		expect(message).not.toContain("SELENA_PREFLIGHT_BLOCKED");
	});

	it("keeps an unknown code verbatim, because the operator will quote it", () => {
		expect(humanizeSelenaAdminError(new Error("SELENA_SOMETHING_NEW"), "en", "fallback")).toBe("SELENA_SOMETHING_NEW");
		expect(humanizeSelenaAdminError(new Error("  "), "en", "fallback")).toBe("fallback");
	});

	it("states the plan question limit with its number", () => {
		expect(humanizeSelenaAdminError(new Error("SELENA_PLAN_SCENARIO_LIMIT_EXCEEDED: 12"), "ru", "fallback")).toContain(
			"12",
		);
	});
});

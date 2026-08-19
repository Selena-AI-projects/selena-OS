import { describe, expect, it } from "vitest";
import { humanizeSelenaError } from "../selena-workspace-errors";

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
});

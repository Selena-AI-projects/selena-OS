import { describe, expect, it, vi } from "vitest";
import { safeReturnTo } from "../return-to";

describe("safeReturnTo", () => {
	it("uses the Selena customer workspace as the default", () => {
		expect(safeReturnTo(undefined)).toBe("/app/selena");
	});

	it("keeps safe same-origin paths", () => {
		expect(safeReturnTo("/app/selena?project=one#results")).toBe("/app/selena?project=one#results");
	});

	it("rejects protocol-relative and cross-origin redirects", () => {
		vi.stubGlobal("window", { location: { origin: "https://app.selenasystems.com" } });
		expect(safeReturnTo("//example.com/steal")).toBe("/app/selena");
		expect(safeReturnTo("https://example.com/steal")).toBe("/app/selena");
		vi.unstubAllGlobals();
	});
});

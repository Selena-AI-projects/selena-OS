import { describe, expect, it } from "vitest";
import { parseSelenaProduct } from "../selena-product-entry";

describe("Selena product entry", () => {
	it("accepts only known product destinations", () => {
		expect(parseSelenaProduct("ai-visibility")).toBe("ai-visibility");
		expect(parseSelenaProduct("content-control")).toBe("content-control");
	});

	it("rejects stale or forged stored values", () => {
		expect(parseSelenaProduct("eskq.bar")).toBeNull();
		expect(parseSelenaProduct("https://example.com")).toBeNull();
		expect(parseSelenaProduct(null)).toBeNull();
	});
});

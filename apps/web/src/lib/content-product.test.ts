import { describe, expect, it } from "vitest";
import {
	CONTENT_PRODUCT_DESCRIPTION,
	CONTENT_PRODUCT_NAME,
	CONTENT_PRODUCT_ROUTE,
	resolveContentBrand,
} from "./content-product";

describe("content product identity", () => {
	it("uses one neutral visible name", () => {
		expect(CONTENT_PRODUCT_NAME).toBe("Content OS");
		expect(CONTENT_PRODUCT_NAME).not.toMatch(/selena/i);
	});

	it("keeps the existing brand-scoped compatibility route", () => {
		expect(CONTENT_PRODUCT_ROUTE).toBe("/app/$brand/control-room");
		expect(CONTENT_PRODUCT_DESCRIPTION).toMatch(/without enabling external publication/i);
	});
});

describe("which brand Content OS opens", () => {
	const brands = [
		{ id: "other-bali", name: "Other Bali" },
		{ id: "selena", name: "Selena Systems" },
	];

	it("returns to the brand the reviewer last worked in", () => {
		expect(resolveContentBrand(brands, "selena")).toBe("selena");
	});

	it("opens the same brand on every visit when nothing was chosen", () => {
		expect(resolveContentBrand(brands, null)).toBe("other-bali");
	});

	it("ignores a remembered brand this workspace no longer has", () => {
		expect(resolveContentBrand(brands, "a-brand-from-another-workspace")).toBe("other-bali");
	});

	it("has nothing to open before the first brand exists", () => {
		expect(resolveContentBrand([], "selena")).toBeNull();
	});
});

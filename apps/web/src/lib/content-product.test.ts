import { describe, expect, it } from "vitest";
import { CONTENT_PRODUCT_DESCRIPTION, CONTENT_PRODUCT_NAME, CONTENT_PRODUCT_ROUTE } from "./content-product";

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

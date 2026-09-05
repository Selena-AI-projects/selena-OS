import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BRAND_CREATION_ROUTE, CONTENT_PRODUCT_ROUTE } from "../content-product";

function chooserSource(): string {
	return readFileSync(fileURLToPath(new URL("../../routes/_authed/app/selena.tsx", import.meta.url)), "utf8");
}

describe("Content OS entry", () => {
	/**
	 * The button was dead for two separate reasons, and both showed the same
	 * 404, so the first fix looked correct while changing nothing. Guarding the
	 * shape of the navigation is what stops a third literal from creeping in:
	 * `$brand` is a database id, and no constant can stand in for one.
	 */
	it("never navigates to a hard-coded brand", () => {
		const navigations = chooserSource().match(/params:\s*\{\s*brand:[^}]*\}/g) ?? [];
		expect(navigations.length).toBeGreaterThan(0);
		for (const navigation of navigations) {
			expect(navigation).not.toMatch(/brand:\s*["'`]/);
		}
	});

	it("sends a user with no brand somewhere that exists", () => {
		expect(chooserSource()).toContain("BRAND_CREATION_ROUTE");
		expect(BRAND_CREATION_ROUTE).toBe("/app/new");
	});

	it("opens the Control Room under the brand segment", () => {
		expect(CONTENT_PRODUCT_ROUTE).toBe("/app/$brand/control-room");
	});
});

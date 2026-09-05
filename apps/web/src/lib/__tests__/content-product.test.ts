import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONTENT_OS_BRAND_SLUG } from "../content-product";

/**
 * Read from the filesystem rather than a hand-kept list: the point of the test
 * is to fail when someone adds a static route whose name collides with the
 * brand Content OS opens, and a list copied by hand would go stale exactly then.
 */
function reservedAppSegments(): string[] {
	const appRoutes = fileURLToPath(new URL("../../routes/_authed/app", import.meta.url));
	return readdirSync(appRoutes, { withFileTypes: true })
		.filter((entry) => !entry.name.startsWith("$") && entry.name !== "index.tsx")
		.map((entry) => entry.name.replace(/\.tsx$/, ""));
}

describe("Content OS entry", () => {
	it("opens a brand whose slug no static route can shadow", () => {
		expect(reservedAppSegments()).not.toContain(CONTENT_OS_BRAND_SLUG);
	});

	it("still finds the segments it is guarding against", () => {
		// Without this the test above would pass on an empty directory listing.
		expect(reservedAppSegments()).toContain("selena");
	});
});

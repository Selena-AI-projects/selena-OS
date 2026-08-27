import { describe, expect, it } from "vitest";
import { isSelenaStagingPreviewEnabled } from "./selena-staging-preview.server";

describe("isSelenaStagingPreviewEnabled", () => {
	it("fails closed when either staging flag is absent", () => {
		expect(isSelenaStagingPreviewEnabled({ SELENA_STAGING_MVP: "true" })).toBe(false);
		expect(isSelenaStagingPreviewEnabled({ SELENA_STAGING_PREVIEW_ENABLED: "true" })).toBe(false);
	});

	it("allows the fixture-only preview only with both explicit staging flags", () => {
		expect(
			isSelenaStagingPreviewEnabled({
				SELENA_STAGING_MVP: "true",
				SELENA_STAGING_PREVIEW_ENABLED: "true",
			}),
		).toBe(true);
	});
});

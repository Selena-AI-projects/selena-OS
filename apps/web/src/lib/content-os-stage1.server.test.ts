import { describe, expect, it } from "vitest";
import { isContentOsStage1Enabled } from "./content-os-stage1.server";

describe("isContentOsStage1Enabled", () => {
	it.each([undefined, "false", "TRUE", "1", " true "])("fails closed for %j", (value) => {
		expect(isContentOsStage1Enabled({ CONTENT_OS_STAGE1_ENABLED: value })).toBe(false);
	});

	it('enables Stage 1 only for the exact value "true"', () => {
		expect(isContentOsStage1Enabled({ CONTENT_OS_STAGE1_ENABLED: "true" })).toBe(true);
	});
});

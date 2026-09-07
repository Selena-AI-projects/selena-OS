import { describe, expect, it } from "vitest";
import { assertGrowthSourcesEnabled, isGrowthEngineStage1Enabled } from "./growth-engine-stage1.server";

describe("isGrowthEngineStage1Enabled", () => {
	it.each([undefined, "false", "TRUE", "1", " true "])("fails closed for %j", (value) => {
		expect(isGrowthEngineStage1Enabled({ GROWTH_ENGINE_STAGE1_ENABLED: value })).toBe(false);
		expect(() => assertGrowthSourcesEnabled({ GROWTH_ENGINE_STAGE1_ENABLED: value })).toThrow(/disabled/);
	});

	it('enables the growth stage only for the exact value "true"', () => {
		expect(isGrowthEngineStage1Enabled({ GROWTH_ENGINE_STAGE1_ENABLED: "true" })).toBe(true);
		expect(() => assertGrowthSourcesEnabled({ GROWTH_ENGINE_STAGE1_ENABLED: "true" })).not.toThrow();
	});
});

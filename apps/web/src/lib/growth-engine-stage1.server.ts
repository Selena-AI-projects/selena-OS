type GrowthEngineStage1Env = Pick<NodeJS.ProcessEnv, "GROWTH_ENGINE_STAGE1_ENABLED">;

/** Fail-closed like every other stage flag: only the exact documented value shows the growth sources. */
export function isGrowthEngineStage1Enabled(env: GrowthEngineStage1Env = process.env): boolean {
	return env.GROWTH_ENGINE_STAGE1_ENABLED === "true";
}

/** Writes to growth sources refuse outright while the stage is off, whatever the UI showed. */
export function assertGrowthSourcesEnabled(env: GrowthEngineStage1Env = process.env): void {
	if (!isGrowthEngineStage1Enabled(env)) throw new Error("Growth sources are disabled in this deployment");
}

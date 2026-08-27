type SelenaStagingPreviewEnv = Pick<NodeJS.ProcessEnv, "SELENA_STAGING_MVP" | "SELENA_STAGING_PREVIEW_ENABLED">;

export function isSelenaStagingPreviewEnabled(env: SelenaStagingPreviewEnv = process.env): boolean {
	return env.SELENA_STAGING_MVP === "true" && env.SELENA_STAGING_PREVIEW_ENABLED === "true";
}

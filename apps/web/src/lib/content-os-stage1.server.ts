type ContentOsStage1Env = Pick<NodeJS.ProcessEnv, "CONTENT_OS_STAGE1_ENABLED">;

/** Stage 1 is fail-closed: only the exact documented value enables its shell. */
export function isContentOsStage1Enabled(env: ContentOsStage1Env = process.env): boolean {
	return env.CONTENT_OS_STAGE1_ENABLED === "true";
}

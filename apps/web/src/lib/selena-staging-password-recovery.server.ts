/**
 * Gates the Selena owner recovery mailer. All four conditions are required so
 * a local or production deployment cannot enable it by accident.
 */
export function isSelenaStagingPasswordRecoveryEnabled(): boolean {
	return (
		process.env.SELENA_STAGING_MVP === "true" &&
		process.env.SELENA_STAGING_PASSWORD_RESET_ENABLED === "true" &&
		Boolean(process.env.RESEND_API_KEY?.trim()) &&
		Boolean(process.env.RESEND_FROM_EMAIL?.trim())
	);
}

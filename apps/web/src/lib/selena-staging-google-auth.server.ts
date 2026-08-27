import type { CreateAuthOptions } from "@workspace/lib/auth/server";

type SelenaStagingGoogleAuthEnv = Pick<
	NodeJS.ProcessEnv,
	"GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET" | "SELENA_STAGING_GOOGLE_SIGN_IN_ENABLED" | "SELENA_STAGING_MVP"
>;

/**
 * Google sign-in is deliberately a staging-only, single-user bridge. Better
 * Auth can only link a Google identity to the pre-existing local account with
 * the same email; OAuth sign-up remains disabled.
 */
export function getSelenaStagingGoogleSignInOptions(
	env: SelenaStagingGoogleAuthEnv = process.env,
): Pick<CreateAuthOptions, "account" | "disableSignUp" | "emailAndPasswordEnabled" | "socialProviders"> | undefined {
	const clientId = env.GOOGLE_CLIENT_ID?.trim();
	const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();

	if (
		env.SELENA_STAGING_MVP !== "true" ||
		env.SELENA_STAGING_GOOGLE_SIGN_IN_ENABLED !== "true" ||
		!clientId ||
		!clientSecret
	) {
		return undefined;
	}

	return {
		disableSignUp: true,
		emailAndPasswordEnabled: false,
		socialProviders: {
			google: {
				clientId,
				clientSecret,
				prompt: "select_account",
			},
		},
		account: {
			accountLinking: {
				trustedProviders: ["google"],
			},
		},
	};
}

export function isSelenaStagingGoogleSignInEnabled(env: SelenaStagingGoogleAuthEnv = process.env): boolean {
	return getSelenaStagingGoogleSignInOptions(env) !== undefined;
}

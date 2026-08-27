import { describe, expect, it } from "vitest";
import {
	getSelenaStagingGoogleSignInOptions,
	isSelenaStagingGoogleSignInEnabled,
} from "./selena-staging-google-auth.server";

const enabledEnv = {
	SELENA_STAGING_MVP: "true",
	SELENA_STAGING_GOOGLE_SIGN_IN_ENABLED: "true",
	GOOGLE_CLIENT_ID: "test-client-id",
	GOOGLE_CLIENT_SECRET: "test-client-secret",
} as const;

describe("Selena staging Google sign-in", () => {
	it("fails closed unless every staging gate and OAuth value is present", () => {
		expect(isSelenaStagingGoogleSignInEnabled({ ...enabledEnv, SELENA_STAGING_MVP: "false" })).toBe(false);
		expect(isSelenaStagingGoogleSignInEnabled({ ...enabledEnv, SELENA_STAGING_GOOGLE_SIGN_IN_ENABLED: "false" })).toBe(
			false,
		);
		expect(isSelenaStagingGoogleSignInEnabled({ ...enabledEnv, GOOGLE_CLIENT_ID: "" })).toBe(false);
		expect(isSelenaStagingGoogleSignInEnabled({ ...enabledEnv, GOOGLE_CLIENT_SECRET: "" })).toBe(false);
	});

	it("allows account linking but disables all new OAuth user creation", () => {
		const options = getSelenaStagingGoogleSignInOptions(enabledEnv);
		expect(options?.account?.accountLinking?.trustedProviders).toEqual(["google"]);
		expect(options?.disableSignUp).toBe(true);
		expect(options?.emailAndPasswordEnabled).toBe(false);
	});
});

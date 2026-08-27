import { afterEach, describe, expect, it, vi } from "vitest";
import { isSelenaStagingPasswordRecoveryEnabled } from "./selena-staging-password-recovery.server";

const required = [
	"SELENA_STAGING_MVP",
	"SELENA_STAGING_PASSWORD_RESET_ENABLED",
	"RESEND_API_KEY",
	"RESEND_FROM_EMAIL",
] as const;

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("isSelenaStagingPasswordRecoveryEnabled", () => {
	it("fails closed unless every staging and mailer condition is present", () => {
		for (const missing of required) {
			for (const name of required) {
				vi.stubEnv(name, name === missing ? "" : "configured");
			}
			expect(isSelenaStagingPasswordRecoveryEnabled()).toBe(false);
		}
	});

	it("allows recovery only for the explicit staging configuration", () => {
		vi.stubEnv("SELENA_STAGING_MVP", "true");
		vi.stubEnv("SELENA_STAGING_PASSWORD_RESET_ENABLED", "true");
		vi.stubEnv("RESEND_API_KEY", "test-key");
		vi.stubEnv("RESEND_FROM_EMAIL", "Selena Systems <staging@example.com>");

		expect(isSelenaStagingPasswordRecoveryEnabled()).toBe(true);
	});
});

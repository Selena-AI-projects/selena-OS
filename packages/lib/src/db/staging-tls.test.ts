import { describe, expect, it } from "vitest";
import { assertDatabaseTlsVerified, requiresVerifiedDatabaseTls } from "./staging-tls";

const VERIFIED = "postgresql://db.example:5432/app?sslmode=verify-full&sslrootcert=%2Ftmp%2Fsupabase-ca.crt";

describe("requiresVerifiedDatabaseTls", () => {
	it("asks for nothing when a contour has not asked for it", () => {
		expect(requiresVerifiedDatabaseTls({})).toBe(false);
		expect(requiresVerifiedDatabaseTls({ SELENA_RUNTIME_DB_VERIFY_TLS: "false" })).toBe(false);
	});

	it("is satisfied by either variable, so a contour can ask for the certificate check alone", () => {
		expect(requiresVerifiedDatabaseTls({ SELENA_RUNTIME_DB_VERIFY_TLS: "true" })).toBe(true);
		expect(requiresVerifiedDatabaseTls({ SELENA_STAGING_MVP: "true" })).toBe(true);
	});

	it("keeps the staging box verifying, because splitting the variables must not quietly downgrade it", () => {
		expect(requiresVerifiedDatabaseTls({ SELENA_STAGING_MVP: "true", SELENA_RUNTIME_DB_VERIFY_TLS: "false" })).toBe(
			true,
		);
	});

	it("treats anything but the exact string as off, so a typo cannot arm it by accident", () => {
		expect(requiresVerifiedDatabaseTls({ SELENA_RUNTIME_DB_VERIFY_TLS: "TRUE" })).toBe(false);
		expect(requiresVerifiedDatabaseTls({ SELENA_RUNTIME_DB_VERIFY_TLS: "1" })).toBe(false);
	});
});

describe("assertDatabaseTlsVerified", () => {
	it("imposes nothing on a contour that did not ask for verification", () => {
		expect(() => assertDatabaseTlsVerified("postgresql://localhost:5432/app", {})).not.toThrow();
	});

	it("requires verify-full and a root certificate once asked", () => {
		expect(() =>
			assertDatabaseTlsVerified("postgresql://db.example:5432/app?sslmode=require", {
				SELENA_RUNTIME_DB_VERIFY_TLS: "true",
			}),
		).toThrow("verify-full TLS");
		expect(() =>
			assertDatabaseTlsVerified("postgresql://db.example:5432/app?sslmode=verify-full", {
				SELENA_RUNTIME_DB_VERIFY_TLS: "true",
			}),
		).toThrow("root certificate");
	});

	it("accepts a verify-full URL with a root certificate under either variable", () => {
		expect(() => assertDatabaseTlsVerified(VERIFIED, { SELENA_RUNTIME_DB_VERIFY_TLS: "true" })).not.toThrow();
		expect(() => assertDatabaseTlsVerified(VERIFIED, { SELENA_STAGING_MVP: "true" })).not.toThrow();
	});
});

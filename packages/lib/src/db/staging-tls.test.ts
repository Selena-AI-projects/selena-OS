import { describe, expect, it } from "vitest";
import { assertStagingDatabaseTls } from "./staging-tls";

describe("assertStagingDatabaseTls", () => {
	it("does not impose staging TLS requirements outside the Selena staging runtime", () => {
		expect(() => assertStagingDatabaseTls("postgresql://localhost:5432/app", false)).not.toThrow();
	});

	it("requires verify-full and a root certificate for Selena staging", () => {
		expect(() => assertStagingDatabaseTls("postgresql://db.example:5432/app?sslmode=require", true)).toThrow(
			"verify-full TLS",
		);
		expect(() => assertStagingDatabaseTls("postgresql://db.example:5432/app?sslmode=verify-full", true)).toThrow(
			"root certificate",
		);
	});

	it("accepts a verify-full URL with a root certificate", () => {
		expect(() =>
			assertStagingDatabaseTls(
				"postgresql://db.example:5432/app?sslmode=verify-full&sslrootcert=%2Ftmp%2Fsupabase-ca.crt",
				true,
			),
		).not.toThrow();
	});
});

import { describe, expect, it } from "vitest";
import {
	assertAdapterAllowed,
	assertMeasurementAllowed,
	measurementConfigFromEnv,
	runOutcomeSchema,
} from "./measurement-execution";

describe("Selena measurement execution boundary", () => {
	it("ships inert: measurement is off and the adapter is the noop one", () => {
		expect(measurementConfigFromEnv({})).toEqual({ enabled: false, adapter: "noop" });
		expect(() => assertMeasurementAllowed(measurementConfigFromEnv({}))).toThrow("SELENA_MEASUREMENT_DISABLED");
		expect(() => assertMeasurementAllowed(measurementConfigFromEnv({ SELENA_MEASUREMENT_ENABLED: "1" }))).toThrow(
			"SELENA_MEASUREMENT_DISABLED",
		);
		expect(() =>
			assertMeasurementAllowed(measurementConfigFromEnv({ SELENA_MEASUREMENT_ENABLED: "true" })),
		).not.toThrow();
	});

	it("refuses an unregistered adapter and refuses a live one the owner has not approved", () => {
		expect(() => assertAdapterAllowed("noop", ["noop"])).not.toThrow();
		expect(() => assertAdapterAllowed("brightdata", ["noop"])).toThrow("SELENA_ADAPTER_NOT_REGISTERED");
		// The owner gate: registering a live adapter is not enough to select it.
		expect(() => assertAdapterAllowed("brightdata", ["noop", "brightdata"])).toThrow(
			"SELENA_LIVE_ADAPTER_REQUIRES_OWNER_GO",
		);
		// openrouter is owner-approved: registered and named, it may execute.
		expect(() => assertAdapterAllowed("openrouter", ["noop", "openrouter"])).not.toThrow();
		expect(() => assertAdapterAllowed("openrouter", ["noop"])).toThrow("SELENA_ADAPTER_NOT_REGISTERED");
	});

	it("accepts a well-formed outcome and rejects incoherent or unknown fields", () => {
		const succeeded = {
			dispatchKey: "order:scenario:system:0:1",
			status: "SUCCEEDED" as const,
			validity: "VALID" as const,
			rawResponseReference: "private://raw/1",
			tokenUsage: { input: 10, output: 20 },
			costUsd: 0.005,
		};
		expect(runOutcomeSchema.parse(succeeded)).toEqual(succeeded);
		expect(
			runOutcomeSchema.parse({
				dispatchKey: "k1",
				status: "FAILED",
				validity: "INVALID",
				invalidReason: "PROVIDER_TIMEOUT",
			}).invalidReason,
		).toBe("PROVIDER_TIMEOUT");

		expect(runOutcomeSchema.safeParse({ ...succeeded, status: "QUEUED" }).success).toBe(false);
		expect(runOutcomeSchema.safeParse({ ...succeeded, dispatchKey: "" }).success).toBe(false);
		expect(runOutcomeSchema.safeParse({ ...succeeded, costUsd: -1 }).success).toBe(false);
		// A failed run may not be recorded as valid evidence.
		expect(runOutcomeSchema.safeParse({ ...succeeded, status: "FAILED" }).success).toBe(false);
		// Invalid evidence has to carry a reason.
		expect(runOutcomeSchema.safeParse({ dispatchKey: "k1", status: "INVALID", validity: "INVALID" }).success).toBe(
			false,
		);
		expect(runOutcomeSchema.safeParse({ ...succeeded, providerApiKey: "sk-test" }).success).toBe(false);
	});
});

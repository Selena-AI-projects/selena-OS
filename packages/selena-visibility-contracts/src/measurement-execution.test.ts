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

	it("refuses an unregistered adapter and refuses a live one even when registered", () => {
		expect(() => assertAdapterAllowed("noop", ["noop"])).not.toThrow();
		expect(() => assertAdapterAllowed("brightdata", ["noop"])).toThrow("SELENA_ADAPTER_NOT_REGISTERED");
		// The owner gate: registering a live adapter is not enough to select it.
		expect(() => assertAdapterAllowed("brightdata", ["noop", "brightdata"])).toThrow(
			"SELENA_LIVE_ADAPTER_REQUIRES_OWNER_GO",
		);
		expect(() => assertAdapterAllowed("openrouter", ["noop", "openrouter"])).toThrow(
			"SELENA_LIVE_ADAPTER_REQUIRES_OWNER_GO",
		);
	});

	it("accepts a well-formed outcome and rejects incoherent or unknown fields", () => {
		const succeeded = {
			dispatchKey: "order:scenario:system:0:1",
			status: "SUCCEEDED" as const,
			validity: "VALID" as const,
			rawResponseReference: "private://raw/1",
			tokenUsage: { input: 10, output: 20 },
			costUsd: 0.005,
			costBasis: "actual" as const,
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
		// A cost without a basis would read as an actual charge by default.
		expect(runOutcomeSchema.safeParse({ ...succeeded, costBasis: undefined }).success).toBe(false);
	});

	it("accepts a grounded measurement and rejects one that contradicts itself", () => {
		const measurement = {
			system: "chatgpt",
			model: "gpt-5",
			language: "en",
			region: "ID",
			mention: true,
			position: 2,
			ownedCitation: true,
			citations: [{ url: "https://example.com/menu", domain: "example.com" }],
			competitors: ["Rival Cafe"],
			factualErrors: [],
		};
		const succeeded = {
			dispatchKey: "order:scenario:system:0:1",
			status: "SUCCEEDED" as const,
			validity: "VALID" as const,
			measurement,
		};
		expect(runOutcomeSchema.parse(succeeded)).toEqual(succeeded);

		// No mention → no position: §12 averages position over mentions only.
		expect(
			runOutcomeSchema.safeParse({ ...succeeded, measurement: { ...measurement, mention: false } }).success,
		).toBe(false);
		expect(
			runOutcomeSchema.safeParse({
				...succeeded,
				measurement: { ...measurement, mention: false, position: null, ownedCitation: false },
			}).success,
		).toBe(true);
		// An owned citation with no citations cannot be verified against the row.
		expect(
			runOutcomeSchema.safeParse({ ...succeeded, measurement: { ...measurement, citations: [] } }).success,
		).toBe(false);
		// Evidence on a run that did not succeed would enter the ledger unobserved.
		expect(
			runOutcomeSchema.safeParse({
				...succeeded,
				status: "INVALID",
				validity: "INVALID",
				invalidReason: "PROVIDER_TIMEOUT",
			}).success,
		).toBe(false);
		// Unknown extraction fields stay out of stored run state.
		expect(
			runOutcomeSchema.safeParse({ ...succeeded, measurement: { ...measurement, sentiment: "positive" } }).success,
		).toBe(false);
	});
});

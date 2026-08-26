import { describe, expect, it } from "vitest";
import {
	assertAdapterAllowed,
	assertAdaptersConfigured,
	assertMeasurementAllowed,
	measurementAdapterNamesFor,
	measurementConfigFromEnv,
	resolveMeasurementAdapterName,
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

	it("measures each system on the adapter that sells it, not on one name for the whole service", () => {
		expect(resolveMeasurementAdapterName("brightdata", "ChatGPT")).toBe("brightdata-chatgpt");
		expect(resolveMeasurementAdapterName("brightdata", "Perplexity")).toBe("brightdata-perplexity");
		// Both channels of the full landscape plan, from one configured name.
		expect(resolveMeasurementAdapterName("auto", "Gemini")).toBe("brightdata-gemini");
		expect(resolveMeasurementAdapterName("auto", "anthropic/claude-haiku-4.5")).toBe("openrouter");
		// A plain name still means itself, so a single-surface run stays possible.
		expect(resolveMeasurementAdapterName("brightdata-chatgpt", "ChatGPT")).toBe("brightdata-chatgpt");
		expect(resolveMeasurementAdapterName("noop", null)).toBe("noop");
	});

	it("refuses a system the configured family cannot measure rather than guessing one", () => {
		expect(() => resolveMeasurementAdapterName("brightdata", "anthropic/claude-haiku-4.5")).toThrow(
			"SELENA_ADAPTER_NO_ROUTE",
		);
		expect(() => resolveMeasurementAdapterName("brightdata", null)).toThrow("SELENA_ADAPTER_NO_ROUTE");
	});

	it("holds every adapter a family can reach to the same owner gate", () => {
		const brightData = ["brightdata-chatgpt", "brightdata-gemini", "brightdata-perplexity"];
		expect(measurementAdapterNamesFor("brightdata").sort()).toEqual([...brightData].sort());
		expect(measurementAdapterNamesFor("auto").sort()).toEqual([...brightData, "openrouter"].sort());
		expect(() => assertAdaptersConfigured("brightdata", ["noop", ...brightData])).not.toThrow();
		// One missing member is enough: the family is refused before a permit is spent.
		expect(() => assertAdaptersConfigured("brightdata", ["noop", "brightdata-chatgpt"])).toThrow(
			"SELENA_ADAPTER_NOT_REGISTERED",
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
			provider: "openrouter",
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
		expect(runOutcomeSchema.safeParse({ ...succeeded, providerApiKey: "provider-key-placeholder" }).success).toBe(false);
		// A cost without a basis would read as an actual charge by default.
		expect(runOutcomeSchema.safeParse({ ...succeeded, costBasis: undefined }).success).toBe(false);
		// A cost without its billing transport cannot be attributed in the ledger.
		expect(runOutcomeSchema.safeParse({ ...succeeded, provider: undefined }).success).toBe(false);
		// A charge on a failed run is legal: the request was dispatched and may
		// have been billed even though no usable answer came back.
		expect(
			runOutcomeSchema.safeParse({
				dispatchKey: "k1",
				status: "INVALID",
				validity: "INVALID",
				invalidReason: "EMPTY_RESPONSE",
				costUsd: 0.005,
				costBasis: "actual",
				provider: "openrouter",
			}).success,
		).toBe(true);
	});

	it("accepts a grounded measurement and rejects one that contradicts itself", () => {
		const measurement = {
			system: "chatgpt",
			model: "gpt-5",
			language: "en",
			region: "ID",
			extractorVersion: "selena-extract/1",
			captureMode: "training_data" as const,
			brand: "KORA Food Hall",
			mention: true,
			position: 2,
			ownedCitation: true,
			citations: [{ url: "https://example.com/menu", domain: "example.com" }],
			competitors: [{ name: "Rival Cafe", position: 1 }],
			factualErrors: [],
		};
		const succeeded = {
			dispatchKey: "order:scenario:system:0:1",
			status: "SUCCEEDED" as const,
			validity: "VALID" as const,
			measurement,
		};
		expect(runOutcomeSchema.parse(succeeded)).toEqual(succeeded);

		// An adapter that did not establish how the answer was produced must not
		// have one assumed for it: live search and training data are different
		// observations, and defaulting either way would invent the difference.
		const { captureMode: _unset, ...withoutCaptureMode } = measurement;
		expect(runOutcomeSchema.parse({ ...succeeded, measurement: withoutCaptureMode }).measurement?.captureMode).toBe(
			"unknown",
		);
		expect(
			runOutcomeSchema.safeParse({ ...succeeded, measurement: { ...measurement, captureMode: "guessed" } }).success,
		).toBe(false);

		// No mention → no position: §12 averages position over mentions only.
		expect(runOutcomeSchema.safeParse({ ...succeeded, measurement: { ...measurement, mention: false } }).success).toBe(
			false,
		);
		expect(
			runOutcomeSchema.safeParse({
				...succeeded,
				measurement: { ...measurement, mention: false, position: null, ownedCitation: false },
			}).success,
		).toBe(true);
		// An owned citation with no citations cannot be verified against the row.
		expect(runOutcomeSchema.safeParse({ ...succeeded, measurement: { ...measurement, citations: [] } }).success).toBe(
			false,
		);
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
		// Addendum §3.4: an ordinal is 1-based; 0 and fractions are refused.
		expect(runOutcomeSchema.safeParse({ ...succeeded, measurement: { ...measurement, position: 0 } }).success).toBe(
			false,
		);
		expect(runOutcomeSchema.safeParse({ ...succeeded, measurement: { ...measurement, position: 1.5 } }).success).toBe(
			false,
		);
		expect(
			runOutcomeSchema.safeParse({
				...succeeded,
				measurement: { ...measurement, competitors: [{ name: "Rival Cafe", position: 0 }] },
			}).success,
		).toBe(false);
		// Addendum §5.3: every stored extraction names its extractor.
		expect(
			runOutcomeSchema.safeParse({ ...succeeded, measurement: { ...measurement, extractorVersion: undefined } })
				.success,
		).toBe(false);
	});
});

import { z } from "zod";

// Measurement execution is the only layer allowed to reach a provider, so it
// ships inert: the flag is default-off and the adapter name defaults to the
// noop implementation. Nothing here performs, or can perform, transport — it
// decides whether an injected adapter may be invoked at all.

/** Adapters that provably perform no provider call and hold no credentials. */
export const inertMeasurementAdapters = ["noop", "stub"] as const;
export type InertMeasurementAdapter = (typeof inertMeasurementAdapters)[number];

export type SelenaMeasurementConfig = {
	enabled: boolean;
	adapter: string;
};

export function measurementConfigFromEnv(env: Record<string, string | undefined>): SelenaMeasurementConfig {
	return {
		enabled: env.SELENA_MEASUREMENT_ENABLED === "true",
		adapter: env.SELENA_MEASUREMENT_ADAPTER ?? "noop",
	};
}

export function assertMeasurementAllowed(config: SelenaMeasurementConfig): void {
	if (!config.enabled) throw new Error("SELENA_MEASUREMENT_DISABLED");
}

/**
 * A live adapter cannot be selected by configuration alone. Even a registered,
 * correctly named provider adapter is refused here, so switching one
 * environment variable can never turn spend on: the owner has to change this
 * allowlist deliberately, in code, alongside supplying credentials.
 */
export function assertAdapterAllowed(adapterName: string, registered: readonly string[]): void {
	if (!registered.includes(adapterName)) throw new Error("SELENA_ADAPTER_NOT_REGISTERED");
	if (!(inertMeasurementAdapters as readonly string[]).includes(adapterName))
		throw new Error("SELENA_LIVE_ADAPTER_REQUIRES_OWNER_GO");
}

export const runOutcomeStatuses = ["SUCCEEDED", "INVALID", "FAILED"] as const;
export const runValidities = ["VALID", "INVALID"] as const;

// strictObject is load-bearing: an adapter cannot smuggle extra fields into
// stored run state without the contract changing here first.
export const runOutcomeSchema = z
	.strictObject({
		dispatchKey: z.string().min(1),
		status: z.enum(runOutcomeStatuses),
		validity: z.enum(runValidities),
		invalidReason: z.string().min(1).optional(),
		rawResponseReference: z.string().min(1).optional(),
		tokenUsage: z
			.strictObject({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative() })
			.optional(),
		costUsd: z.number().nonnegative().optional(),
	})
	.superRefine((outcome, issues) => {
		// A run that did not succeed must never be stored as valid evidence, and
		// invalid evidence must say why — an unexplained INVALID row is
		// indistinguishable from a silently dropped measurement.
		if (outcome.status !== "SUCCEEDED" && outcome.validity !== "INVALID")
			issues.addIssue({ code: "custom", message: "RUN_OUTCOME_VALIDITY_MISMATCH", path: ["validity"] });
		if (outcome.validity === "INVALID" && !outcome.invalidReason)
			issues.addIssue({ code: "custom", message: "RUN_OUTCOME_INVALID_REASON_REQUIRED", path: ["invalidReason"] });
	});
export type RunOutcome = z.infer<typeof runOutcomeSchema>;

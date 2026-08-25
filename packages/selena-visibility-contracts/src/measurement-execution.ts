import { z } from "zod";

// Measurement execution is the only layer allowed to reach a provider, so it
// ships inert: the flag is default-off and the adapter name defaults to the
// noop implementation. Nothing here performs, or can perform, transport — it
// decides whether an injected adapter may be invoked at all.

/**
 * How long a retained answer text is kept before only its findings remain.
 * Thirteen months is the owner's setting: a year of year-over-year comparison
 * plus room, after which the text is dropped and the evidence around it stays.
 */
export const ANSWER_RETENTION_MONTHS = 13;

export function answerRetainUntil(from: Date): Date {
	const until = new Date(from);
	until.setMonth(until.getMonth() + ANSWER_RETENTION_MONTHS);
	return until;
}

/** Adapters that provably perform no provider call and hold no credentials. */
export const inertMeasurementAdapters = ["noop", "stub"] as const;
export type InertMeasurementAdapter = (typeof inertMeasurementAdapters)[number];

/**
 * The owner gate. Selecting an adapter outside this list is refused even when
 * it is registered, so configuration alone can never turn spend on. Every
 * name beyond the inert pair is an explicit owner decision made together with
 * supplying credentials and a provider-side spend cap: `openrouter` (API View)
 * is approved on those terms.
 */
export const ownerApprovedMeasurementAdapters = [
	...inertMeasurementAdapters,
	"openrouter",
	// Visitor View, one adapter per sold surface: a run is delivered under the
	// surface the customer bought or not at all.
	"brightdata-chatgpt",
	"brightdata-gemini",
	"brightdata-perplexity",
] as const;
export type OwnerApprovedMeasurementAdapter = (typeof ownerApprovedMeasurementAdapters)[number];

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
 * correctly named provider adapter is refused here unless the owner has put it
 * on the approved list deliberately, in code, alongside supplying credentials.
 */
export function assertAdapterAllowed(adapterName: string, registered: readonly string[]): void {
	if (!registered.includes(adapterName)) throw new Error("SELENA_ADAPTER_NOT_REGISTERED");
	if (!(ownerApprovedMeasurementAdapters as readonly string[]).includes(adapterName))
		throw new Error("SELENA_LIVE_ADAPTER_REQUIRES_OWNER_GO");
}

export const runOutcomeStatuses = ["SUCCEEDED", "INVALID", "FAILED"] as const;
export const runValidities = ["VALID", "INVALID"] as const;
export const runCostBases = ["actual", "estimated"] as const;
export const runCaptureModes = ["live_search", "training_data", "unknown"] as const;
export type RunCaptureMode = (typeof runCaptureModes)[number];

/**
 * What the adapter observed in the answer — one Evidence Ledger row's worth of
 * extraction. strictObject for the same reason as the outcome itself: an
 * adapter cannot smuggle fields past the contract.
 */
export const runMeasurementSchema = z
	.strictObject({
		system: z.string().min(1),
		model: z.string().min(1).optional(),
		language: z.string().min(1),
		region: z.string().min(1).optional(),
		// Addendum §5.3: every stored extraction names the exact extractor that
		// produced it, so a backfill with a newer extractor is distinguishable
		// from the original observation.
		extractorVersion: z.string().min(1),
		/**
		 * How the answer was produced. Perplexity searches the live web while
		 * ChatGPT and Gemini answer from training data: the two are different
		 * observations of different things, and a rate that averages them is
		 * about neither. The adapter that made the call is the source of truth;
		 * anything that did not establish it says so rather than guessing.
		 */
		captureMode: z.enum(runCaptureModes).default("unknown"),
		/** The canonical brand name the extraction matched against. */
		brand: z.string().min(1),
		mention: z.boolean(),
		// Position exists only among mentions (§12: average position is computed
		// over mentions only), so a non-mention carries null, never 0. Ordinal
		// from 1; 0 and fractions are refused by construction (addendum §3.4).
		position: z.number().int().positive().nullable(),
		ownedCitation: z.boolean(),
		citations: z.array(z.strictObject({ url: z.string().min(1), domain: z.string().min(1) })),
		competitors: z.array(z.strictObject({ name: z.string().min(1), position: z.number().int().positive().nullable() })),
		factualErrors: z.array(z.string().min(1)),
	})
	.superRefine((m, issues) => {
		if (!m.mention && m.position !== null)
			issues.addIssue({ code: "custom", message: "RUN_MEASUREMENT_POSITION_WITHOUT_MENTION", path: ["position"] });
		// An owned citation is a citation: claiming one with an empty citation
		// list would make owned-citation rate unverifiable against the row.
		if (m.ownedCitation && m.citations.length === 0)
			issues.addIssue({
				code: "custom",
				message: "RUN_MEASUREMENT_OWNED_CITATION_WITHOUT_CITATIONS",
				path: ["ownedCitation"],
			});
	});
export type RunMeasurement = z.infer<typeof runMeasurementSchema>;

// strictObject is load-bearing: an adapter cannot smuggle extra fields into
// stored run state without the contract changing here first.
export const runOutcomeSchema = z
	.strictObject({
		dispatchKey: z.string().min(1),
		status: z.enum(runOutcomeStatuses),
		validity: z.enum(runValidities),
		invalidReason: z.string().min(1).optional(),
		rawResponseReference: z.string().min(1).optional(),
		// The answer itself, retained deliberately: competitor and citation
		// analysis reads the text, and retaining it lets a metric be recomputed
		// without paying for a second measurement of a different moment. The
		// owner set a retention window on the text (see CABINET_MODEL.md §4a);
		// findings derived from it outlive the text.
		answer: z
			.strictObject({
				text: z.string().min(1),
				// What the provider itself named as sources, when it names any.
				citedUrls: z.array(z.string().min(1)).optional(),
				retainUntil: z.date(),
			})
			.optional(),
		/**
		 * What the Visitor View surface displayed as sources beside the answer.
		 * A different origin from answer.citedUrls (the provider naming its own
		 * sources) and from anything later derived from the answer text — the
		 * three must never be pooled into one figure. Top-level rather than
		 * inside answer because a surface whose answer text stays out of the row
		 * (Bright Data keeps a reference, not the text) still shows citations,
		 * and losing them with the text would erase evidence that was displayed.
		 */
		sources: z
			.array(
				z.strictObject({
					url: z.string().min(1),
					domain: z.string().min(1),
					title: z.string().min(1).optional(),
				}),
			)
			.optional(),
		tokenUsage: z
			.strictObject({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative() })
			.optional(),
		costUsd: z.number().nonnegative().optional(),
		// §10.2: a provider that does not return its real charge must be stored
		// as an estimate, never presented as the actual spend.
		costBasis: z.enum(runCostBases).optional(),
		// The transport that billed the charge ("openrouter", "brightdata") —
		// not the sold surface. Ledger attribution must not depend on whether
		// extraction happened to succeed.
		provider: z.string().min(1).optional(),
		measurement: runMeasurementSchema.optional(),
	})
	.superRefine((outcome, issues) => {
		// A run that did not succeed must never be stored as valid evidence, and
		// invalid evidence must say why — an unexplained INVALID row is
		// indistinguishable from a silently dropped measurement.
		if (outcome.status !== "SUCCEEDED" && outcome.validity !== "INVALID")
			issues.addIssue({ code: "custom", message: "RUN_OUTCOME_VALIDITY_MISMATCH", path: ["validity"] });
		if (outcome.validity === "INVALID" && !outcome.invalidReason)
			issues.addIssue({ code: "custom", message: "RUN_OUTCOME_INVALID_REASON_REQUIRED", path: ["invalidReason"] });
		if (outcome.costUsd !== undefined && outcome.costBasis === undefined)
			issues.addIssue({ code: "custom", message: "RUN_OUTCOME_COST_BASIS_REQUIRED", path: ["costBasis"] });
		if (outcome.costUsd !== undefined && outcome.provider === undefined)
			issues.addIssue({ code: "custom", message: "RUN_OUTCOME_COST_PROVIDER_REQUIRED", path: ["provider"] });
		// Only a run that actually succeeded can carry evidence; an extraction
		// attached to a failed run would enter the ledger as if it were observed.
		if (outcome.measurement && outcome.status !== "SUCCEEDED")
			issues.addIssue({ code: "custom", message: "RUN_OUTCOME_MEASUREMENT_REQUIRES_SUCCESS", path: ["measurement"] });
	});
export type RunOutcome = z.infer<typeof runOutcomeSchema>;

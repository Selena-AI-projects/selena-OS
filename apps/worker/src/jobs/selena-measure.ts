import { createBrightDataAdapter } from "@workspace/lib/adapters/brightdata";
import { createOpenRouterAdapter, resolveCatalogApiModel } from "@workspace/lib/adapters/openrouter";
import { db } from "@workspace/lib/db/db";
import { isMaintenanceEnabled } from "@workspace/lib/run-policy";
import { createSelenaMeasurementResolvers } from "@workspace/lib/selena-extraction-context";
import { createNoopMeasurementAdapter } from "@workspace/lib/selena-measurement";
import {
	assertDispatchModes,
	type MeasurementAdapterRegistry,
	measurementAdapterNamesFor,
	measurementConfigFromEnv,
	runMeasurementForPermit,
} from "@workspace/lib/selena-run-executor";
import { createSelenaRepositories, type SelenaRepositoryContext } from "@workspace/lib/selena-visibility-repositories";
import type { Job } from "pg-boss";

export interface SelenaMeasureData {
	permitId: string;
	organizationId: string;
	/** The admin who enqueued the run; audit rows are attributed to them. */
	actorId?: string;
}

// The OpenRouter API View adapter is registered inside the handler, and only
// when SELENA_MEASUREMENT_ADAPTER selects it: constructing it reads
// OPENROUTER_API_KEY, and a missing key must fail the jobs that need it — not
// the worker boot, and not runs the inert noop adapter executes. Selecting it
// still takes the owner-approved allowlist in the contracts package —
// "Turning measurement on" in SELENA_OWNER_OPERATING_GUIDE.md walks the full
// chain.
const ADAPTERS: MeasurementAdapterRegistry = { noop: createNoopMeasurementAdapter() };

/**
 * Bright Data's own default endpoint. One adapter instance measures one
 * surface — `brightdata-chatgpt` and its two siblings — so a plan that sells
 * three of them is configured as the `brightdata` family and every instance it
 * routes to is built here. Only the API token is account-specific.
 */
const BRIGHTDATA_DEFAULT_ENDPOINT = "https://api.brightdata.com/datasets/v3/scrape";
const BRIGHTDATA_SURFACES = ["chatgpt", "gemini", "perplexity"] as const;

/**
 * One collector per surface, taken from the account's own scrapers. They are
 * defaults rather than secrets — a dataset id names a public collector — so a
 * surface can be measured without another environment variable, and an
 * override stays available if a collector is ever replaced.
 */
const BRIGHTDATA_DATASET_IDS: Record<(typeof BRIGHTDATA_SURFACES)[number], string> = {
	chatgpt: "gd_m7aof0k82r803d5bjm",
	// Read off the account's own scraper page. The id transcribed by eye before
	// it carried a capital Z where this one has a digit 2, and the account
	// answered that as "dataset does not exist" — at the cost of a permit each
	// time. An empty value here still means the surface is not registered, so
	// the family is refused before a permit is claimed rather than after.
	gemini: "gd_mbz66arm2mf9cu856y",
	perplexity: "gd_m7dhdot1vw9a7gc1n",
};

function brightDataDatasetId(surface: (typeof BRIGHTDATA_SURFACES)[number]) {
	const override = process.env[`SELENA_BRIGHTDATA_DATASET_${surface.toUpperCase()}`]?.trim();
	return override || BRIGHTDATA_DATASET_IDS[surface];
}

function brightDataAdapterName(surface: (typeof BRIGHTDATA_SURFACES)[number]) {
	return `brightdata-${surface}`;
}

// Both per-permit reads, tenant-scoped by the permit itself. Without the
// extraction context a run is still stored and billed, but no mention,
// position or citation is extracted, so no ledger metric moves.
const resolvers = createSelenaMeasurementResolvers(db);

/**
 * Executes one already-minted run permit. Nothing enqueues this job on a
 * timer: a commercial run starts from an explicit admin action, so the worker
 * only supplies the handler.
 */
export async function selenaMeasureJob(jobs: Job<SelenaMeasureData>[]): Promise<void> {
	const config = measurementConfigFromEnv(process.env);
	if (!config.enabled) {
		console.log(`[selena-measure] Skipped ${jobs.length} job(s) because SELENA_MEASUREMENT_ENABLED is not true`);
		return;
	}
	// Recurring maintenance and an order-scoped dispatch would both drive
	// provider calls for the same work, doubling spend and breaking cardinality.
	assertDispatchModes(isMaintenanceEnabled(process.env.SCHEDULE_MAINTENANCE_ENABLED), true);
	const repositories = createSelenaRepositories(db);
	// Constructed only where selected: building the OpenRouter adapter validates
	// OPENROUTER_API_KEY, and a permit executed by the inert noop adapter must
	// not die on a key it would never use. A family name selects several at
	// once, because one plan is measured across several systems.
	const selected = new Set(measurementAdapterNamesFor(config.adapter));
	const adapters: MeasurementAdapterRegistry = {
		...ADAPTERS,
		...(selected.has("openrouter")
			? {
					openrouter: createOpenRouterAdapter({
						apiKey: process.env.OPENROUTER_API_KEY ?? "",
						model: resolveCatalogApiModel(process.env.SELENA_OPENROUTER_MODEL),
						fetchImpl: fetch,
						resolveScenarioText: resolvers.resolveScenarioText,
						resolveExtractionContext: resolvers.resolveExtractionContext,
					}),
				}
			: {}),
		...Object.fromEntries(
			BRIGHTDATA_SURFACES.filter(
				(surface) => selected.has(brightDataAdapterName(surface)) && brightDataDatasetId(surface) !== "",
			).map((surface) => [
				brightDataAdapterName(surface),
				createBrightDataAdapter({
					apiKey: process.env.BRIGHTDATA_API_TOKEN ?? "",
					endpoint: process.env.SELENA_BRIGHTDATA_ENDPOINT?.trim() || BRIGHTDATA_DEFAULT_ENDPOINT,
					datasetId: brightDataDatasetId(surface),
					system: surface,
					fetchImpl: fetch,
					resolveScenarioText: resolvers.resolveScenarioText,
					resolveExtractionContext: resolvers.resolveExtractionContext,
				}),
			]),
		),
	};
	for (const job of jobs) {
		const ctx: SelenaRepositoryContext = {
			actorId: job.data.actorId ?? "worker:selena-measure",
			tenantId: job.data.organizationId,
			role: "owner",
			authType: "session",
			permissions: [],
		};
		const result = await runMeasurementForPermit({
			permitId: job.data.permitId,
			ctx,
			store: repositories.runs,
			adapters,
			config,
			cycleState: { globalEmergencyStop: process.env.SELENA_EMERGENCY_STOP === "true" },
		});
		// A failure is already recorded as a terminal run; rethrowing would only
		// buy a retry, and a retry cannot re-execute a permit that is spent.
		if (result.status === "failed")
			console.error(`[selena-measure] permit ${job.data.permitId} failed: ${result.reason}`);
		else console.log(`[selena-measure] permit ${job.data.permitId}: ${result.status}`);
	}
}

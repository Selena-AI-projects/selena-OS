import { createOpenRouterAdapter, resolveCatalogApiModel } from "@workspace/lib/adapters/openrouter";
import { db } from "@workspace/lib/db/db";
import { isMaintenanceEnabled } from "@workspace/lib/run-policy";
import { createSelenaMeasurementResolvers } from "@workspace/lib/selena-extraction-context";
import { createNoopMeasurementAdapter } from "@workspace/lib/selena-measurement";
import {
	type MeasurementAdapterRegistry,
	assertDispatchModes,
	measurementConfigFromEnv,
	runMeasurementForPermit,
} from "@workspace/lib/selena-run-executor";
import { type SelenaRepositoryContext, createSelenaRepositories } from "@workspace/lib/selena-visibility-repositories";
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
	// Constructed only when selected: building it validates OPENROUTER_API_KEY,
	// and a permit executed by the inert noop adapter must not die on a key it
	// would never use.
	const adapters: MeasurementAdapterRegistry =
		config.adapter === "openrouter"
			? {
					...ADAPTERS,
					openrouter: createOpenRouterAdapter({
						apiKey: process.env.OPENROUTER_API_KEY ?? "",
						model: resolveCatalogApiModel(process.env.SELENA_OPENROUTER_MODEL),
						fetchImpl: fetch,
						resolveScenarioText: resolvers.resolveScenarioText,
						resolveExtractionContext: resolvers.resolveExtractionContext,
					}),
				}
			: ADAPTERS;
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

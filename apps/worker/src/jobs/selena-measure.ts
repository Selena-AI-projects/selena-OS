import { createOpenRouterAdapter } from "@workspace/lib/adapters/openrouter-measurement-adapter";
import { db } from "@workspace/lib/db/db";
import { isMaintenanceEnabled } from "@workspace/lib/run-policy";
import { createNoopMeasurementAdapter } from "@workspace/lib/selena-measurement";
import {
	type MeasurementAdapterRegistry,
	assertDispatchModes,
	measurementConfigFromEnv,
	runMeasurementForPermit,
} from "@workspace/lib/selena-run-executor";
import { type SelenaRepositoryContext, createSelenaRepositories } from "@workspace/lib/selena-visibility-repositories";
import { apiModelIds } from "@workspace/selena-visibility-contracts";
import type { Job } from "pg-boss";

export interface SelenaMeasureData {
	permitId: string;
	organizationId: string;
	/** The admin who enqueued the run; audit rows are attributed to them. */
	actorId?: string;
}

// The OpenRouter API View adapter is registered per job below (it needs the
// job's tenant context to read scenario text); selecting it still takes
// SELENA_MEASUREMENT_ADAPTER=openrouter plus the owner-approved allowlist in
// the contracts package — "Turning measurement on" in
// SELENA_OWNER_OPERATING_GUIDE.md walks the full chain.
const ADAPTERS: MeasurementAdapterRegistry = { noop: createNoopMeasurementAdapter() };

/** A run measures the model the customer bought, so only catalog ids pass. */
function openRouterModelFromEnv(env: Record<string, string | undefined>): string {
	const requested = env.SELENA_OPENROUTER_MODEL ?? "anthropic/claude-haiku-4.5";
	if (!(apiModelIds as readonly string[]).includes(requested))
		throw new Error(`SELENA_OPENROUTER_MODEL must be a catalog API View model id, got "${requested}"`);
	return requested;
}

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
	for (const job of jobs) {
		const ctx: SelenaRepositoryContext = {
			actorId: job.data.actorId ?? "worker:selena-measure",
			tenantId: job.data.organizationId,
			role: "owner",
			authType: "session",
			permissions: [],
		};
		const adapters: MeasurementAdapterRegistry = {
			...ADAPTERS,
			openrouter: createOpenRouterAdapter({
				apiKey: process.env.OPENROUTER_API_KEY ?? "",
				model: openRouterModelFromEnv(process.env),
				fetchImpl: fetch,
				resolveScenarioText: (permit) => repositories.scenarios.textFor(ctx, permit.scenarioId),
			}),
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

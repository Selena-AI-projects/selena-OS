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
import type { Job } from "pg-boss";

export interface SelenaMeasureData {
	permitId: string;
	organizationId: string;
	/** The admin who enqueued the run; audit rows are attributed to them. */
	actorId?: string;
}

// Only inert adapters are registered. A live provider adapter is a separate
// owner decision: it needs credentials this deployment does not hold, and the
// execution contract refuses any adapter outside its inert allowlist even when
// one is registered here.
//
// The OpenRouter API View adapter is built and tested but deliberately absent
// from this registry; "Turning measurement on" in SELENA_OWNER_OPERATING_GUIDE.md
// is the wiring, the credentials and the allowlist edit it takes to select it.
const ADAPTERS: MeasurementAdapterRegistry = { noop: createNoopMeasurementAdapter() };

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
		const result = await runMeasurementForPermit({
			permitId: job.data.permitId,
			ctx,
			store: repositories.runs,
			adapters: ADAPTERS,
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

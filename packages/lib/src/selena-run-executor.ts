import {
	type RunOutcome,
	type SelenaMeasurementConfig,
	assertAdapterAllowed,
	assertMeasurementAllowed,
	runOutcomeSchema,
} from "@workspace/selena-visibility-contracts";
import { type ControlledCycleState, assertTransportAllowed } from "./run-policy";
import type { SelenaExecutablePermit, SelenaMeasurementAdapter } from "./selena-measurement";

// This module is the whole execution path, and it is pure: the adapter is
// injected, so no queue client, scheduler or transport can be reached from
// here. Every guard that must hold before a provider is contacted lives in
// executePermit, which means an adapter has no way to be invoked without them.

// Re-exported so the worker reads the execution contract through this module
// rather than restating the flag names it depends on.
export {
	assertDispatchModes,
	measurementConfigFromEnv,
	type SelenaMeasurementConfig,
} from "@workspace/selena-visibility-contracts";

/** The planning-seam adapter is exactly what the executor consumes. */
export type MeasurementAdapter = SelenaMeasurementAdapter;
export type MeasurementAdapterRegistry = Readonly<Record<string, MeasurementAdapter>>;

export type ExecutePermitInput = {
	permit: SelenaExecutablePermit;
	adapter: MeasurementAdapter;
	cycleState: ControlledCycleState;
	config: SelenaMeasurementConfig;
	/** Injected so permit expiry is testable and never reads an ambient clock. */
	now: Date;
};

export async function executePermit(input: ExecutePermitInput): Promise<RunOutcome> {
	const { permit, adapter, cycleState, config, now } = input;
	assertMeasurementAllowed(config);
	// Transport-adjacent by design: an emergency stop has to be able to halt a
	// run that is already claimed, not merely stop new ones from being planned.
	assertTransportAllowed(cycleState);
	if (permit.expiresAt.getTime() <= now.getTime()) throw new Error("SELENA_PERMIT_EXPIRED");
	// The permit handed in is the pre-consumption snapshot the claim returned;
	// a replay therefore arrives already consumed and is refused here, so one
	// permit can never authorize a second provider call.
	if (permit.consumedAt !== null) throw new Error("SELENA_PERMIT_ALREADY_CONSUMED");
	const outcome = runOutcomeSchema.parse(await adapter.execute(permit));
	if (outcome.dispatchKey !== permit.dispatchKey) throw new Error("SELENA_DISPATCH_KEY_MISMATCH");
	return outcome;
}

/**
 * Storage port for the runner. Kept structural so this module stays free of
 * repository and database imports; the worker passes the real repositories.
 */
export type MeasurementRunStore<Ctx> = {
	claim(
		ctx: Ctx,
		permitId: string,
		opts?: { now?: Date },
	): Promise<{
		permit: SelenaExecutablePermit;
		run: { id: string };
		cycle: { id: string; status: string };
	}>;
	complete(ctx: Ctx, runId: string, outcome: RunOutcome, opts?: { now?: Date }): Promise<unknown>;
};

export type MeasurementRunResult =
	| { status: "skipped"; reason: string }
	| { status: "completed"; runId: string; outcome: RunOutcome }
	| { status: "failed"; runId: string; reason: string };

/** Error text is stored in run state, so keep it to the short guard codes. */
function failureReason(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

/**
 * Claim a permit, execute it through the injected adapter, and record the
 * outcome. A failure is recorded as a terminal FAILED run rather than rethrown:
 * the permit is spent by the claim, so a retry could only produce a second
 * provider call for work that is already authorized once.
 */
export async function runMeasurementForPermit<Ctx>(input: {
	permitId: string;
	ctx: Ctx;
	store: MeasurementRunStore<Ctx>;
	adapters: MeasurementAdapterRegistry;
	config: SelenaMeasurementConfig;
	cycleState?: Partial<ControlledCycleState>;
	now?: Date;
}): Promise<MeasurementRunResult> {
	// Checked before anything is read or written: while measurement is off the
	// runner touches neither storage nor an adapter.
	if (!input.config.enabled) return { status: "skipped", reason: "SELENA_MEASUREMENT_DISABLED" };
	assertAdapterAllowed(input.config.adapter, Object.keys(input.adapters));
	const adapter = input.adapters[input.config.adapter];
	const now = input.now ?? new Date();
	const { permit, run, cycle } = await input.store.claim(input.ctx, input.permitId, { now });
	const cycleState: ControlledCycleState = {
		activeMaintenanceJobs: 0,
		activeCohortJobs: 0,
		cohortId: permit.cycleId,
		// One permit authorizes exactly one provider call, and nothing here may
		// widen that: the permit set is the cardinality budget.
		expectedJobs: 1,
		expectedProviderCalls: 1,
		seenCohortIds: new Set<string>(),
		globalEmergencyStop: false,
		orderStopped: cycle.status === "STOPPED",
		...input.cycleState,
	};
	try {
		const outcome = await executePermit({ permit, adapter, cycleState, config: input.config, now });
		await input.store.complete(input.ctx, run.id, outcome, { now });
		return { status: "completed", runId: run.id, outcome };
	} catch (error) {
		const reason = failureReason(error);
		await input.store.complete(
			input.ctx,
			run.id,
			{ dispatchKey: permit.dispatchKey, status: "FAILED", validity: "INVALID", invalidReason: reason },
			{ now },
		);
		return { status: "failed", runId: run.id, reason };
	}
}

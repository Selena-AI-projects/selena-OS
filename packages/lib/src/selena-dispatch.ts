import {
	assertExpertVerified,
	dispatchKey,
	expectedRunsFromScope,
	type MeasurementScope,
	type SystemChannel,
} from "@workspace/selena-visibility-contracts";

// Permits planned here are database records only: this module must stay free
// of queue clients, schedulers and network transport so that planning an order
// can never execute it.

export type PlannedPermit = {
	dispatchKey: string;
	scenarioId: string;
	systemId: string;
	channel: SystemChannel;
	repeatIndex: number;
};

export function planOrderDispatch(input: {
	orderId: string;
	lockVersion: number;
	scope: MeasurementScope;
}): PlannedPermit[] {
	const planned: PlannedPermit[] = [];
	for (const scenarioId of input.scope.scenarios) {
		for (const system of input.scope.systems) {
			for (let repeatIndex = 0; repeatIndex < input.scope.repeats; repeatIndex += 1) {
				planned.push({
					dispatchKey: dispatchKey({
						orderId: input.orderId,
						scenarioId,
						systemId: system.systemId,
						channel: system.channel,
						repeatIndex,
						configurationVersion: input.lockVersion,
					}),
					scenarioId,
					systemId: system.systemId,
					channel: system.channel,
					repeatIndex,
				});
			}
		}
	}
	if (planned.length !== expectedRunsFromScope(input.scope)) throw new Error("SELENA_EXPECTED_RUNS_MISMATCH");
	// The scope schema already forbids duplicate scenarios/systems; this guard
	// keeps the invariant even for a scope constructed outside the schema.
	if (new Set(planned.map((permit) => permit.dispatchKey)).size !== planned.length)
		throw new Error("SELENA_DISPATCH_KEY_COLLISION");
	return planned;
}

/** The lock's committed expectedRuns must equal what its own scope implies. */
export function assertLockExpectedRuns(scope: MeasurementScope, lockExpectedRuns: number): number {
	const expected = expectedRunsFromScope(scope);
	if (expected !== lockExpectedRuns) throw new Error("SELENA_EXPECTED_RUNS_MISMATCH");
	return expected;
}

export const qcDecisions = ["approved", "rejected"] as const;
export type QcDecision = (typeof qcDecisions)[number];

export function assertQcDecision(value: string): asserts value is QcDecision {
	if (!qcDecisions.includes(value as QcDecision)) throw new Error("QC_DECISION_INVALID");
}

/** What a cycle has to look like before its order can be signed off. */
export type QcReviewableCycle = { id: string; status: string; expectedRuns: number; completedRuns: number };

/**
 * Whether an approved QC record may publish this order. Approval is the human
 * step that turns measured runs into a deliverable, so it has to be refused
 * while the cycle is still producing them: a READY order says the ledger is
 * complete, and a half-finished cycle would make that untrue.
 *
 * READY is accepted as well as QC_REQUIRED because a second approval of the
 * same order is a replay of a decision already taken, not a new one.
 */
export function assertQcApprovable(orderStatus: string, cycles: readonly QcReviewableCycle[]): void {
	if (orderStatus !== "QC_REQUIRED" && orderStatus !== "READY") throw new Error("SELENA_QC_ORDER_NOT_IN_REVIEW");
	if (cycles.length === 0) throw new Error("SELENA_QC_NO_CYCLE");
	if (cycles.some((cycle) => cycle.completedRuns < cycle.expectedRuns)) throw new Error("SELENA_QC_CYCLE_UNFINISHED");
}

/**
 * Whether an order may be handed to the client. Delivery is where the Expert
 * Verified promise is either true or a lie, so the QC record is checked here
 * rather than assumed from the order having reached READY — every plan goes
 * through QC_REQUIRED, and nothing else in the pipeline asks for the sign-off.
 */
export function assertOrderDeliverable(orderStatus: string, hasApprovedQcRecord: boolean): void {
	if (orderStatus !== "READY") throw new Error("SELENA_ORDER_NOT_READY");
	assertExpertVerified(hasApprovedQcRecord);
}

/** The permit fields that decide whether it may still be dispatched. */
export type DispatchablePermit = {
	id: string;
	dispatchKey: string;
	consumedAt: Date | null;
	expiresAt: Date;
};

/**
 * The permits an order-scoped dispatch may still act on. A consumed permit is
 * spent and an expired one has lost its authorization; the executor refuses
 * both, so selecting them here would only enqueue work that must fail.
 */
export function selectEnqueueablePermits<T extends DispatchablePermit>(permits: readonly T[], now: Date): T[] {
	return permits.filter((permit) => permit.consumedAt === null && permit.expiresAt.getTime() > now.getTime());
}

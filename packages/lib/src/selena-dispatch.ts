import {
	type MeasurementScope,
	type SystemChannel,
	dispatchKey,
	expectedRunsFromScope,
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

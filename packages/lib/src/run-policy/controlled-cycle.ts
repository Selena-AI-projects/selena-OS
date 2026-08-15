export interface ControlledCycleState {
	activeMaintenanceJobs: number;
	activeCohortJobs: number;
	cohortId: string;
	expectedJobs: number;
	expectedProviderCalls: number;
	seenCohortIds: ReadonlySet<string>;
	globalEmergencyStop?: boolean;
	orderStopped?: boolean;
	audit?: (event: { type: "GLOBAL_EMERGENCY_STOP" | "ORDER_STOPPED"; cohortId: string }) => void;
}

export function isMaintenanceEnabled(value: string | undefined): boolean {
	return value !== "false";
}

export function assertDirectDispatchAllowed(state: ControlledCycleState): void {
	assertTransportAllowed(state);
	if (state.activeMaintenanceJobs > 0) {
		throw new Error("Direct dispatch blocked: maintenance jobs are active");
	}
	if (state.activeCohortJobs > 0 || state.seenCohortIds.has(state.cohortId)) {
		throw new Error(`Direct dispatch blocked: cohort ${state.cohortId} already exists`);
	}
}

/**
 * This guard is deliberately transport-adjacent: callers must pass it before
 * creating a provider request, so an emergency stop cannot merely stop queue
 * creation while an already planned request still escapes to a provider.
 */
export function assertTransportAllowed(state: ControlledCycleState): void {
	if (state.globalEmergencyStop) {
		state.audit?.({ type: "GLOBAL_EMERGENCY_STOP", cohortId: state.cohortId });
		throw new Error("SELENA_GLOBAL_EMERGENCY_STOP");
	}
	if (state.orderStopped) {
		state.audit?.({ type: "ORDER_STOPPED", cohortId: state.cohortId });
		throw new Error("SELENA_ORDER_STOPPED");
	}
}

export function cardinalityExceeded(
	actualJobs: number,
	actualProviderCalls: number,
	state: Pick<ControlledCycleState, "expectedJobs" | "expectedProviderCalls">,
): boolean {
	return actualJobs > state.expectedJobs || actualProviderCalls > state.expectedProviderCalls;
}

export interface ControlledCycleState {
	activeMaintenanceJobs: number;
	activeCohortJobs: number;
	cohortId: string;
	expectedJobs: number;
	expectedProviderCalls: number;
	seenCohortIds: ReadonlySet<string>;
}

export function isMaintenanceEnabled(value: string | undefined): boolean {
	return value !== "false";
}

export function assertDirectDispatchAllowed(state: ControlledCycleState): void {
	if (state.activeMaintenanceJobs > 0) {
		throw new Error("Direct dispatch blocked: maintenance jobs are active");
	}
	if (state.activeCohortJobs > 0 || state.seenCohortIds.has(state.cohortId)) {
		throw new Error(`Direct dispatch blocked: cohort ${state.cohortId} already exists`);
	}
}

export function cardinalityExceeded(
	actualJobs: number,
	actualProviderCalls: number,
	state: Pick<ControlledCycleState, "expectedJobs" | "expectedProviderCalls">,
): boolean {
	return actualJobs > state.expectedJobs || actualProviderCalls > state.expectedProviderCalls;
}

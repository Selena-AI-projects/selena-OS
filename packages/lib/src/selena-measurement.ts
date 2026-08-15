import { assertDirectDispatchAllowed, type ControlledCycleState, cardinalityExceeded } from "@workspace/lib/run-policy";

export type SelenaMeasurementChannel = "visitor_view" | "api_view";
export type SelenaMeasurementPermit = {
	cycleId: string;
	organizationId: string;
	scenarioId: string;
	channel: SelenaMeasurementChannel;
	dispatchKey: string;
};
export type SelenaMeasurementAdapter = {
	readonly channel: SelenaMeasurementChannel;
	measure(permit: SelenaMeasurementPermit): Promise<{ dispatchKey: string; status: "queued" }>;
};
export function planSelenaMeasurement(permits: SelenaMeasurementPermit[]): SelenaMeasurementPermit[] {
	const seen = new Set<string>();
	return permits.filter((permit) => {
		if (seen.has(permit.dispatchKey)) return false;
		seen.add(permit.dispatchKey);
		return permit.dispatchKey.length > 0;
	});
}
export function prepareSelenaDispatch(
	state: ControlledCycleState,
	permits: SelenaMeasurementPermit[],
): SelenaMeasurementPermit[] {
	assertDirectDispatchAllowed(state);
	const planned = planSelenaMeasurement(permits);
	if (cardinalityExceeded(planned.length, planned.length, state)) throw new Error("SELENA_CARDINALITY_BLOCKED");
	return planned;
}
export function createNoopMeasurementAdapter(channel: SelenaMeasurementChannel): SelenaMeasurementAdapter {
	return {
		channel,
		async measure(permit) {
			// The real adapter supplies the same state guard before provider
			// transport; the noop adapter keeps the contract testable without calls.
			if (permit.channel !== channel) throw new Error("MEASUREMENT_CHANNEL_MISMATCH");
			return { dispatchKey: permit.dispatchKey, status: "queued" };
		},
	};
}

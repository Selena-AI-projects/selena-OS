// RC7 boundary: Google Ask Maps is a manual-observation-only surface. This
// module is the single policy gate for local AI discovery — the backend must
// never execute, scrape, or resolve an Ask Maps / Places request, so no
// function here (or anywhere else) is allowed to perform an external call.
export const LOCAL_AI_DISCOVERY_POLICY = Object.freeze({
	surface: "GOOGLE_ASK_MAPS",
	surfaceFamily: "LOCAL_AI_DISCOVERY",
	status: "MANUAL_ONLY",
	captureMethod: "MANUAL_OBSERVATION",
	backendExternalCallsAllowed: false,
	automatedExecutionAllowed: false,
	scrapingAllowed: false,
	placesApiAllowed: false,
	policyVersion: "local-ai-discovery-v1",
} as const);

export type LocalDiscoveryConfig = {
	enabled: boolean;
	manualPilotEnabled: boolean;
	clientResultsEnabled: boolean;
};

export function localDiscoveryConfigFromEnv(env: Record<string, string | undefined>): LocalDiscoveryConfig {
	return {
		enabled: env.LOCAL_AI_DISCOVERY_ENABLED === "true",
		manualPilotEnabled: env.ASK_MAPS_MANUAL_PILOT_ENABLED === "true",
		clientResultsEnabled: env.LOCAL_AI_DISCOVERY_CLIENT_RESULTS_ENABLED === "true",
	};
}

export function assertLocalDiscoveryEnabled(config: LocalDiscoveryConfig): void {
	if (!config.enabled) throw new Error("LOCAL_AI_DISCOVERY_DISABLED");
}

export function assertManualPilotAllowed(config: LocalDiscoveryConfig): void {
	assertLocalDiscoveryEnabled(config);
	if (!config.manualPilotEnabled) throw new Error("ASK_MAPS_MANUAL_PILOT_DISABLED");
}

export function assertClientResultsAllowed(config: LocalDiscoveryConfig): void {
	assertManualPilotAllowed(config);
	if (!config.clientResultsEnabled) throw new Error("LOCAL_AI_DISCOVERY_CLIENT_RESULTS_DISABLED");
}

export function assertCaptureMethodAllowed(method: string): void {
	if (method !== LOCAL_AI_DISCOVERY_POLICY.captureMethod) throw new Error("AUTOMATION_BLOCKED");
}

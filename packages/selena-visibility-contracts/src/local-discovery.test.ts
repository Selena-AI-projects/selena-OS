import { describe, expect, it } from "vitest";
import {
	LOCAL_AI_DISCOVERY_POLICY,
	assertCaptureMethodAllowed,
	assertClientResultsAllowed,
	assertLocalDiscoveryEnabled,
	assertManualPilotAllowed,
	localDiscoveryConfigFromEnv,
} from "./local-discovery";

describe("Selena local AI discovery boundary", () => {
	it("defaults every flag to off", () => {
		const config = localDiscoveryConfigFromEnv({});
		expect(config).toEqual({ enabled: false, manualPilotEnabled: false, clientResultsEnabled: false });
		expect(() => assertLocalDiscoveryEnabled(config)).toThrow("LOCAL_AI_DISCOVERY_DISABLED");
		expect(() => assertManualPilotAllowed(config)).toThrow("LOCAL_AI_DISCOVERY_DISABLED");
		expect(() => assertClientResultsAllowed(config)).toThrow("LOCAL_AI_DISCOVERY_DISABLED");
	});

	it("gates the manual pilot behind both flags", () => {
		const pilotOnly = localDiscoveryConfigFromEnv({ ASK_MAPS_MANUAL_PILOT_ENABLED: "true" });
		expect(() => assertManualPilotAllowed(pilotOnly)).toThrow("LOCAL_AI_DISCOVERY_DISABLED");
		const discoveryOnly = localDiscoveryConfigFromEnv({ LOCAL_AI_DISCOVERY_ENABLED: "true" });
		expect(() => assertManualPilotAllowed(discoveryOnly)).toThrow("ASK_MAPS_MANUAL_PILOT_DISABLED");
		const both = localDiscoveryConfigFromEnv({
			LOCAL_AI_DISCOVERY_ENABLED: "true",
			ASK_MAPS_MANUAL_PILOT_ENABLED: "true",
		});
		expect(() => assertManualPilotAllowed(both)).not.toThrow();
	});

	it("gates client-facing results behind all three flags", () => {
		const pilot = localDiscoveryConfigFromEnv({
			LOCAL_AI_DISCOVERY_ENABLED: "true",
			ASK_MAPS_MANUAL_PILOT_ENABLED: "true",
		});
		expect(() => assertClientResultsAllowed(pilot)).toThrow("LOCAL_AI_DISCOVERY_CLIENT_RESULTS_DISABLED");
		const full = localDiscoveryConfigFromEnv({
			LOCAL_AI_DISCOVERY_ENABLED: "true",
			ASK_MAPS_MANUAL_PILOT_ENABLED: "true",
			LOCAL_AI_DISCOVERY_CLIENT_RESULTS_ENABLED: "true",
		});
		expect(() => assertClientResultsAllowed(full)).not.toThrow();
		const skipPilot = localDiscoveryConfigFromEnv({
			LOCAL_AI_DISCOVERY_ENABLED: "true",
			LOCAL_AI_DISCOVERY_CLIENT_RESULTS_ENABLED: "true",
		});
		expect(() => assertClientResultsAllowed(skipPilot)).toThrow("ASK_MAPS_MANUAL_PILOT_DISABLED");
	});

	it("blocks every non-manual capture method deterministically", () => {
		for (const method of ["AUTOMATED", "SCRAPING", "API", "", "manual_observation"]) {
			expect(() => assertCaptureMethodAllowed(method)).toThrow("AUTOMATION_BLOCKED");
		}
		expect(() => assertCaptureMethodAllowed("MANUAL_OBSERVATION")).not.toThrow();
	});

	it("keeps the policy entry frozen", () => {
		expect(Object.isFrozen(LOCAL_AI_DISCOVERY_POLICY)).toBe(true);
		expect(() => {
			(LOCAL_AI_DISCOVERY_POLICY as Record<string, unknown>).automatedExecutionAllowed = true;
		}).toThrow(TypeError);
		expect(LOCAL_AI_DISCOVERY_POLICY.automatedExecutionAllowed).toBe(false);
		expect(LOCAL_AI_DISCOVERY_POLICY.captureMethod).toBe("MANUAL_OBSERVATION");
		expect(LOCAL_AI_DISCOVERY_POLICY.policyVersion).toBe("local-ai-discovery-v1");
	});
});

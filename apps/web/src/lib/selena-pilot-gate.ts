import { assertManualPilotAllowed, localDiscoveryConfigFromEnv } from "@workspace/selena-visibility-contracts";

// The RC7 pilot flags default off and the feature is unreleased. There is no
// shared feature-off convention in this API (the payments 503 gate is a
// kill-switch on an already-public surface), so a disabled pilot answers a
// plain 404 — checked before authentication so the routes do not reveal that
// the feature exists.
export function pilotDisabledResponse(): Response | null {
	try {
		assertManualPilotAllowed(localDiscoveryConfigFromEnv(process.env));
		return null;
	} catch {
		return Response.json({ error: "Not Found" }, { status: 404 });
	}
}

export function pilotErrorResponse(error: unknown): Response {
	const message = error instanceof Error ? error.message : "Request failed";
	// Auth errors keep the typed 401/403 mapping of createSelenaApiHandler.
	if (message.startsWith("Unauthorized") || message.startsWith("Forbidden")) throw error;
	if (message.startsWith("Not found")) return Response.json({ error: "Not Found", message }, { status: 404 });
	if (message.includes("OBSERVATION_CARDINALITY_BLOCKED"))
		return Response.json({ error: "Conflict", message }, { status: 409 });
	return Response.json({ error: "Validation Error", message }, { status: 400 });
}

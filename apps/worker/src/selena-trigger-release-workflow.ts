import type { OpaqueWorkflowPayload } from "@workspace/lib/selena-control-room";

export type ReleaseWorkflowCheckpoint =
	| { state: "CANCELLED" }
	| { state: "WAITING_APPROVAL" }
	| { state: "WAITING_SCHEDULE"; scheduledFor: string }
	| { state: "RECONCILIATION_REQUIRED" }
	| { manifestId: string; state: "READY" };

export type ReleaseSubmissionOutcome = "ACCEPTED" | "RECONCILIATION_REQUIRED" | "SKIPPED";

/**
 * This narrow boundary is implemented by the Release Gateway client. A
 * Trigger task never receives a Postiz token or reads the private database.
 */
export type ReleaseWorkflowBoundary = {
	checkpoint(releaseIntentId: string): Promise<ReleaseWorkflowCheckpoint>;
	refreshManifest(releaseIntentId: string): Promise<{ manifestId: string }>;
	submitManifest(input: {
		idempotencyKey: string;
		manifestId: string;
		releaseIntentId: string;
	}): Promise<ReleaseSubmissionOutcome>;
};

/** Trigger.dev's task primitives are injected by the SDK wrapper, keeping the business workflow independently testable. */
export type TriggerDurablePrimitives = {
	runOnce<T>(key: string, operation: () => Promise<T>): Promise<T>;
	waitForApproval(key: string): Promise<void>;
	waitUntil(key: string, timestamp: string): Promise<void>;
};

export type ReleaseWorkflowResult = "CANCELLED" | "COMPLETED" | "RECONCILIATION_REQUIRED";

function workflowKey(payload: OpaqueWorkflowPayload, phase: string): string {
	return `selena:${phase}:${payload.releaseIntentId}:${payload.correlationId}`;
}

function assertFutureSchedule(value: string): void {
	if (Number.isNaN(new Date(value).getTime()))
		throw new Error("Release workflow received an invalid schedule timestamp");
}

/**
 * Durable workflow state machine. Every time it resumes after a wait, it
 * reloads canonical state through the Gateway boundary before any submission.
 */
export async function runSelenaReleaseWorkflow(input: {
	boundary: ReleaseWorkflowBoundary;
	durable: TriggerDurablePrimitives;
	payload: OpaqueWorkflowPayload;
}): Promise<ReleaseWorkflowResult> {
	const { boundary, durable, payload } = input;
	let checkpoint = await boundary.checkpoint(payload.releaseIntentId);

	if (checkpoint.state === "CANCELLED") return "CANCELLED";
	if (checkpoint.state === "RECONCILIATION_REQUIRED") return "RECONCILIATION_REQUIRED";
	if (checkpoint.state === "WAITING_APPROVAL") {
		await durable.waitForApproval(workflowKey(payload, "approval"));
		checkpoint = await boundary.checkpoint(payload.releaseIntentId);
		if (checkpoint.state === "CANCELLED") return "CANCELLED";
		if (checkpoint.state === "RECONCILIATION_REQUIRED") return "RECONCILIATION_REQUIRED";
	}
	if (checkpoint.state === "WAITING_SCHEDULE") {
		assertFutureSchedule(checkpoint.scheduledFor);
		await durable.waitUntil(workflowKey(payload, "schedule"), checkpoint.scheduledFor);
		checkpoint = await boundary.checkpoint(payload.releaseIntentId);
		if (checkpoint.state === "CANCELLED") return "CANCELLED";
		if (checkpoint.state === "RECONCILIATION_REQUIRED") return "RECONCILIATION_REQUIRED";
	}

	const manifest =
		checkpoint.state === "READY"
			? { manifestId: checkpoint.manifestId }
			: await boundary.refreshManifest(payload.releaseIntentId);
	const beforeSubmit = await boundary.checkpoint(payload.releaseIntentId);
	if (beforeSubmit.state === "CANCELLED") return "CANCELLED";
	if (beforeSubmit.state === "RECONCILIATION_REQUIRED") return "RECONCILIATION_REQUIRED";
	if (beforeSubmit.state !== "READY" || beforeSubmit.manifestId !== manifest.manifestId) {
		return "RECONCILIATION_REQUIRED";
	}

	const outcome = await durable.runOnce(workflowKey(payload, `submit:${manifest.manifestId}`), () =>
		boundary.submitManifest({
			idempotencyKey: workflowKey(payload, "submission"),
			manifestId: manifest.manifestId,
			releaseIntentId: payload.releaseIntentId,
		}),
	);
	return outcome === "ACCEPTED" ? "COMPLETED" : "RECONCILIATION_REQUIRED";
}

import { type DispatchablePermit, selectEnqueueablePermits } from "@workspace/lib/selena-dispatch";
import type { SelenaMeasurementConfig } from "@workspace/selena-visibility-contracts";

// Deciding what to enqueue is kept apart from the queue client: this module
// holds the gate and the selection, and the transport arrives as a callback.
// Nothing here executes a measurement — the worker owns that.

export type SelenaMeasureJobPayload = {
	permitId: string;
	organizationId: string;
	actorId: string;
};

/**
 * Sends one job. Returns the job id, or null when the queue deduplicated it
 * against a job that is already waiting for the same key.
 */
export type SelenaMeasureSender = (
	payload: SelenaMeasureJobPayload,
	options: { singletonKey: string },
) => Promise<string | null>;

export type EnqueueOrderRunsResult = {
	enqueued: number;
	/** Permits left alone because they are consumed or expired. */
	skipped: number;
	/** Eligible permits the queue already held a job for. */
	duplicates: number;
	reason: "SELENA_MEASUREMENT_DISABLED" | null;
};

export async function enqueueOrderRuns(input: {
	permits: readonly DispatchablePermit[];
	config: SelenaMeasurementConfig;
	organizationId: string;
	actorId: string;
	now: Date;
	send: SelenaMeasureSender;
}): Promise<EnqueueOrderRunsResult> {
	// With execution off the worker drops every job it receives, so queueing
	// them would tell the operator a run started when none can. The flag is
	// answered before anything is sent, and the reason travels back to the UI.
	if (!input.config.enabled)
		return { enqueued: 0, skipped: input.permits.length, duplicates: 0, reason: "SELENA_MEASUREMENT_DISABLED" };
	const enqueueable = selectEnqueueablePermits(input.permits, input.now);
	let enqueued = 0;
	for (const permit of enqueueable) {
		// The dispatch key is the unit of authorized work, so it is also the
		// dedupe key: a second click cannot queue the same permit twice.
		const jobId = await input.send(
			{ permitId: permit.id, organizationId: input.organizationId, actorId: input.actorId },
			{ singletonKey: permit.dispatchKey },
		);
		if (jobId) enqueued += 1;
	}
	return {
		enqueued,
		skipped: input.permits.length - enqueueable.length,
		duplicates: enqueueable.length - enqueued,
		reason: null,
	};
}

import { describe, expect, it, vi } from "vitest";
import {
	type ReleaseWorkflowBoundary,
	runSelenaReleaseWorkflow,
	type TriggerDurablePrimitives,
} from "./selena-trigger-release-workflow";

const payload = {
	correlationId: "75000000-0000-0000-0000-000000000001",
	eventType: "release.intent_queued" as const,
	eventVersion: 1 as const,
	releaseIntentId: "75000000-0000-0000-0000-000000000002",
};

function durable(): TriggerDurablePrimitives {
	return {
		runOnce: vi.fn(async (_key, operation) => operation()),
		waitForApproval: vi.fn(async () => undefined),
		waitUntil: vi.fn(async () => undefined),
	};
}

describe("Selena Trigger durable release workflow", () => {
	it("re-checks cancellation after approval wait and never submits", async () => {
		const primitives = durable();
		const boundary: ReleaseWorkflowBoundary = {
			checkpoint: vi
				.fn()
				.mockResolvedValueOnce({ state: "WAITING_APPROVAL" })
				.mockResolvedValueOnce({ state: "CANCELLED" }),
			refreshManifest: vi.fn(),
			submitManifest: vi.fn(),
		};
		await expect(runSelenaReleaseWorkflow({ boundary, durable: primitives, payload })).resolves.toBe("CANCELLED");
		expect(primitives.waitForApproval).toHaveBeenCalledOnce();
		expect(boundary.submitManifest).not.toHaveBeenCalled();
	});

	it("waits for schedule, re-checks the manifest, and submits exactly once", async () => {
		const primitives = durable();
		const boundary: ReleaseWorkflowBoundary = {
			checkpoint: vi
				.fn()
				.mockResolvedValueOnce({ state: "WAITING_SCHEDULE", scheduledFor: "2030-01-01T12:00:00.000Z" })
				.mockResolvedValueOnce({ state: "READY", manifestId: "manifest-1" })
				.mockResolvedValueOnce({ state: "READY", manifestId: "manifest-1" }),
			refreshManifest: vi.fn(),
			submitManifest: vi.fn().mockResolvedValue("ACCEPTED"),
		};
		await expect(runSelenaReleaseWorkflow({ boundary, durable: primitives, payload })).resolves.toBe("COMPLETED");
		expect(primitives.waitUntil).toHaveBeenCalledOnce();
		expect(primitives.runOnce).toHaveBeenCalledOnce();
		expect(boundary.submitManifest).toHaveBeenCalledOnce();
	});

	it("returns reconciliation required for an ambiguous adapter result without a second submission", async () => {
		const primitives = durable();
		const boundary: ReleaseWorkflowBoundary = {
			checkpoint: vi.fn().mockResolvedValue({ state: "READY", manifestId: "manifest-2" }),
			refreshManifest: vi.fn(),
			submitManifest: vi.fn().mockResolvedValue("RECONCILIATION_REQUIRED"),
		};
		await expect(runSelenaReleaseWorkflow({ boundary, durable: primitives, payload })).resolves.toBe(
			"RECONCILIATION_REQUIRED",
		);
		expect(boundary.submitManifest).toHaveBeenCalledTimes(1);
	});
});

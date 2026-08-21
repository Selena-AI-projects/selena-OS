import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunOutcome } from "@workspace/selena-visibility-contracts";
import { describe, expect, it, vi } from "vitest";
import type { ControlledCycleState } from "./run-policy";
import {
	type MeasurementAdapter,
	type MeasurementRunStore,
	executePermit,
	runMeasurementForPermit,
} from "./selena-run-executor";
import { type SelenaExecutablePermit, createNoopMeasurementAdapter } from "./selena-measurement";

const now = new Date("2026-08-19T10:00:00.000Z");

function permitFor(overrides: Partial<SelenaExecutablePermit> = {}): SelenaExecutablePermit {
	return {
		id: "permit-1",
		organizationId: "org-1",
		cycleId: "cycle-1",
		scenarioId: "scenario-1",
		systemId: null,
		channel: "API",
		dispatchKey: "order-1:scenario-1:system-1:0:1",
		expiresAt: new Date("2026-08-19T11:00:00.000Z"),
		consumedAt: null,
		...overrides,
	};
}

function cycleStateFor(overrides: Partial<ControlledCycleState> = {}): ControlledCycleState {
	return {
		activeMaintenanceJobs: 0,
		activeCohortJobs: 0,
		cohortId: "cycle-1",
		expectedJobs: 1,
		expectedProviderCalls: 1,
		seenCohortIds: new Set<string>(),
		globalEmergencyStop: false,
		orderStopped: false,
		...overrides,
	};
}

/** Records whether the provider seam was reached at all. */
function spyAdapter(outcome?: RunOutcome) {
	const execute = vi.fn(async (permit: SelenaExecutablePermit): Promise<RunOutcome> => {
		return (
			outcome ?? {
				dispatchKey: permit.dispatchKey,
				status: "SUCCEEDED",
				validity: "VALID",
			}
		);
	});
	const adapter: MeasurementAdapter = { ...createNoopMeasurementAdapter(), execute };
	return { adapter, execute };
}

describe("Selena permit execution", () => {
	const enabled = { enabled: true, adapter: "noop" };

	it("refuses to reach an adapter while measurement is disabled", async () => {
		const { adapter, execute } = spyAdapter();
		await expect(
			executePermit({
				permit: permitFor(),
				adapter,
				cycleState: cycleStateFor(),
				config: { enabled: false, adapter: "noop" },
				now,
			}),
		).rejects.toThrow("SELENA_MEASUREMENT_DISABLED");
		expect(execute).not.toHaveBeenCalled();
	});

	it("refuses to reach an adapter while a stop is in force", async () => {
		for (const [state, message] of [
			[{ globalEmergencyStop: true }, "SELENA_GLOBAL_EMERGENCY_STOP"],
			[{ orderStopped: true }, "SELENA_ORDER_STOPPED"],
		] as const) {
			const { adapter, execute } = spyAdapter();
			await expect(
				executePermit({ permit: permitFor(), adapter, cycleState: cycleStateFor(state), config: enabled, now }),
			).rejects.toThrow(message);
			expect(execute).not.toHaveBeenCalled();
		}
	});

	it("refuses an expired or already consumed permit", async () => {
		const { adapter, execute } = spyAdapter();
		await expect(
			executePermit({
				permit: permitFor({ expiresAt: new Date(now.getTime() - 1) }),
				adapter,
				cycleState: cycleStateFor(),
				config: enabled,
				now,
			}),
		).rejects.toThrow("SELENA_PERMIT_EXPIRED");
		await expect(
			executePermit({
				permit: permitFor({ consumedAt: new Date(now.getTime() - 1000) }),
				adapter,
				cycleState: cycleStateFor(),
				config: enabled,
				now,
			}),
		).rejects.toThrow("SELENA_PERMIT_ALREADY_CONSUMED");
		expect(execute).not.toHaveBeenCalled();
	});

	it("runs the noop adapter without producing valid evidence", async () => {
		const permit = permitFor();
		const outcome = await executePermit({
			permit,
			adapter: createNoopMeasurementAdapter(),
			cycleState: cycleStateFor(),
			config: enabled,
			now,
		});
		expect(outcome).toEqual({
			dispatchKey: permit.dispatchKey,
			status: "INVALID",
			validity: "INVALID",
			invalidReason: "NOOP_ADAPTER_NO_PROVIDER_CALL",
		});
	});

	it("rejects an outcome that answers for a different permit", async () => {
		const { adapter } = spyAdapter({ dispatchKey: "someone-elses-key", status: "SUCCEEDED", validity: "VALID" });
		await expect(
			executePermit({ permit: permitFor(), adapter, cycleState: cycleStateFor(), config: enabled, now }),
		).rejects.toThrow("SELENA_DISPATCH_KEY_MISMATCH");
	});

	it("drops a measurement attributed to a system the permit did not authorize, keeping the run", async () => {
		const measurement = {
			system: "gemini",
			language: "en",
			mention: true,
			position: null,
			ownedCitation: false,
			citations: [],
			competitors: [],
			factualErrors: [],
		};
		const { adapter } = spyAdapter({
			dispatchKey: "order-1:scenario-1:system-1:0:1",
			status: "SUCCEEDED",
			validity: "VALID",
			measurement,
		});
		const mismatched = await executePermit({
			permit: permitFor({ systemId: "chatgpt" }),
			adapter,
			cycleState: cycleStateFor(),
			config: enabled,
			now,
		});
		expect(mismatched.status).toBe("SUCCEEDED");
		expect(mismatched.measurement).toBeUndefined();

		const matched = await executePermit({
			permit: permitFor({ systemId: "gemini" }),
			adapter,
			cycleState: cycleStateFor(),
			config: enabled,
			now,
		});
		expect(matched.measurement).toEqual(measurement);

		// A pre-P0-07 permit carries no systemId and cannot assert attribution.
		const legacy = await executePermit({
			permit: permitFor({ systemId: null }),
			adapter,
			cycleState: cycleStateFor(),
			config: enabled,
			now,
		});
		expect(legacy.measurement).toEqual(measurement);
	});

	it("rejects an outcome that does not satisfy the run outcome contract", async () => {
		const { adapter } = spyAdapter({ dispatchKey: "order-1:scenario-1:system-1:0:1", status: "FAILED" } as RunOutcome);
		await expect(
			executePermit({ permit: permitFor(), adapter, cycleState: cycleStateFor(), config: enabled, now }),
		).rejects.toThrow();
	});
});

describe("Selena measurement runner", () => {
	type Ctx = { tenantId: string };
	const ctx: Ctx = { tenantId: "org-1" };

	function storeFor(permit = permitFor()) {
		const claim = vi.fn(async () => ({
			permit,
			run: { id: "run-1" },
			cycle: { id: "cycle-1", status: "RUNNING" },
		}));
		const complete = vi.fn(async () => ({ id: "run-1" }));
		return { store: { claim, complete } satisfies MeasurementRunStore<Ctx>, claim, complete };
	}

	it("touches neither storage nor an adapter while the flag is unset", async () => {
		const { store, claim, complete } = storeFor();
		const { adapter, execute } = spyAdapter();
		for (const env of [{}, { SELENA_MEASUREMENT_ENABLED: "false" }]) {
			const config = { enabled: env.SELENA_MEASUREMENT_ENABLED === "true", adapter: "noop" };
			expect(
				await runMeasurementForPermit({ permitId: "permit-1", ctx, store, adapters: { noop: adapter }, config, now }),
			).toEqual({ status: "skipped", reason: "SELENA_MEASUREMENT_DISABLED" });
		}
		expect(claim).not.toHaveBeenCalled();
		expect(complete).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
	});

	it("refuses a live adapter name even when one is registered", async () => {
		const { store, claim } = storeFor();
		const { adapter } = spyAdapter();
		await expect(
			runMeasurementForPermit({
				permitId: "permit-1",
				ctx,
				store,
				adapters: { noop: adapter, brightdata: adapter },
				config: { enabled: true, adapter: "brightdata" },
				now,
			}),
		).rejects.toThrow("SELENA_LIVE_ADAPTER_REQUIRES_OWNER_GO");
		expect(claim).not.toHaveBeenCalled();
	});

	it("claims, executes and records the outcome", async () => {
		const { store, complete } = storeFor();
		const { adapter } = spyAdapter();
		const result = await runMeasurementForPermit({
			permitId: "permit-1",
			ctx,
			store,
			adapters: { noop: adapter },
			config: { enabled: true, adapter: "noop" },
			now,
		});
		expect(result).toMatchObject({ status: "completed", runId: "run-1" });
		expect(complete).toHaveBeenCalledWith(ctx, "run-1", expect.objectContaining({ status: "SUCCEEDED" }), { now });
	});

	it("records a blocked run as failed instead of retrying a spent permit", async () => {
		const { store, complete } = storeFor(permitFor({ consumedAt: new Date(now.getTime() - 1000) }));
		const { adapter, execute } = spyAdapter();
		const result = await runMeasurementForPermit({
			permitId: "permit-1",
			ctx,
			store,
			adapters: { noop: adapter },
			config: { enabled: true, adapter: "noop" },
			now,
		});
		expect(result).toEqual({ status: "failed", runId: "run-1", reason: "SELENA_PERMIT_ALREADY_CONSUMED" });
		expect(execute).not.toHaveBeenCalled();
		expect(complete).toHaveBeenCalledWith(
			ctx,
			"run-1",
			expect.objectContaining({ status: "FAILED", validity: "INVALID" }),
			{ now },
		);
	});

	it("stops a claimed run when its cycle is stopped", async () => {
		const { store, claim } = storeFor();
		claim.mockResolvedValueOnce({
			permit: permitFor(),
			run: { id: "run-1" },
			cycle: { id: "cycle-1", status: "STOPPED" },
		});
		const { adapter, execute } = spyAdapter();
		const result = await runMeasurementForPermit({
			permitId: "permit-1",
			ctx,
			store,
			adapters: { noop: adapter },
			config: { enabled: true, adapter: "noop" },
			now,
		});
		expect(result).toMatchObject({ status: "failed", reason: "SELENA_ORDER_STOPPED" });
		expect(execute).not.toHaveBeenCalled();
	});
});

describe("zero provider surface invariant", () => {
	const here = dirname(fileURLToPath(import.meta.url));
	// The executor decides whether an injected adapter may run; it must be
	// structurally unable to reach a queue, a scheduler, or the network itself.
	const forbidden = ["fetch(", "boss", "job-scheduler", "http://", "https://"];

	it("keeps selena-run-executor.ts free of provider-execution code", () => {
		const text = readFileSync(resolve(here, "selena-run-executor.ts"), "utf8");
		for (const marker of forbidden) {
			expect(text.includes(marker), `selena-run-executor.ts must not contain "${marker}"`).toBe(false);
		}
	});
});

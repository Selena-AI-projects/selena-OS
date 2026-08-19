import type { DispatchablePermit } from "@workspace/lib/selena-dispatch";
import { describe, expect, it, vi } from "vitest";
import { enqueueOrderRuns, type SelenaMeasureSender } from "@/lib/selena-run-enqueue";

const now = new Date("2026-02-01T12:00:00.000Z");

const permit = (overrides: Partial<DispatchablePermit> & { id: string }): DispatchablePermit => ({
	dispatchKey: `key-${overrides.id}`,
	consumedAt: null,
	expiresAt: new Date(now.getTime() + 60_000),
	...overrides,
});

const run = (permits: DispatchablePermit[], enabled: boolean, send: SelenaMeasureSender) =>
	enqueueOrderRuns({
		permits,
		config: { enabled, adapter: "noop" },
		organizationId: "org_1",
		actorId: "user_1",
		now,
		send,
	});

describe("enqueueOrderRuns", () => {
	it("queues nothing at all while measurement execution is disabled", async () => {
		const send = vi.fn<SelenaMeasureSender>(async () => "job");
		const result = await run([permit({ id: "a" }), permit({ id: "b" })], false, send);
		expect(send).not.toHaveBeenCalled();
		expect(result).toEqual({ enqueued: 0, skipped: 2, duplicates: 0, reason: "SELENA_MEASUREMENT_DISABLED" });
	});

	it("sends one job per unspent permit, keyed by its dispatch key", async () => {
		const send = vi.fn<SelenaMeasureSender>(async () => "job");
		const result = await run([permit({ id: "a" }), permit({ id: "b" })], true, send);
		expect(result).toEqual({ enqueued: 2, skipped: 0, duplicates: 0, reason: null });
		expect(send.mock.calls.map(([payload, options]) => ({ ...payload, key: options.singletonKey }))).toEqual([
			{ permitId: "a", organizationId: "org_1", actorId: "user_1", key: "key-a" },
			{ permitId: "b", organizationId: "org_1", actorId: "user_1", key: "key-b" },
		]);
	});

	it("skips consumed and expired permits instead of queueing work the executor refuses", async () => {
		const send = vi.fn<SelenaMeasureSender>(async () => "job");
		const result = await run(
			[
				permit({ id: "fresh" }),
				permit({ id: "consumed", consumedAt: new Date(now.getTime() - 1000) }),
				permit({ id: "expired", expiresAt: new Date(now.getTime() - 1) }),
			],
			true,
			send,
		);
		expect(result).toEqual({ enqueued: 1, skipped: 2, duplicates: 0, reason: null });
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0]?.[0].permitId).toBe("fresh");
	});

	it("reports a permit the queue already holds as a duplicate rather than an enqueue", async () => {
		const send = vi.fn<SelenaMeasureSender>(async (payload) => (payload.permitId === "a" ? "job" : null));
		const result = await run([permit({ id: "a" }), permit({ id: "b" })], true, send);
		expect(result).toEqual({ enqueued: 1, skipped: 0, duplicates: 1, reason: null });
	});
});

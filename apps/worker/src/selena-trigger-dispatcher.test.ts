import { describe, expect, it, vi } from "vitest";
import { createTriggerDevClient } from "./selena-trigger-dispatcher";

describe("Selena Trigger workflow transport", () => {
	it("sends opaque identifiers with a global outbox idempotency key and one-per-brand queue", async () => {
		const fetchFn = vi
			.fn<typeof fetch>()
			.mockResolvedValue(new Response(JSON.stringify({ id: "run_selena_1" }), { status: 200 }));
		const client = createTriggerDevClient(
			{ apiUrl: "https://api.trigger.dev", secretKey: "trigger-test-key", taskId: "selena-release-workflow" },
			fetchFn,
		);
		await expect(
			client.trigger({
				concurrencyKey: "brand:selena",
				idempotencyKey: "outbox-key",
				payload: {
					correlationId: "10000000-0000-0000-0000-000000000001",
					eventType: "release.intent_queued",
					eventVersion: 1,
					releaseIntentId: "20000000-0000-0000-0000-000000000001",
				},
			}),
		).resolves.toBe("run_selena_1");
		const [, options] = fetchFn.mock.calls[0] ?? [];
		expect(String(options?.body)).toContain('"idempotencyKey":"outbox-key"');
		expect(String(options?.body)).toContain('"concurrencyLimit":1');
		expect(String(options?.body)).not.toContain("postiz");
	});

	it("rejects an unsuccessful Trigger response without exposing the secret", async () => {
		const client = createTriggerDevClient(
			{ apiUrl: "https://api.trigger.dev", secretKey: "trigger-test-key", taskId: "selena-release-workflow" },
			vi.fn<typeof fetch>().mockResolvedValue(new Response("denied", { status: 401 })),
		);
		await expect(
			client.trigger({
				concurrencyKey: "brand:selena",
				idempotencyKey: "outbox-key",
				payload: {
					correlationId: "10000000-0000-0000-0000-000000000001",
					eventType: "release.intent_queued",
					eventVersion: 1,
					releaseIntentId: "20000000-0000-0000-0000-000000000001",
				},
			}),
		).rejects.toThrow("status 401");
	});
});

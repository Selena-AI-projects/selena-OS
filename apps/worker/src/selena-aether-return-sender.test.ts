/**
 * The Aether return sender, driven by a fake pool and fake fetch — no database,
 * no network. It proves the drain loop (claim → send → mark), that a delivery
 * failure is retried rather than lost, and that the signature the sender writes
 * is the one the shared verifier accepts.
 */
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, canonicalJson, verifySignature } from "@workspace/lib/selena-aether-bridge";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import {
	type ClaimedOutcome,
	buildOutcomeEvent,
	createReturnSenderClient,
	requiredReturnConfig,
	sendOneOutcome,
} from "./selena-aether-return-sender";

function anOutcome(overrides: Partial<ClaimedOutcome> = {}): ClaimedOutcome {
	return {
		id: "row-1",
		eventId: "11111111-1111-1111-1111-111111111111",
		outcome: "PUBLISHED",
		aetherProjectId: "22222222-2222-2222-2222-222222222222",
		aggregateId: "33333333-3333-3333-3333-333333333333",
		taskId: "44444444-4444-4444-4444-444444444444",
		contentKind: "ARTICLE",
		materialVersion: 1,
		reference: "https://x.example/post/1",
		detail: null,
		traceId: "55555555-5555-5555-5555-555555555555",
		occurredAt: "2026-09-01T00:00:00.000Z",
		leaseOwner: "lease-1",
	};
}

type QueryCall = { text: string; params: unknown[] };

function fakePool(options: { claimRow: Record<string, unknown> | null }) {
	const calls: QueryCall[] = [];
	const client = {
		async query(text: string, params: unknown[] = []) {
			calls.push({ text, params });
			if (text.includes("claim_next_aether_outcome")) {
				return { rows: options.claimRow ? [options.claimRow] : [] };
			}
			return { rows: [] };
		},
		release() {},
	};
	const pool = {
		connect: async () => client as unknown as PoolClient,
		end: async () => undefined,
	};
	return { pool, calls };
}

function claimRowFor(outcome: ClaimedOutcome) {
	return {
		id: outcome.id,
		event_id: outcome.eventId,
		outcome: outcome.outcome,
		aether_project_id: outcome.aetherProjectId,
		aggregate_id: outcome.aggregateId,
		task_id: outcome.taskId,
		content_kind: outcome.contentKind,
		material_version: outcome.materialVersion,
		reference: outcome.reference,
		detail: outcome.detail,
		trace_id: outcome.traceId,
		occurred_at: new Date(outcome.occurredAt),
		lease_owner: outcome.leaseOwner,
	};
}

describe("Aether return sender config", () => {
	it("is absent when neither variable is set, and demands both together", () => {
		expect(requiredReturnConfig({} as NodeJS.ProcessEnv)).toBeNull();
		expect(() => requiredReturnConfig({ AETHER_RETURN_URL: "https://a/x" } as NodeJS.ProcessEnv)).toThrow();
		expect(() => requiredReturnConfig({ AETHER_RETURN_SECRET: "s" } as NodeJS.ProcessEnv)).toThrow();
		expect(() =>
			requiredReturnConfig({ AETHER_RETURN_URL: "http://a/x", AETHER_RETURN_SECRET: "s" } as NodeJS.ProcessEnv),
		).toThrow();
		expect(
			requiredReturnConfig({ AETHER_RETURN_URL: "https://a/x/", AETHER_RETURN_SECRET: "s" } as NodeJS.ProcessEnv),
		).toEqual({ url: "https://a/x", secret: "s" });
	});
});

describe("Aether return sender signing", () => {
	it("signs the exact body it sends, and that signature verifies with the shared secret", async () => {
		let seen: { url: string; headers: Record<string, string>; body: string } | null = null;
		const fetchFn = (async (url: string, init: RequestInit) => {
			seen = { url, headers: init.headers as Record<string, string>, body: init.body as string };
			return { ok: true, status: 200 } as Response;
		}) as unknown as typeof fetch;

		const client = createReturnSenderClient({ url: "https://aether.example/v1/bridge/outcome", secret: "shhh" }, fetchFn);
		const outcome = anOutcome();
		await client.send(outcome);

		expect(seen).not.toBeNull();
		const sent = seen as NonNullable<typeof seen>;
		expect(sent.url).toBe("https://aether.example/v1/bridge/outcome");
		expect(sent.body).toBe(canonicalJson(buildOutcomeEvent(outcome)));
		// The receiver recomputes over the same bytes; the right secret accepts, a wrong one rejects.
		expect(() =>
			verifySignature(sent.body, sent.headers[TIMESTAMP_HEADER], sent.headers[SIGNATURE_HEADER], ["shhh"]),
		).not.toThrow();
		expect(() =>
			verifySignature(sent.body, sent.headers[TIMESTAMP_HEADER], sent.headers[SIGNATURE_HEADER], ["wrong"]),
		).toThrow();
	});

	it("refuses a non-2xx response", async () => {
		const fetchFn = (async () => ({ ok: false, status: 503 }) as Response) as unknown as typeof fetch;
		const client = createReturnSenderClient({ url: "https://a/x", secret: "s" }, fetchFn);
		await expect(client.send(anOutcome())).rejects.toThrow("status 503");
	});
});

describe("Aether return sender drain", () => {
	it("claims, sends, and marks delivered", async () => {
		const outcome = anOutcome();
		const { pool, calls } = fakePool({ claimRow: claimRowFor(outcome) });
		let sent = 0;
		const client = { send: async () => void sent++ };
		const result = await sendOneOutcome(pool as never, client);
		expect(result).toBe("SENT");
		expect(sent).toBe(1);
		const delivered = calls.find((c) => c.text.includes("record_aether_outcome_delivered"));
		expect(delivered?.params).toEqual([outcome.id, outcome.leaseOwner]);
		expect(calls.some((c) => c.text.includes("retry_or_dead_letter_aether_outcome"))).toBe(false);
	});

	it("retries when delivery fails, and never marks delivered", async () => {
		const outcome = anOutcome();
		const { pool, calls } = fakePool({ claimRow: claimRowFor(outcome) });
		const client = {
			send: async () => {
				throw new Error("boom");
			},
		};
		const result = await sendOneOutcome(pool as never, client);
		expect(result).toBe("RETRIED");
		const retried = calls.find((c) => c.text.includes("retry_or_dead_letter_aether_outcome"));
		expect(retried?.params?.[0]).toBe(outcome.id);
		expect(retried?.params?.[1]).toBe(outcome.leaseOwner);
		expect(calls.some((c) => c.text.includes("record_aether_outcome_delivered"))).toBe(false);
	});

	it("is idle when the outbox is empty", async () => {
		const { pool } = fakePool({ claimRow: null });
		const client = { send: async () => undefined };
		expect(await sendOneOutcome(pool as never, client)).toBe("IDLE");
	});
});

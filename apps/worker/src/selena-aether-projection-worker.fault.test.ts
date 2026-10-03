/**
 * The projection worker's fault path, driven by a fake client so no database is
 * needed. An unexpected throw after an event is claimed must not propagate: that
 * is the poison event, re-claimed every tick, that blocks every newer event
 * behind it. It must become a backed-off deferral instead. A throw before a
 * claim, or a deferral that cannot itself be written, is rethrown so the loop
 * backs off and nothing is lost.
 */
import { randomUUID } from "node:crypto";
import fixtures from "@workspace/lib/contracts/control-room-event.v1.1.fixtures.json" with { type: "json" };
import { acceptEvent } from "@workspace/lib/selena-aether-bridge";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { type WorkerPool, projectOnce } from "./selena-aether-projection-worker";

const DEFERRED_UNTIL = new Date("2031-01-01T00:00:00.000Z");

function acceptedArticle() {
	const entry = fixtures.cases.find((c) => c.name === "accepted_article");
	if (!entry) throw new Error("fixture accepted_article missing");
	return acceptEvent(
		entry.body,
		{ signature: entry.signature, timestamp: entry.timestamp },
		[fixtures.secret],
		new Date(Date.parse(entry.timestamp)),
	).envelope;
}

/** The row `claim_next_aether_draft_event()` returns for one accepted draft. */
function claimRow() {
	const e = acceptedArticle();
	return {
		event_row_id: randomUUID(),
		event_id: e.event_id,
		schema_version: e.schema_version,
		source_project_id: e.project_id,
		aggregate_id: e.aggregate_id,
		version: e.version,
		occurred_at: new Date(e.occurred_at),
		trace_id: e.trace_id,
		payload: e.payload,
		payload_sha256: e.payload_hash,
	};
}

type QueryCall = { text: string; params: unknown[] };

/**
 * A pool whose single client answers the worker's own queries and throws on the
 * one named step, so a fault can be injected at a chosen point in the cycle.
 */
function fakePool(options: { row: Record<string, unknown>; faultOn: string; deferFails?: boolean }): {
	pool: WorkerPool;
	calls: QueryCall[];
} {
	const calls: QueryCall[] = [];
	const client = {
		async query(text: string, params: unknown[] = []) {
			calls.push({ text, params });
			if (text.includes(options.faultOn)) throw new Error("simulated DB fault");
			if (text.includes("claim_next_aether_draft_event")) return { rows: [options.row] };
			if (text.includes("defer_aether_event_projection")) {
				if (options.deferFails) throw new Error("database is unreachable");
				return { rows: [{ next: DEFERRED_UNTIL }] };
			}
			return { rows: [] };
		},
		release() {},
	};
	const pool: WorkerPool = {
		connect: async () => client as unknown as PoolClient,
		end: async () => undefined,
	};
	return { pool, calls };
}

describe("projection worker fault path", () => {
	it("turns an unexpected fault after a claim into a backed-off deferral", async () => {
		const row = claimRow();
		const { pool, calls } = fakePool({ row, faultOn: "resolve_growth_binding" });
		const outcome = await projectOnce(pool, "local");
		expect(outcome).toEqual({ kind: "faulted", eventId: row.event_id, nextAttemptAt: DEFERRED_UNTIL });
		const defer = calls.find((c) => c.text.includes("defer_aether_event_projection"));
		expect(defer?.params).toEqual([row.event_row_id, "PROJECTION_FAULT"]);
	});

	it("rethrows a fault that happens before an event is claimed", async () => {
		const row = claimRow();
		const { pool, calls } = fakePool({ row, faultOn: "claim_next_aether_draft_event" });
		await expect(projectOnce(pool, "local")).rejects.toThrow("simulated DB fault");
		expect(calls.some((c) => c.text.includes("defer_aether_event_projection"))).toBe(false);
	});

	it("rethrows the original fault when the deferral cannot be recorded", async () => {
		const row = claimRow();
		const { pool } = fakePool({ row, faultOn: "resolve_growth_binding", deferFails: true });
		await expect(projectOnce(pool, "local")).rejects.toThrow("simulated DB fault");
	});
});

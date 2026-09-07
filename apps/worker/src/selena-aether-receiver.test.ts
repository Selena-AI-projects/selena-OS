/**
 * The receiver driven over a real socket with the sender's own fixture bytes.
 *
 * The database is stood in for, because what is under test here is the HTTP
 * boundary: which requests reach the recording function at all, and what a
 * refused one is told. The recording function's own behaviour — duplicate,
 * stale, a reused id — is asserted against a real Postgres in
 * `packages/lib/src/db/tests/0035_aether_bridge_inbox.pgtap.sql`.
 */
import type { AddressInfo } from "node:net";
import fixturesV11 from "@workspace/lib/contracts/control-room-event.v1.1.fixtures.json" with { type: "json" };
import fixtures from "@workspace/lib/contracts/control-room-event.v1.fixtures.json" with { type: "json" };
import { MAX_EVENT_BODY_BYTES, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "@workspace/lib/selena-aether-bridge";
import type { PoolClient } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createReceiverServer,
	type ReceiverCredential,
	type RecordOutcome,
	receiverSecrets,
	testCredential,
} from "./selena-aether-receiver";

const SECRETS = [fixtures.secret];
const ACCEPTED = fixtures.cases.find((entry) => entry.name === "accepted");
if (!ACCEPTED) throw new Error("the accepted fixture is missing");

/**
 * The fixtures are signed at a fixed moment, and the receiver refuses anything
 * outside a five-minute window, so the clock is moved to that moment rather
 * than the fixtures being re-signed with a live key.
 */
function atSigningTime(): void {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(Date.parse(ACCEPTED.timestamp)));
}

afterEach(() => {
	vi.useRealTimers();
});

type ClientBehaviour = { outcome?: RecordOutcome; failOn?: string; sqlstate?: string };

function fakePool(behaviour: ClientBehaviour = { outcome: "recorded" }) {
	const statements: string[] = [];
	const client = {
		query: async (text: string) => {
			statements.push(text);
			if (behaviour.failOn && text.includes(behaviour.failOn)) throw new Error("database said no");
			if (behaviour.sqlstate && text.includes("record_aether_event")) {
				throw Object.assign(new Error("conflict"), { code: behaviour.sqlstate });
			}
			if (text.includes("record_aether_event")) return { rows: [{ outcome: behaviour.outcome }] };
			return { rows: [] };
		},
		release: () => {},
	} as unknown as PoolClient;
	return {
		statements,
		pool: { connect: async () => client, end: async () => {} },
	};
}

async function withReceiver<T>(
	behaviour: ClientBehaviour,
	task: (base: string, statements: string[]) => Promise<T>,
): Promise<T> {
	const { pool, statements } = fakePool(behaviour);
	const server = createReceiverServer({ credentials: [{ label: "live", secrets: SECRETS }], pool });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	try {
		return await task(`http://127.0.0.1:${port}`, statements);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

async function withReceiverSecrets<T>(
	secrets: string[],
	behaviour: ClientBehaviour,
	task: (base: string, statements: string[]) => Promise<T>,
): Promise<T> {
	return withCredentials([{ label: "live", secrets }], behaviour, task);
}

async function withCredentials<T>(
	credentials: ReceiverCredential[],
	behaviour: ClientBehaviour,
	task: (base: string, statements: string[]) => Promise<T>,
): Promise<T> {
	const { pool, statements } = fakePool(behaviour);
	const server = createReceiverServer({ credentials, pool });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	try {
		return await task(`http://127.0.0.1:${port}`, statements);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

function post(
	base: string,
	fixture: { body: string; signature: string; timestamp: string },
	path = "/v1/bridge/aether",
) {
	return fetch(`${base}${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			[SIGNATURE_HEADER]: fixture.signature,
			[TIMESTAMP_HEADER]: fixture.timestamp,
		},
		body: fixture.body,
	});
}

const caseNamed = (name: string) => {
	const found = fixtures.cases.find((entry) => entry.name === name);
	if (!found) throw new Error(`fixture ${name} is missing`);
	return found;
};

describe("what the receiver accepts", () => {
	it("records an event the sender signed and reports the outcome", async () => {
		atSigningTime();
		await withReceiver({ outcome: "recorded" }, async (base, statements) => {
			const response = await post(base, ACCEPTED);
			expect(response.status).toBe(202);
			await expect(response.json()).resolves.toMatchObject({ outcome: "recorded" });
			// The runtime identity the recording function checks is set on the
			// same connection, inside the same transaction.
			expect(statements.some((text) => text.includes("app.selena_service_identity"))).toBe(true);
			expect(statements.some((text) => text.includes("record_aether_event"))).toBe(true);
			expect(statements).toContain("COMMIT");
		});
	});

	it.each(["duplicate", "stale"] as const)(
		"acknowledges a %s delivery instead of asking for a retry",
		async (outcome) => {
			atSigningTime();
			await withReceiver({ outcome }, async (base) => {
				const response = await post(base, ACCEPTED);
				expect(response.status).toBe(202);
				await expect(response.json()).resolves.toMatchObject({ outcome });
			});
		},
	);

	it("answers a health check without touching the database", async () => {
		await withReceiver({ outcome: "recorded" }, async (base, statements) => {
			const response = await fetch(`${base}/healthz`);
			expect(response.status).toBe(200);
			expect(statements).toHaveLength(0);
		});
	});
});

describe("what the receiver refuses", () => {
	it("refuses an event signed with another secret and never reaches the database", async () => {
		atSigningTime();
		await withReceiver({ outcome: "recorded" }, async (base, statements) => {
			const response = await post(base, caseNamed("signed_with_another_secret"));
			expect(response.status).toBe(401);
			await expect(response.json()).resolves.toMatchObject({ reason: "signature" });
			expect(statements).toHaveLength(0);
		});
	});

	it("refuses a body that was changed after signing", async () => {
		atSigningTime();
		await withReceiver({ outcome: "recorded" }, async (base, statements) => {
			const response = await post(base, caseNamed("payload_tampered_in_transit"));
			expect(response.status).toBe(401);
			expect(statements).toHaveLength(0);
		});
	});

	it("refuses an event signed a day earlier", async () => {
		atSigningTime();
		await withReceiver({ outcome: "recorded" }, async (base) => {
			const response = await post(base, caseNamed("timestamp_outside_window"));
			expect(response.status).toBe(401);
			await expect(response.json()).resolves.toMatchObject({ reason: "timestamp" });
		});
	});

	it("refuses an envelope version it does not know", async () => {
		atSigningTime();
		await withReceiver({ outcome: "recorded" }, async (base, statements) => {
			const response = await post(base, caseNamed("unknown_schema_version"));
			expect(response.status).toBe(400);
			await expect(response.json()).resolves.toMatchObject({ reason: "schema_version" });
			expect(statements).toHaveLength(0);
		});
	});

	it("refuses an unsigned request", async () => {
		atSigningTime();
		await withReceiver({ outcome: "recorded" }, async (base) => {
			const response = await fetch(`${base}/v1/bridge/aether`, { method: "POST", body: ACCEPTED.body });
			expect(response.status).toBe(401);
		});
	});

	it("serves nothing but the receive path", async () => {
		await withReceiver({ outcome: "recorded" }, async (base) => {
			expect((await post(base, ACCEPTED, "/")).status).toBe(404);
			expect((await fetch(`${base}/v1/bridge/aether`)).status).toBe(405);
		});
	});
});

describe("when the database refuses", () => {
	it("asks the sender to retry without repeating what the database said", async () => {
		atSigningTime();
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		await withReceiver({ outcome: "recorded", failOn: "record_aether_event" }, async (base, statements) => {
			const response = await post(base, ACCEPTED);
			expect(response.status).toBe(500);
			const body = await response.text();
			expect(body).not.toContain("database said no");
			expect(statements).toContain("ROLLBACK");
		});
		errors.mockRestore();
	});
});

describe("the shared secret", () => {
	it("is read as a rotation list and refuses to be empty", () => {
		expect(receiverSecrets(" new , old ")).toEqual(["new", "old"]);
		expect(() => receiverSecrets("  ")).toThrow(/empty/);
	});
});

describe("what the receiver records about itself", () => {
	it("logs the verdict and the identifiers, and never the payload", async () => {
		atSigningTime();
		const lines: string[] = [];
		const log = vi.spyOn(console, "log").mockImplementation((line) => {
			lines.push(String(line));
		});
		await withReceiver({ outcome: "duplicate" }, async (base) => {
			await post(base, ACCEPTED);
		});
		log.mockRestore();

		const envelope = JSON.parse(ACCEPTED.body);
		expect(lines.join("\n")).toContain("duplicate");
		expect(lines.join("\n")).toContain(envelope.event_id);
		expect(lines.join("\n")).toContain(`version=${envelope.version}`);
		// An operator reading the log must not thereby read the event's contents.
		expect(lines.join("\n")).not.toContain(envelope.payload.title);
		expect(lines.join("\n")).not.toContain(envelope.payload.summary);
	});
});

describe("contract version 1.1 over the wire", () => {
	const DRAFT = fixturesV11.cases.find((entry) => entry.name === "accepted_article");
	if (!DRAFT) throw new Error("the accepted_article fixture is missing");

	function atDraftSigningTime(): void {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(Date.parse(DRAFT.timestamp)));
	}

	it("records a material event and reports the outcome", async () => {
		atDraftSigningTime();
		await withReceiverSecrets([fixturesV11.secret], { outcome: "recorded" }, async (base, statements) => {
			const response = await fetch(`${base}/v1/bridge/aether`, {
				method: "POST",
				headers: { [SIGNATURE_HEADER]: DRAFT.signature, [TIMESTAMP_HEADER]: DRAFT.timestamp },
				body: DRAFT.body,
			});
			expect(response.status).toBe(202);
			expect(await response.json()).toEqual({ outcome: "recorded", event_id: JSON.parse(DRAFT.body).event_id });
			expect(statements.some((statement) => statement.includes("record_aether_event"))).toBe(true);
		});
	});

	it("answers 409 when the database reports a content conflict and does not ask for a retry", async () => {
		atDraftSigningTime();
		await withReceiverSecrets([fixturesV11.secret], { sqlstate: "SE409" }, async (base) => {
			const response = await fetch(`${base}/v1/bridge/aether`, {
				method: "POST",
				headers: { [SIGNATURE_HEADER]: DRAFT.signature, [TIMESTAMP_HEADER]: DRAFT.timestamp },
				body: DRAFT.body,
			});
			expect(response.status).toBe(409);
			const body = (await response.json()) as { error: string; reason: string };
			expect(body).toMatchObject({ error: "rejected", reason: "conflict" });
		});
	});

	it("refuses a body beyond the contract's byte limit with 413 before reading it all", async () => {
		atDraftSigningTime();
		await withReceiverSecrets([fixturesV11.secret], { outcome: "recorded" }, async (base, statements) => {
			const response = await fetch(`${base}/v1/bridge/aether`, {
				method: "POST",
				headers: { [SIGNATURE_HEADER]: DRAFT.signature, [TIMESTAMP_HEADER]: DRAFT.timestamp },
				body: "x".repeat(MAX_EVENT_BODY_BYTES + 1),
			});
			expect(response.status).toBe(413);
			expect(statements).toHaveLength(0);
		});
	});

	it("accepts a body one byte under the limit as far as the signature check", async () => {
		atDraftSigningTime();
		await withReceiverSecrets([fixturesV11.secret], { outcome: "recorded" }, async (base) => {
			const response = await fetch(`${base}/v1/bridge/aether`, {
				method: "POST",
				headers: { [SIGNATURE_HEADER]: DRAFT.signature, [TIMESTAMP_HEADER]: DRAFT.timestamp },
				body: "x".repeat(MAX_EVENT_BODY_BYTES - 1),
			});
			// Read in full, then refused for what it is: an unsigned body, not a large one.
			expect(response.status).toBe(401);
		});
	});
	it("accepts a test credential only for the projects it is allowed to speak for", async () => {
		atDraftSigningTime();
		const project = JSON.parse(DRAFT.body).project_id as string;
		const live: ReceiverCredential = { label: "live", secrets: ["a-different-live-secret"] };
		const test = testCredential(fixturesV11.secret, project);
		if (!test) throw new Error("the test credential should exist");
		await withCredentials([live, test], { outcome: "recorded" }, async (base, statements) => {
			const response = await post(base, DRAFT);
			expect(response.status).toBe(202);
			expect(statements.length).toBeGreaterThan(0);
		});
	});

	it("refuses a test credential for a project it may not speak for", async () => {
		atDraftSigningTime();
		const live: ReceiverCredential = { label: "live", secrets: ["a-different-live-secret"] };
		const test = testCredential(fixturesV11.secret, "11111111-2222-4333-8444-555555555555");
		if (!test) throw new Error("the test credential should exist");
		await withCredentials([live, test], { outcome: "recorded" }, async (base, statements) => {
			const response = await post(base, DRAFT);
			// Signed by a key the receiver holds, for a project that key cannot deliver for.
			expect(response.status).toBe(401);
			expect(statements).toHaveLength(0);
		});
	});

	it("does not let the live credential be narrowed by the test allowlist", async () => {
		atDraftSigningTime();
		const live: ReceiverCredential = { label: "live", secrets: [fixturesV11.secret] };
		const test = testCredential("an-unused-test-secret", "11111111-2222-4333-8444-555555555555");
		if (!test) throw new Error("the test credential should exist");
		await withCredentials([live, test], { outcome: "recorded" }, async (base) => {
			const response = await post(base, DRAFT);
			expect(response.status).toBe(202);
		});
	});

	it("refuses to configure a test credential without an allowlist", () => {
		expect(() => testCredential("a-secret", "")).toThrow(/SELENA_AETHER_BRIDGE_TEST_PROJECTS/);
		expect(() => testCredential("a-secret", "   ,  ")).toThrow(/SELENA_AETHER_BRIDGE_TEST_PROJECTS/);
	});

	it("has no test credential when none is configured", () => {
		expect(testCredential(undefined, "some-project")).toBeNull();
		expect(testCredential("   ", "some-project")).toBeNull();
	});
});

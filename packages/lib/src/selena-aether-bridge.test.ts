/**
 * The receiver checked against bytes the sender actually produced.
 *
 * `src/contracts/control-room-event.v1.fixtures.json` is generated on the Aether
 * side and copied here unchanged. Testing against it rather than against locally
 * built objects is the point: canonical JSON, non-ASCII escaping and HMAC input
 * are exactly where two implementations in two languages drift apart silently.
 */
import { describe, expect, it } from "vitest";
import fixtures from "./contracts/control-room-event.v1.fixtures.json" with { type: "json" };
import {
	acceptEvent,
	canonicalJson,
	type EventPayload,
	EventRejected,
	isStale,
	parseEnvelope,
	payloadHash,
	SIGNATURE_HEADER,
	TIMESTAMP_HEADER,
	TIMESTAMP_TOLERANCE_MS,
	verifySignature,
	verifyTimestamp,
} from "./selena-aether-bridge";

const SECRETS = [fixtures.secret];
const caseNamed = (name: string) => {
	const found = fixtures.cases.find((entry) => entry.name === name);
	if (!found) throw new Error(`fixture ${name} is missing`);
	return found;
};

/** The moment the fixtures were signed, so the window is exercised, not skipped. */
const signedAt = (fixture: { timestamp: string }) => new Date(Date.parse(fixture.timestamp));

describe("the sender and the receiver agree on the wire format", () => {
	it("accepts an event the sender produced", () => {
		const fixture = caseNamed("accepted");
		const { envelope } = acceptEvent(
			fixture.body,
			{ signature: fixture.signature, timestamp: fixture.timestamp },
			SECRETS,
			signedAt(fixture),
		);
		expect(envelope.event_type).toBe("task.result.ready");
		const payload = envelope.payload as EventPayload;
		expect(payload.status).toBe("pending_approval");
		expect(payload.title).toContain("«Other Bali»");
	});

	it("reproduces the sender's canonical serialization byte for byte", () => {
		const fixture = caseNamed("accepted");
		expect(canonicalJson(JSON.parse(fixture.body))).toBe(fixture.body);
	});

	it("recomputes the sender's payload hash", () => {
		const fixture = caseNamed("accepted");
		const envelope = JSON.parse(fixture.body);
		expect(payloadHash(envelope.payload)).toBe(envelope.payload_hash);
	});

	it("names the headers the sender sends", () => {
		expect(SIGNATURE_HEADER).toBe(fixtures.signature_header.toLowerCase());
		expect(TIMESTAMP_HEADER).toBe(fixtures.timestamp_header.toLowerCase());
		expect(TIMESTAMP_TOLERANCE_MS).toBe(fixtures.timestamp_tolerance_seconds * 1000);
	});
});

describe("every way an event can be wrong", () => {
	it.each([
		["payload_tampered_in_transit", "signature"],
		["payload_hash_disagrees_with_payload", "payload_hash"],
		["signed_with_another_secret", "signature"],
		["timestamp_outside_window", "timestamp"],
		["unknown_schema_version", "schema_version"],
	])("refuses %s for the stated reason", (name, reason) => {
		const fixture = caseNamed(name);
		// Every case is judged at the moment the accepted event was signed, so a
		// rejection is caused by the fixture and not by the test having aged.
		const now = signedAt(caseNamed("accepted"));
		try {
			acceptEvent(fixture.body, { signature: fixture.signature, timestamp: fixture.timestamp }, SECRETS, now);
			throw new Error(`${name} was accepted`);
		} catch (error) {
			expect(error).toBeInstanceOf(EventRejected);
			expect((error as EventRejected).reason).toBe(reason);
		}
	});

	it("refuses a missing signature rather than treating it as unsigned", () => {
		const fixture = caseNamed("accepted");
		expect(() => verifySignature(fixture.body, fixture.timestamp, undefined, SECRETS)).toThrow(EventRejected);
		expect(() => verifySignature(fixture.body, fixture.timestamp, "", SECRETS)).toThrow(EventRejected);
	});

	it("refuses a timestamp with no time zone", () => {
		expect(() => verifyTimestamp("2026-09-03T00:00:00", new Date("2026-09-03T00:00:00Z"))).toThrow(/time zone/);
	});

	it("refuses a body that is not an object", () => {
		for (const body of ["[]", '"text"', "17", "not json"]) {
			expect(() => parseEnvelope(body)).toThrow(EventRejected);
		}
	});

	it("refuses a status Aether does not report", () => {
		const envelope = JSON.parse(caseNamed("accepted").body);
		envelope.payload.status = "running";
		envelope.payload_hash = payloadHash(envelope.payload);
		expect(() => parseEnvelope(canonicalJson(envelope))).toThrow(/status/);
	});

	it("refuses an identifier that is not a uuid", () => {
		const envelope = JSON.parse(caseNamed("accepted").body);
		envelope.aggregate_id = "task-42";
		expect(() => parseEnvelope(canonicalJson(envelope))).toThrow(/uuid/);
	});

	it("never puts the secret in the reason it gives", () => {
		const fixture = caseNamed("signed_with_another_secret");
		try {
			acceptEvent(
				fixture.body,
				{ signature: fixture.signature, timestamp: fixture.timestamp },
				SECRETS,
				signedAt(fixture),
			);
		} catch (error) {
			expect((error as Error).message).not.toContain(fixtures.secret);
		}
	});
});

describe("rotation and ordering", () => {
	it("accepts an event signed with any live secret", () => {
		const fixture = caseNamed("accepted");
		expect(() =>
			verifySignature(fixture.body, fixture.timestamp, fixture.signature, ["the-new-one", fixtures.secret]),
		).not.toThrow();
	});

	it("applies a newer version and drops one that arrived late", () => {
		const newer = caseNamed("newer_version_of_the_same_aggregate");
		const replayed = caseNamed("replayed_older_version");
		expect(isStale(JSON.parse(newer.body), newer.last_applied_version ?? null)).toBe(newer.stale);
		expect(isStale(JSON.parse(replayed.body), replayed.last_applied_version ?? null)).toBe(replayed.stale);
	});

	it("treats the first event about an aggregate as applicable", () => {
		expect(isStale(JSON.parse(caseNamed("accepted").body), null)).toBe(false);
	});
});

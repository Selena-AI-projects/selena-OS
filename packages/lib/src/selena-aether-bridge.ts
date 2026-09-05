/**
 * Receiver side of the Aether → Control Room event contract.
 *
 * The sender is a separate service in another language. The two agree on bytes,
 * not on a description of the format, so everything here is written against the
 * canonical serialization the sender actually transmits: keys sorted, no spaces,
 * non-ASCII left as-is. `src/contracts/control-room-event.v1.fixtures.json` holds
 * bodies produced by the sender, and the tests run this code against them — a
 * divergence shows up there rather than in production.
 *
 * What each check is for:
 *
 * - the signature proves the event came from Aether, not from someone who
 *   learned the receiver's address;
 * - the timestamp is signed together with the body, so a captured event cannot
 *   be replayed later and the window cannot be moved without breaking the
 *   signature;
 * - the payload hash is recomputed here: the signature proves the sender, the
 *   hash proves the payload is the one that was signed;
 * - the event id is the idempotency key, so a redelivery does not create a
 *   second inbox item;
 * - the aggregate version makes delivery order irrelevant — an event no newer
 *   than what has been applied is dropped rather than applied backwards.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SCHEMA_VERSION = "1";
export const EVENT_TASK_RESULT_READY = "task.result.ready";
export const SIGNATURE_HEADER = "x-selena-signature";
export const TIMESTAMP_HEADER = "x-selena-timestamp";
export const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

const REPORTABLE_STATUSES = new Set(["pending_approval", "approved", "rejected", "done"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Why an event was refused. The reason names the check, never the secret. */
export type RejectionReason =
	| "body"
	| "schema_version"
	| "event_type"
	| "fields"
	| "payload"
	| "payload_hash"
	| "signature"
	| "timestamp";

export class EventRejected extends Error {
	constructor(
		readonly reason: RejectionReason,
		message: string,
	) {
		super(message);
		this.name = "EventRejected";
	}
}

export interface EventPayload {
	title: string;
	status: string;
	summary: string;
	artifact_count?: number;
}

export interface EventEnvelope {
	schema_version: string;
	event_id: string;
	event_type: string;
	project_id: string;
	aggregate_id: string;
	version: number;
	occurred_at: string;
	trace_id: string;
	payload: EventPayload;
	payload_hash: string;
}

/**
 * The one serialization both sides use for hashing and signing.
 *
 * JSON.stringify preserves insertion order and escapes nothing above ASCII,
 * which matches the sender once the keys are sorted. Nested objects are sorted
 * too, because the payload is hashed the same way.
 */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export function payloadHash(payload: unknown): string {
	return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

function sign(body: string, timestamp: string, secret: string): string {
	return createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
}

/**
 * Accepts any of the currently valid secrets so the shared key can be rotated
 * without a window in which events are refused.
 */
export function verifySignature(
	body: string,
	timestamp: string,
	signature: string | undefined,
	secrets: string[],
): void {
	if (!signature) throw new EventRejected("signature", "signature header is missing");
	const provided = Buffer.from(signature, "utf8");
	let matched = false;
	for (const secret of secrets) {
		if (!secret) continue;
		const expected = Buffer.from(sign(body, timestamp, secret), "utf8");
		// Every candidate is compared, and in constant time, so neither the
		// number of live secrets nor which one matched is observable from timing.
		if (expected.length === provided.length && timingSafeEqual(expected, provided)) matched = true;
	}
	if (!matched) throw new EventRejected("signature", "signature does not match");
}

export function verifyTimestamp(timestamp: string | undefined, now: Date = new Date()): void {
	if (!timestamp) throw new EventRejected("timestamp", "timestamp header is missing");
	const sentAt = Date.parse(timestamp);
	if (Number.isNaN(sentAt)) throw new EventRejected("timestamp", "timestamp is not a date");
	// A timestamp without a zone is ambiguous by exactly the offset of whoever
	// reads it, which is the difference between inside and outside the window.
	if (!/(Z|[+-]\d{2}:?\d{2})$/.test(timestamp)) {
		throw new EventRejected("timestamp", "timestamp has no time zone");
	}
	if (Math.abs(now.getTime() - sentAt) > TIMESTAMP_TOLERANCE_MS) {
		throw new EventRejected("timestamp", "timestamp is outside the accepted window");
	}
}

function requireUuid(envelope: Record<string, unknown>, field: string): void {
	const value = envelope[field];
	if (typeof value !== "string" || !UUID.test(value)) {
		throw new EventRejected("fields", `${field} is not a uuid`);
	}
}

export function parseEnvelope(body: string): EventEnvelope {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new EventRejected("body", "body is not json");
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new EventRejected("body", "body is not an object");
	}
	const envelope = parsed as Record<string, unknown>;

	// An unknown envelope version is refused rather than guessed at: a receiver
	// that infers the meaning of fields eventually infers it wrongly.
	if (envelope.schema_version !== SCHEMA_VERSION) {
		throw new EventRejected("schema_version", "unknown envelope schema version");
	}
	if (envelope.event_type !== EVENT_TASK_RESULT_READY) {
		throw new EventRejected("event_type", "unknown event type");
	}
	for (const field of ["event_id", "project_id", "aggregate_id", "trace_id"]) requireUuid(envelope, field);
	if (!Number.isInteger(envelope.version) || (envelope.version as number) < 1) {
		throw new EventRejected("fields", "aggregate version must be a positive integer");
	}
	if (typeof envelope.occurred_at !== "string" || Number.isNaN(Date.parse(envelope.occurred_at))) {
		throw new EventRejected("fields", "occurred_at is not a date");
	}

	const payload = envelope.payload;
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
		throw new EventRejected("payload", "payload is not an object");
	}
	const { title, status, summary, artifact_count: artifactCount } = payload as Record<string, unknown>;
	if (typeof title !== "string" || title.length === 0 || title.length > 200) {
		throw new EventRejected("payload", "payload title is missing or too long");
	}
	if (typeof status !== "string" || !REPORTABLE_STATUSES.has(status)) {
		throw new EventRejected("payload", "payload status is not one Aether reports");
	}
	if (typeof summary !== "string" || summary.length > 4000) {
		throw new EventRejected("payload", "payload summary is missing or too long");
	}
	if (artifactCount !== undefined && (!Number.isInteger(artifactCount) || (artifactCount as number) < 0)) {
		throw new EventRejected("payload", "artifact_count must be a non-negative integer");
	}

	if (typeof envelope.payload_hash !== "string" || payloadHash(payload) !== envelope.payload_hash) {
		throw new EventRejected("payload_hash", "payload_hash does not match the payload");
	}

	return envelope as unknown as EventEnvelope;
}

/**
 * An event no newer than what has already been applied is dropped. This is what
 * makes delivery order irrelevant: reordered events reach the same end state
 * because the older one is never applied on top of the newer one.
 */
export function isStale(envelope: EventEnvelope, lastAppliedVersion: number | null): boolean {
	if (lastAppliedVersion === null) return false;
	return envelope.version <= lastAppliedVersion;
}

export interface AcceptedEvent {
	envelope: EventEnvelope;
	body: string;
}

/**
 * The whole receiver-side check in the order that matters: authenticity first,
 * so a body from an unknown sender is never parsed or stored.
 */
export function acceptEvent(
	body: string,
	headers: { signature?: string; timestamp?: string },
	secrets: string[],
	now: Date = new Date(),
): AcceptedEvent {
	verifyTimestamp(headers.timestamp, now);
	verifySignature(body, headers.timestamp as string, headers.signature, secrets);
	return { envelope: parseEnvelope(body), body };
}

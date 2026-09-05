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
/**
 * Version 1.1 keeps the envelope and adds one event type, `content.draft_ready`,
 * whose payload is a whole material. A 1.1 receiver still accepts version 1.
 */
export const SCHEMA_VERSION_1_1 = "1.1";
export const SUPPORTED_SCHEMA_VERSIONS: ReadonlySet<string> = new Set([SCHEMA_VERSION, SCHEMA_VERSION_1_1]);
export const EVENT_TASK_RESULT_READY = "task.result.ready";
export const EVENT_CONTENT_DRAFT_READY = "content.draft_ready";
/**
 * Material aggregate ids are derived, not chosen: uuid5 of `<brief_ref>:<kind>`
 * in this namespace. The sender and the receiver both compute it, so a sender
 * cannot point a material at an aggregate that is not its own.
 */
export const GROWTH_MATERIAL_NAMESPACE = "2f7f0f5e-6b1a-5c3a-9c2e-1d4b7a8e9f01";
export const CONTENT_KINDS = ["ARTICLE", "SOCIAL_ADAPTATION", "BRIEF", "PAGE_UPDATE", "VIDEO_SCRIPT"] as const;
export const CLAIM_STATUSES = ["EXTRACTED", "INTERPRETED", "HYPOTHESIS", "UNKNOWN"] as const;
export const QA_CHECKS = ["FACTS", "LINKS", "NOVELTY", "BRAND", "TECHNICAL", "ISOLATION"] as const;
export const QA_VERDICTS = ["PASS", "FAIL", "UNKNOWN"] as const;
export const SOURCE_KINDS = ["OWN", "EXTERNAL", "SYNTHETIC_FIXTURE"] as const;
/** Inline body only, measured in UTF-8 bytes; artifact references are not part of 1.1. */
export const BODY_MARKDOWN_MAX_BYTES = 48_000;
export const CTA_URL_MAX_LENGTH = 2048;
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

export type ContentKind = (typeof CONTENT_KINDS)[number];
export type QaCheck = (typeof QA_CHECKS)[number];
export type QaVerdict = (typeof QA_VERDICTS)[number];

export interface ContentDraftPayload {
	content_kind: ContentKind;
	title: string;
	language: string;
	body_markdown: string;
	metadata: {
		cta_url: string;
		slug?: string;
		meta_title?: string;
		meta_description?: string;
		internal_links?: string[];
	};
	claims: Array<{ text: string; status: (typeof CLAIM_STATUSES)[number]; source_ref?: string }>;
	evidence: Array<{ kind: string; ref: string; captured_at: string }>;
	qa_results: Array<{ check: QaCheck; verdict: QaVerdict; detail?: string }>;
	source: { kind: (typeof SOURCE_KINDS)[number]; ref: string; rights: string };
	brief_ref: string;
	business_key: string;
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
	payload: EventPayload | ContentDraftPayload;
	payload_hash: string;
}

export function isContentDraftEvent(
	envelope: EventEnvelope,
): envelope is EventEnvelope & { payload: ContentDraftPayload } {
	return envelope.event_type === EVENT_CONTENT_DRAFT_READY;
}

/** RFC 4122 version 5 (SHA-1) uuid, the same construction Python's uuid5 uses. */
export function uuidV5(namespace: string, name: string): string {
	const nsBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
	const hash = createHash("sha1").update(nsBytes).update(Buffer.from(name, "utf8")).digest();
	hash[6] = (hash[6] & 0x0f) | 0x50;
	hash[8] = (hash[8] & 0x3f) | 0x80;
	const hex = hash.subarray(0, 16).toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function materialAggregateId(briefRef: string, contentKind: string): string {
	return uuidV5(GROWTH_MATERIAL_NAMESPACE, `${briefRef}:${contentKind}`);
}

const LANGUAGE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const BUSINESS_KEY = /^[a-z_]{2,32}$/;

function requireString(value: unknown, field: string, min: number, max: number): string {
	if (typeof value !== "string" || value.length < min || value.length > max) {
		throw new EventRejected("payload", `${field} must be a string of ${min}-${max} characters`);
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireKeys(value: Record<string, unknown>, field: string, allowed: string[], required: string[]): void {
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length > 0) throw new EventRejected("payload", `${field} has unknown fields: ${unknown.join(", ")}`);
	const missing = required.filter((key) => !(key in value));
	if (missing.length > 0) throw new EventRejected("payload", `${field} is missing fields: ${missing.join(", ")}`);
}

/**
 * The CTA is mandatory because `content_versions.cta_url` does not admit NULL,
 * and it is checked as a URL, not as a string: only absolute https, no
 * credentials, no fragment.
 */
export function validateCtaUrl(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || value.length > CTA_URL_MAX_LENGTH) {
		throw new EventRejected("payload", "metadata.cta_url is missing or too long");
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new EventRejected("payload", "metadata.cta_url is not a url");
	}
	if (url.protocol !== "https:" || !url.hostname) {
		throw new EventRejected("payload", "metadata.cta_url must be an absolute https url");
	}
	if (url.username || url.password) throw new EventRejected("payload", "metadata.cta_url must not carry credentials");
	if (url.hash) throw new EventRejected("payload", "metadata.cta_url must not carry a fragment");
	return value;
}

/**
 * The material payload check shared by every consumer of a 1.1 event. Limits are
 * the sender's limits: a payload the sender would refuse to sign is refused here.
 */
export function validateContentDraftPayload(payload: unknown): ContentDraftPayload {
	if (!isRecord(payload)) throw new EventRejected("payload", "payload is not an object");
	requireKeys(
		payload,
		"payload",
		[
			"content_kind",
			"title",
			"language",
			"body_markdown",
			"metadata",
			"claims",
			"evidence",
			"qa_results",
			"source",
			"brief_ref",
			"business_key",
		],
		[
			"content_kind",
			"title",
			"language",
			"body_markdown",
			"metadata",
			"claims",
			"evidence",
			"qa_results",
			"source",
			"brief_ref",
			"business_key",
		],
	);
	if (!(CONTENT_KINDS as readonly string[]).includes(payload.content_kind as string)) {
		throw new EventRejected("payload", "content_kind is unknown");
	}
	requireString(payload.title, "title", 1, 200);
	const language = requireString(payload.language, "language", 2, 16);
	if (!LANGUAGE.test(language)) throw new EventRejected("payload", "language is not a BCP-47 tag");

	const body = payload.body_markdown;
	if (typeof body !== "string" || body.length === 0) throw new EventRejected("payload", "body_markdown is empty");
	const bodyBytes = Buffer.byteLength(body, "utf8");
	if (bodyBytes > BODY_MARKDOWN_MAX_BYTES) {
		throw new EventRejected(
			"payload",
			`body_markdown is ${bodyBytes} bytes; at most ${BODY_MARKDOWN_MAX_BYTES} bytes are accepted and attachments are not part of this contract version`,
		);
	}

	const metadata = payload.metadata;
	if (!isRecord(metadata)) throw new EventRejected("payload", "metadata is not an object");
	requireKeys(
		metadata,
		"metadata",
		["cta_url", "slug", "meta_title", "meta_description", "internal_links"],
		["cta_url"],
	);
	validateCtaUrl(metadata.cta_url);
	for (const [field, limit] of [
		["slug", 200],
		["meta_title", 200],
		["meta_description", 500],
	] as const) {
		if (field in metadata) requireString(metadata[field], `metadata.${field}`, 0, limit);
	}
	const links = metadata.internal_links ?? [];
	if (!Array.isArray(links) || links.length > 20)
		throw new EventRejected("payload", "metadata.internal_links must hold at most 20 urls");
	for (const link of links) {
		if (typeof link !== "string" || !link.startsWith("https://") || link.length > CTA_URL_MAX_LENGTH) {
			throw new EventRejected("payload", "metadata.internal_links accepts only https urls");
		}
	}

	const claims = payload.claims;
	if (!Array.isArray(claims) || claims.length > 50)
		throw new EventRejected("payload", "claims must be a list of at most 50");
	for (const claim of claims) {
		if (!isRecord(claim)) throw new EventRejected("payload", "claims entries must be objects");
		requireKeys(claim, "claims", ["text", "status", "source_ref"], ["text", "status"]);
		requireString(claim.text, "claims.text", 1, 500);
		if (!(CLAIM_STATUSES as readonly string[]).includes(claim.status as string)) {
			throw new EventRejected("payload", "claims.status is unknown");
		}
		if ("source_ref" in claim) requireString(claim.source_ref, "claims.source_ref", 0, 500);
	}

	const evidence = payload.evidence;
	if (!Array.isArray(evidence) || evidence.length > 50)
		throw new EventRejected("payload", "evidence must be a list of at most 50");
	for (const item of evidence) {
		if (!isRecord(item)) throw new EventRejected("payload", "evidence entries must be objects");
		requireKeys(item, "evidence", ["kind", "ref", "captured_at"], ["kind", "ref", "captured_at"]);
		requireString(item.kind, "evidence.kind", 1, 50);
		requireString(item.ref, "evidence.ref", 1, 500);
		if (typeof item.captured_at !== "string" || Number.isNaN(Date.parse(item.captured_at))) {
			throw new EventRejected("payload", "evidence.captured_at is not a date");
		}
	}

	const qa = payload.qa_results;
	if (!Array.isArray(qa) || qa.length !== QA_CHECKS.length) {
		throw new EventRejected("payload", `qa_results must hold exactly ${QA_CHECKS.length} checks`);
	}
	const seen = new Set<string>();
	for (const result of qa) {
		if (!isRecord(result)) throw new EventRejected("payload", "qa_results entries must be objects");
		requireKeys(result, "qa_results", ["check", "verdict", "detail"], ["check", "verdict"]);
		const check = result.check as string;
		if (!(QA_CHECKS as readonly string[]).includes(check) || seen.has(check)) {
			throw new EventRejected("payload", "qa_results must name each check exactly once");
		}
		seen.add(check);
		if (!(QA_VERDICTS as readonly string[]).includes(result.verdict as string)) {
			throw new EventRejected("payload", "qa_results.verdict is unknown");
		}
		if ("detail" in result) requireString(result.detail, "qa_results.detail", 0, 500);
	}

	const source = payload.source;
	if (!isRecord(source)) throw new EventRejected("payload", "source is not an object");
	requireKeys(source, "source", ["kind", "ref", "rights"], ["kind", "ref", "rights"]);
	if (!(SOURCE_KINDS as readonly string[]).includes(source.kind as string))
		throw new EventRejected("payload", "source.kind is unknown");
	requireString(source.ref, "source.ref", 1, 500);
	requireString(source.rights, "source.rights", 1, 200);

	if (typeof payload.brief_ref !== "string" || !UUID.test(payload.brief_ref)) {
		throw new EventRejected("payload", "brief_ref is not a uuid");
	}
	if (typeof payload.business_key !== "string" || !BUSINESS_KEY.test(payload.business_key)) {
		throw new EventRejected("payload", "business_key does not match ^[a-z_]{2,32}$");
	}
	return payload as unknown as ContentDraftPayload;
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
	if (typeof envelope.schema_version !== "string" || !SUPPORTED_SCHEMA_VERSIONS.has(envelope.schema_version)) {
		throw new EventRejected("schema_version", "unknown envelope schema version");
	}
	const isDraft = envelope.event_type === EVENT_CONTENT_DRAFT_READY;
	if (isDraft) {
		// The material event did not exist in version 1, so a version 1 envelope
		// claiming to carry one is a sender that does not know the contract.
		if (envelope.schema_version === SCHEMA_VERSION) {
			throw new EventRejected("event_type", "content.draft_ready requires schema version 1.1");
		}
	} else if (envelope.event_type !== EVENT_TASK_RESULT_READY) {
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
	if (isDraft) {
		// The hash is checked before the payload's own rules so that a body which
		// merely disagrees with its hash is named for that, not for a field inside.
		if (typeof envelope.payload_hash !== "string" || payloadHash(payload) !== envelope.payload_hash) {
			throw new EventRejected("payload_hash", "payload_hash does not match the payload");
		}
		const draft = validateContentDraftPayload(payload);
		if (envelope.aggregate_id !== materialAggregateId(draft.brief_ref, draft.content_kind)) {
			throw new EventRejected("payload", "aggregate_id is not derived from brief_ref and content_kind");
		}
		return envelope as unknown as EventEnvelope;
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

/**
 * Contract version 1.1: material events, checked against the sender's own fixture
 * bytes exactly as the version 1 suite does. Every case here was produced by
 * `backend/scripts/generate_bridge_fixtures.py` on the Aether side.
 */

import { describe, expect, it } from "vitest";
import fixtures from "./contracts/control-room-event.v1.1.fixtures.json" with { type: "json" };
import fixturesV1 from "./contracts/control-room-event.v1.fixtures.json" with { type: "json" };
import {
	acceptEvent,
	BODY_MARKDOWN_MAX_BYTES,
	EVENT_CONTENT_DRAFT_READY,
	EventRejected,
	GROWTH_MATERIAL_NAMESPACE,
	isContentDraftEvent,
	isStale,
	MAX_EVENT_BODY_BYTES,
	materialAggregateId,
	parseEnvelope,
	QA_CHECKS,
	SCHEMA_VERSION_1_1,
	validateContentDraftPayload,
	validateCtaUrl,
} from "./selena-aether-bridge";

type Case = (typeof fixtures.cases)[number] & {
	rejected_because?: string;
	expected_aggregate_id?: string;
	last_applied_version?: number;
	stale?: boolean;
	qa_blocked?: boolean;
};

const SECRETS = [fixtures.secret];
const cases = fixtures.cases as Case[];
const byName = (name: string): Case => {
	const found = cases.find((entry) => entry.name === name);
	if (!found) throw new Error(`fixture ${name} is missing`);
	return found;
};
const headers = (entry: Case) => ({ signature: entry.signature, timestamp: entry.timestamp });
const now = (entry: Case) => new Date(Date.parse(entry.timestamp));

describe("what the sender and the receiver agree on for materials", () => {
	it("shares the namespace and the body limit with the sender", () => {
		expect(fixtures.material_namespace).toBe(GROWTH_MATERIAL_NAMESPACE);
		expect(fixtures.body_markdown_max_bytes).toBe(BODY_MARKDOWN_MAX_BYTES);
		expect(fixtures.max_event_body_bytes).toBe(MAX_EVENT_BODY_BYTES);
	});

	it("keeps the largest possible envelope under the receiver's body limit", () => {
		const entry = byName("accepted_article");
		const envelope = JSON.parse(entry.body) as { payload: Record<string, unknown> };
		// Every free-text code point is four bytes wide: the worst case by bytes.
		const w = "😀";
		const url = `https://${"h".repeat(2039)}/`;
		const maximal = {
			...envelope,
			payload: {
				...envelope.payload,
				title: w.repeat(200),
				language: "ru-Cyrl-RU-1234",
				body_markdown: "a".repeat(BODY_MARKDOWN_MAX_BYTES),
				metadata: {
					cta_url: url,
					slug: w.repeat(200),
					meta_title: w.repeat(200),
					meta_description: w.repeat(500),
					internal_links: Array.from({ length: 20 }, () => url),
				},
				claims: Array.from({ length: 50 }, () => ({
					text: w.repeat(500),
					status: "UNKNOWN",
					source_ref: w.repeat(500),
				})),
				evidence: Array.from({ length: 50 }, () => ({
					kind: w.repeat(50),
					ref: w.repeat(500),
					captured_at: "2026-09-06T00:00:00.000000000+00:00",
				})),
				qa_results: QA_CHECKS.map((check) => ({ check, verdict: "UNKNOWN", detail: w.repeat(500) })),
				source: { kind: "SYNTHETIC_FIXTURE", ref: w.repeat(500), rights: w.repeat(200) },
			},
		};
		expect(() => validateContentDraftPayload(maximal.payload)).not.toThrow();
		expect(Buffer.byteLength(JSON.stringify(maximal), "utf8")).toBeLessThan(MAX_EVENT_BODY_BYTES);
	});

	it.each(["accepted_article", "accepted_social"])("accepts %s and derives the same aggregate id", (name) => {
		const entry = byName(name);
		const { envelope } = acceptEvent(entry.body, headers(entry), SECRETS, now(entry));
		expect(envelope.schema_version).toBe(SCHEMA_VERSION_1_1);
		expect(envelope.event_type).toBe(EVENT_CONTENT_DRAFT_READY);
		expect(isContentDraftEvent(envelope)).toBe(true);
		if (!isContentDraftEvent(envelope)) return;
		expect(envelope.aggregate_id).toBe(entry.expected_aggregate_id);
		expect(envelope.aggregate_id).toBe(
			materialAggregateId(envelope.project_id, envelope.payload.brief_ref, envelope.payload.content_kind),
		);
		expect(envelope.payload.source.kind).toBe("SYNTHETIC_FIXTURE");
	});

	it("gives the two materials of one brief different aggregates and the same brief_ref", () => {
		const article = acceptEvent(
			byName("accepted_article").body,
			headers(byName("accepted_article")),
			SECRETS,
			now(byName("accepted_article")),
		);
		const social = acceptEvent(
			byName("accepted_social").body,
			headers(byName("accepted_social")),
			SECRETS,
			now(byName("accepted_social")),
		);
		expect(article.envelope.aggregate_id).not.toBe(social.envelope.aggregate_id);
		if (!isContentDraftEvent(article.envelope) || !isContentDraftEvent(social.envelope)) throw new Error("not drafts");
		expect(article.envelope.payload.brief_ref).toBe(social.envelope.payload.brief_ref);
	});

	it("still accepts a version 1 envelope", () => {
		const entry = byName("v1_event_still_accepted");
		const { envelope } = acceptEvent(entry.body, headers(entry), SECRETS, now(entry));
		expect(envelope.schema_version).toBe("1");
		expect(isContentDraftEvent(envelope)).toBe(false);
	});

	it("keeps every version 1 fixture behaving as before", () => {
		// Version 1 fixtures are signed at one moment; the expired case is expired
		// relative to that moment, not to its own timestamp.
		const signingTime = now(fixturesV1.cases.find((entry) => entry.name === "accepted") as Case);
		for (const entry of fixturesV1.cases as Case[]) {
			const run = () => acceptEvent(entry.body, headers(entry), [fixturesV1.secret], signingTime);
			if (entry.rejected_because) {
				expect(run).toThrow(EventRejected);
				try {
					run();
				} catch (error) {
					expect((error as EventRejected).reason).toBe(entry.rejected_because);
				}
			} else {
				expect(run).not.toThrow();
			}
		}
	});

	it("orders material versions per aggregate", () => {
		for (const name of ["newer_version_of_the_article", "replayed_older_article"]) {
			const entry = byName(name);
			const { envelope } = acceptEvent(entry.body, headers(entry), SECRETS, now(entry));
			expect(isStale(envelope, entry.last_applied_version ?? null)).toBe(entry.stale);
		}
	});

	it("accepts a draft whose QA failed or is unknown as a draft, leaving the release gate to block it", () => {
		for (const name of ["qa_fail_is_still_accepted", "qa_unknown_is_still_accepted"]) {
			const entry = byName(name);
			const { envelope } = acceptEvent(entry.body, headers(entry), SECRETS, now(entry));
			if (!isContentDraftEvent(envelope)) throw new Error("not a draft");
			expect(envelope.payload.qa_results.some((result) => result.verdict !== "PASS")).toBe(true);
			expect(entry.qa_blocked).toBe(true);
		}
	});
});

describe("every way a material event can be wrong", () => {
	const rejected = cases.filter((entry) => entry.rejected_because);
	it("has the rejection cases the sender published", () => {
		expect(rejected.map((entry) => entry.name)).toEqual([
			"draft_tampered_in_transit",
			"draft_hash_disagrees_with_payload",
			"aggregate_id_not_derived_from_brief",
			"unknown_content_kind",
			"body_markdown_too_large",
			"cta_url_missing",
			"cta_url_not_https",
			"cta_url_with_credentials",
			"business_key_missing",
			"qa_results_incomplete",
			"qa_check_repeated",
			"claim_status_unknown_value",
			"unknown_payload_field",
			"internal_links_null",
			"internal_links_too_many",
			"cta_url_empty_fragment",
			"cta_url_empty_userinfo",
			"evidence_captured_at_not_rfc3339",
			"title_too_long",
			"language_trailing_newline",
			"claims_too_many",
			"source_kind_unknown",
			"unknown_metadata_field",
		]);
	});

	it.each(rejected.map((entry) => [entry.name, entry.rejected_because] as const))(
		"refuses %s for reason %s",
		(name, reason) => {
			const entry = byName(name);
			try {
				acceptEvent(entry.body, headers(entry), SECRETS, now(entry));
			} catch (error) {
				expect(error).toBeInstanceOf(EventRejected);
				expect((error as EventRejected).reason).toBe(reason);
				return;
			}
			throw new Error(`${name} was accepted`);
		},
	);

	it("names the byte count, not the character count, when the body is too large", () => {
		const entry = byName("body_markdown_too_large");
		const envelope = JSON.parse(entry.body) as { payload: { body_markdown: string } };
		expect(envelope.payload.body_markdown.length).toBeLessThan(BODY_MARKDOWN_MAX_BYTES);
		expect(Buffer.byteLength(envelope.payload.body_markdown, "utf8")).toBeGreaterThan(BODY_MARKDOWN_MAX_BYTES);
		expect(() => parseEnvelope(entry.body)).toThrow(/bytes/);
	});

	it("refuses a content.draft_ready event that claims schema version 1", () => {
		const entry = byName("accepted_article");
		const envelope = JSON.parse(entry.body) as Record<string, unknown>;
		envelope.schema_version = "1";
		try {
			parseEnvelope(JSON.stringify(envelope));
		} catch (error) {
			expect((error as EventRejected).reason).toBe("event_type");
			return;
		}
		throw new Error("accepted");
	});

	it("checks the cta url as a url", () => {
		expect(() => validateCtaUrl("https://www.selenasystems.com/visibility?utm=x")).not.toThrow();
		for (const bad of [
			"",
			"not a url",
			"http://a.b/c",
			"https://u:p@a.b/c",
			"https://:@a.b/c",
			"https://a.b/c#frag",
			"https://a.b/c#",
			"https://a b/c",
			"https://a.b:99999/c",
			"https://[::1/x",
			`https://a.b/${"x".repeat(2100)}`,
		]) {
			expect(() => validateCtaUrl(bad)).toThrow(EventRejected);
		}
	});

	it("measures string limits in code points and refuses lone surrogates", () => {
		const entry = byName("accepted_article");
		const payload = (JSON.parse(entry.body) as { payload: Record<string, unknown> }).payload;
		expect(() => validateContentDraftPayload({ ...payload, title: "😀".repeat(200) })).not.toThrow();
		expect(() => validateContentDraftPayload({ ...payload, title: "😀".repeat(201) })).toThrow(EventRejected);
		expect(() => validateContentDraftPayload({ ...payload, title: "bad \ud800 title" })).toThrow(/lone surrogate/);
		expect(() => parseEnvelope('{"a":"\ud800"}')).toThrow(EventRejected);
	});

	it("accepts a version 1 task event carried in a 1.1 envelope, on purpose", () => {
		const entry = byName("task_result_in_1_1_envelope");
		const { envelope } = acceptEvent(entry.body, headers(entry), SECRETS, now(entry));
		expect(envelope.event_type).toBe("task.result.ready");
		expect(envelope.schema_version).toBe(SCHEMA_VERSION_1_1);
	});

	it("accepts a body of exactly the byte limit", () => {
		const entry = byName("body_markdown_exactly_at_limit");
		expect(() => acceptEvent(entry.body, headers(entry), SECRETS, now(entry))).not.toThrow();
	});

	it("never lets the payload carry an artifact reference in this version", () => {
		const entry = byName("accepted_article");
		const payload = (JSON.parse(entry.body) as { payload: Record<string, unknown> }).payload;
		expect(() => validateContentDraftPayload({ ...payload, artifact_ref: { id: "x" } })).toThrow(/unknown field/);
	});
});

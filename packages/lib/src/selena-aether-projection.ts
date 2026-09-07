/**
 * Turning an accepted material event into the shape of a Control Room content
 * version. Pure: no database, no clock. The worker that owns the transaction
 * decides what to do with the result; this module decides what the result is.
 */
import { type ContentDraftPayload, type EventEnvelope, isContentDraftEvent } from "./selena-aether-bridge";
import { contentVersionHash } from "./selena-control-room";

/** Why an accepted event still did not become a content version. Stored as a code, never as text. */
export type ProjectionErrorCode =
	| "NO_BINDING"
	| "BUSINESS_KEY_MISMATCH"
	| "NO_CONTENT_POLICY"
	| "NOT_A_MATERIAL"
	| "PROJECTION_FAILED";

export class ProjectionRejected extends Error {
	constructor(readonly code: ProjectionErrorCode) {
		super(code);
		this.name = "ProjectionRejected";
	}
}

export interface ResolvedBinding {
	bindingId: string;
	organizationId: string;
	brandId: string;
	aetherBusinessKey: string;
}

export interface ContentDraftInput {
	organizationId: string;
	brandId: string;
	kind: ContentDraftPayload["content_kind"];
	externalRef: string;
	briefRef: string;
	title: string;
	version: number;
	body: string;
	ctaUrl: string;
	claims: ContentDraftPayload["claims"];
	evidence: ContentDraftPayload["evidence"];
	disclosure: ContentDraftDisclosure;
	policyVersion: string;
	contentHash: string;
	createdBy: string;
}

/**
 * What the Control Room and the release gate need to know about a material that
 * did not come from a person: where it came from, whether it is synthetic, and
 * whether QA left it in a state a human may approve.
 */
export interface ContentDraftDisclosure {
	source: ContentDraftPayload["source"];
	origin: { system: "aether"; project_id: string; event_id: string; trace_id: string; occurred_at: string };
	language: string;
	metadata: ContentDraftPayload["metadata"];
	qa_results: ContentDraftPayload["qa_results"];
	qa_failed: boolean;
	needs_verification: boolean;
	synthetic: boolean;
}

export const PROJECTION_ACTOR = "service:registry-worker";

export function buildDisclosure(envelope: EventEnvelope & { payload: ContentDraftPayload }): ContentDraftDisclosure {
	const payload = envelope.payload;
	return {
		source: payload.source,
		origin: {
			system: "aether",
			project_id: envelope.project_id,
			event_id: envelope.event_id,
			trace_id: envelope.trace_id,
			occurred_at: envelope.occurred_at,
		},
		language: payload.language,
		metadata: payload.metadata,
		qa_results: payload.qa_results,
		// FAIL and UNKNOWN both keep a version away from approval: the first because a
		// check found a problem, the second because nobody has looked.
		qa_failed: payload.qa_results.some((result) => result.verdict === "FAIL"),
		needs_verification:
			payload.qa_results.some((result) => result.verdict === "UNKNOWN") ||
			payload.claims.some((claim) => claim.status === "UNKNOWN" || claim.status === "HYPOTHESIS"),
		synthetic: payload.source.kind === "SYNTHETIC_FIXTURE",
	};
}

/**
 * The binding was found by the event's project and environment; the business
 * key is the sender's claim about which business the project serves, and it has
 * to agree with what the owner confirmed — otherwise the sender's configuration
 * and the owner's decision have drifted apart and nothing is written.
 */
export function projectDraftEvent(
	envelope: EventEnvelope,
	binding: ResolvedBinding,
	policyVersion: string,
): ContentDraftInput {
	if (!isContentDraftEvent(envelope)) throw new ProjectionRejected("NOT_A_MATERIAL");
	const payload = envelope.payload;
	if (payload.business_key !== binding.aetherBusinessKey) throw new ProjectionRejected("BUSINESS_KEY_MISMATCH");
	const disclosure = buildDisclosure(envelope);
	const contentHash = contentVersionHash({
		body: payload.body_markdown,
		ctaUrl: payload.metadata.cta_url,
		claims: payload.claims,
		evidence: payload.evidence,
		disclosure,
		policyVersion,
	});
	return {
		organizationId: binding.organizationId,
		brandId: binding.brandId,
		kind: payload.content_kind,
		externalRef: envelope.aggregate_id,
		briefRef: payload.brief_ref,
		title: payload.title,
		version: envelope.version,
		body: payload.body_markdown,
		ctaUrl: payload.metadata.cta_url,
		claims: payload.claims,
		evidence: payload.evidence,
		disclosure,
		policyVersion,
		contentHash,
		createdBy: PROJECTION_ACTOR,
	};
}

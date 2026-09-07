/**
 * The structured YouTube video document and its readable rendering.
 *
 * The shape is the one the master specification names in section 10, including
 * the `thumbnail` block Slice 3 never populates: it belongs to the versioned
 * contract, and adding it later would mean a schema bump for a field the
 * contract already anticipated.
 *
 * Stage 1 adds structure without breaking what already reads the content table.
 * `content_versions.body` is a text column existing surfaces render, so a
 * structured version writes *both*: the document into `structured_body`, and a
 * deterministic rendering of it into `body`. A reader that knows nothing about
 * `format_version` still sees the whole script rather than an empty string or a
 * blob of JSON.
 *
 * The rendering is one-way. The document is the record and the text is a
 * projection of it; nothing parses the text back, because a round-trip through
 * prose is exactly the kind of implicit contract that breaks silently.
 *
 * The document carries evidence claim *ids*. The claims themselves live in the
 * version's `evidence` column, which already exists and which the release gate
 * already reads — one home for a claim, not two that can disagree.
 */

import { z } from "zod";
import { contentFormatSchema, discoverySurfaceSchema, type evidenceClaimSchema } from "../creation/contracts";

/** Stamped on every structured version, so a reader can tell what it is holding. */
export const YOUTUBE_VIDEO_DOCUMENT_SCHEMA = "content.youtube-video/v1";

/**
 * The `format_version` a structured version records. V1 content keeps
 * `legacy.text/v1` and its `selena.content/v1` hash, and neither is ever
 * recomputed — a stored hash is a historical fact about what was approved.
 */
export const STRUCTURED_FORMAT_VERSION = "content.youtube-video/v1";
export const LEGACY_FORMAT_VERSION = "legacy.text/v1";
export const CONTENT_WORKFLOW_V2_HASH_VERSION = "content.workflow/v2";

const claimId = z.string().trim().min(1).max(128);

export const documentSectionSchema = z
	.object({
		heading: z.string().trim().min(1).max(120),
		purpose: z.string().trim().min(1).max(500),
		// Optional, because a generator that returns a section's purpose and its
		// claims has not written prose for it. Filling the gap with the purpose
		// would render the same sentence twice and present it as script.
		narration: z.string().trim().min(1).max(20_000).optional(),
		evidenceClaimIds: z.array(claimId).max(8),
	})
	.strict();

export const youTubeVideoDocumentSchema = z
	.object({
		schema: z.literal(YOUTUBE_VIDEO_DOCUMENT_SCHEMA),
		concept: z
			.object({
				angle: z.string().trim().min(1).max(300),
				hook: z.string().trim().min(1).max(1500),
				honestPromise: z.string().trim().min(1).max(500),
				format: contentFormatSchema,
				audience: z.string().trim().min(1).max(200),
				discoverySurface: discoverySurfaceSchema,
			})
			.strict(),
		titles: z.array(z.string().trim().min(1).max(100)).min(1).max(8),
		script: z
			.object({
				hook: z.string().trim().min(1).max(1500),
				sections: z.array(documentSectionSchema).min(2).max(16),
				payoff: z.string().trim().min(1).max(1000),
				primaryCta: z.string().trim().min(1).max(800),
				studioValidation: z.string().trim().min(1).max(800),
			})
			.strict()
			.optional(),
		/** Populated by Slice 4. Declared here because the contract version is shared. */
		thumbnail: z
			.object({
				concept: z.string().trim().min(1).max(700),
				text: z.string().trim().max(120),
				assetIds: z.array(z.string().uuid()).max(8),
			})
			.strict()
			.optional(),
		evidenceClaimIds: z.array(claimId).min(1).max(32),
	})
	.strict()
	.superRefine((document, ctx) => {
		// A section citing a claim the document does not carry would render a
		// reference a reviewer cannot follow, which is worse than no reference.
		const known = new Set(document.evidenceClaimIds);
		document.script?.sections.forEach((section, sectionIndex) => {
			section.evidenceClaimIds.forEach((id, index) => {
				if (!known.has(id)) {
					ctx.addIssue({
						code: "custom",
						path: ["script", "sections", sectionIndex, "evidenceClaimIds", index],
						message: `Section cites an evidence claim the document does not carry: ${id}`,
					});
				}
			});
		});
	});

export type YouTubeVideoDocument = z.infer<typeof youTubeVideoDocumentSchema>;

export class ContentDocumentError extends Error {
	readonly code = "INVALID_CONTENT_DOCUMENT" as const;

	constructor(message: string) {
		super(message);
		this.name = "ContentDocumentError";
	}
}

export function parseYouTubeVideoDocument(value: unknown): YouTubeVideoDocument {
	const result = youTubeVideoDocumentSchema.safeParse(value);
	if (!result.success) {
		// The message is ours, not the parser's: a Zod issue tree can quote the
		// offending value, and generation output is the one place that value could
		// be a provider's words.
		throw new ContentDocumentError("The structured content document is not valid");
	}
	return result.data;
}

/**
 * Deterministic text for the legacy body column. Same document in, same bytes
 * out — no clock, no locale, no ordering that depends on object iteration.
 *
 * Claims are passed in rather than read off the document because the document
 * holds ids; a caller that cannot resolve them renders the ids, which is honest
 * about what it knows.
 */
export function renderReadableBody(
	document: YouTubeVideoDocument,
	claims: readonly z.infer<typeof evidenceClaimSchema>[] = [],
): string {
	const claimById = new Map(claims.map((claim) => [claim.id, claim]));
	const lines: string[] = [document.titles[0], "", document.concept.hook, "", document.concept.honestPromise, ""];

	for (const section of document.script?.sections ?? []) {
		lines.push(`## ${section.heading}`, section.purpose);
		if (section.narration) lines.push("", section.narration);
		for (const id of section.evidenceClaimIds) {
			const claim = claimById.get(id);
			lines.push(claim ? `- ${claim.claim} [${claim.evidenceClass}, ${claim.confidence}]` : `- ${id}`);
		}
		lines.push("");
	}

	if (document.script) {
		lines.push(
			"## Payoff",
			document.script.payoff,
			"",
			"## Call to action",
			document.script.primaryCta,
			"",
			"## How this gets checked",
			document.script.studioValidation,
		);
	}

	if (document.titles.length > 1) {
		lines.push("", "## Alternative titles");
		for (const title of document.titles.slice(1)) lines.push(`- ${title}`);
	}

	return lines.join("\n");
}

function normalizedClaim(claim: z.infer<typeof evidenceClaimSchema>) {
	return {
		claim: claim.claim,
		confidence: claim.confidence,
		evidenceClass: claim.evidenceClass,
		id: claim.id,
		limitations: [...claim.limitations],
		researchRunId: claim.researchRunId,
		sourceExternalIds: [...claim.sourceExternalIds].sort((left, right) => left.localeCompare(right, "en")),
	};
}

/**
 * The evidence snapshot the V2 hash covers.
 *
 * Three properties, each of which the hash depends on:
 *
 * - only cited claims are included, because evidence the document does not use
 *   is not part of what was approved;
 * - claims are sorted by id, so reordering the same evidence does not move the
 *   hash while changing any claim's content does;
 * - a claim appears once. Callers assemble evidence from several places — the
 *   run's claims and the selected idea's — and the same claim legitimately
 *   arrives twice. Keeping both would make the digest depend on how the caller
 *   happened to concatenate its inputs, which is not a property of the content.
 *
 * Two claims sharing an id but disagreeing on content are refused rather than
 * collapsed: that is a real inconsistency, and picking one silently would hash
 * evidence nobody assembled.
 */
export function evidenceSnapshot(
	document: YouTubeVideoDocument,
	claims: readonly z.infer<typeof evidenceClaimSchema>[],
): unknown {
	const cited = new Set(document.evidenceClaimIds);
	const byId = new Map<string, ReturnType<typeof normalizedClaim>>();
	for (const claim of claims) {
		if (!cited.has(claim.id)) continue;
		const normalized = normalizedClaim(claim);
		const existing = byId.get(claim.id);
		if (existing && JSON.stringify(existing) !== JSON.stringify(normalized)) {
			throw new ContentDocumentError(`Two different evidence claims share the id ${claim.id}`);
		}
		byId.set(claim.id, normalized);
	}
	return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id, "en"));
}

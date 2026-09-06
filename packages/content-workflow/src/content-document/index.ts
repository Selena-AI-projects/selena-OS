/**
 * The structured YouTube video document and its readable rendering.
 *
 * Stage 1 adds structure without breaking what already reads the content table.
 * `content_versions.body` is a text column that existing surfaces render, so a
 * structured version writes *both*: the document into `structured_body`, and a
 * deterministic rendering of it into `body`. A reader that knows nothing about
 * `format_version` still sees the whole script rather than an empty string or a
 * blob of JSON.
 *
 * The rendering is one-way and lossless only in the direction that matters: the
 * document is the record, the text is a projection of it. Nothing parses the
 * text back, because a round-trip through prose is exactly the kind of implicit
 * contract that breaks silently.
 */

import { z } from "zod";
import { evidenceClaimSchema, scriptSectionSchema } from "../creation/contracts";

/** Stamped on every structured version, so a reader can tell what it is holding. */
export const YOUTUBE_VIDEO_DOCUMENT_FORMAT = "youtube.video/v1";

/**
 * The hash version for structured content. V1 content keeps `selena.content/v1`
 * and is never recomputed — a stored hash is a historical fact about what was
 * approved, and recalculating it would rewrite that fact.
 */
export const CONTENT_WORKFLOW_V2_HASH_VERSION = "content.workflow/v2";

export const youTubeVideoDocumentSchema = z
	.object({
		format: z.literal(YOUTUBE_VIDEO_DOCUMENT_FORMAT),
		title: z.string().trim().min(1).max(100),
		alternativeTitles: z.array(z.string().trim().min(1).max(100)).max(8).default([]),
		hook: z.string().trim().min(1).max(1500),
		sections: z.array(scriptSectionSchema).min(2).max(16),
		script: z.string().trim().min(1).max(80_000),
		payoff: z.string().trim().min(1).max(1000),
		primaryCta: z.string().trim().min(1).max(800),
		studioValidation: z.string().trim().min(1).max(800),
		evidenceClaims: z.array(evidenceClaimSchema).min(1).max(32),
	})
	.strict()
	.superRefine((document, ctx) => {
		// A section citing a claim the document does not carry would render a
		// reference a reviewer cannot follow, which is worse than no reference.
		const known = new Set(document.evidenceClaims.map((claim) => claim.id));
		document.sections.forEach((section, sectionIndex) => {
			section.evidenceClaimIds.forEach((claimId, claimIndex) => {
				if (!known.has(claimId)) {
					ctx.addIssue({
						code: "custom",
						path: ["sections", sectionIndex, "evidenceClaimIds", claimIndex],
						message: `Section cites an evidence claim the document does not carry: ${claimId}`,
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
 */
export function renderReadableBody(document: YouTubeVideoDocument): string {
	const claimById = new Map(document.evidenceClaims.map((claim) => [claim.id, claim]));
	const lines: string[] = [document.title, "", document.hook, ""];

	for (const section of document.sections) {
		lines.push(`## ${section.section}`, section.purpose);
		for (const claimId of section.evidenceClaimIds) {
			const claim = claimById.get(claimId);
			// Unknown ids cannot reach here — the schema rejects them — but rendering
			// is not the place to assume that, so an id without a claim renders as
			// the bare id rather than as `undefined`.
			lines.push(claim ? `- ${claim.claim} [${claim.evidenceClass}, ${claim.confidence}]` : `- ${claimId}`);
		}
		lines.push("");
	}

	lines.push(
		"## Script",
		document.script,
		"",
		"## Payoff",
		document.payoff,
		"",
		"## Call to action",
		document.primaryCta,
	);
	lines.push("", "## How this gets checked", document.studioValidation);

	if (document.alternativeTitles.length > 0) {
		lines.push("", "## Alternative titles");
		for (const title of document.alternativeTitles) lines.push(`- ${title}`);
	}

	return lines.join("\n");
}

/**
 * The evidence snapshot the V2 hash covers.
 *
 * Claims are sorted by id so that reordering the same evidence does not change
 * the hash, while changing any claim's content does.
 */
export function evidenceSnapshot(document: YouTubeVideoDocument): unknown {
	return [...document.evidenceClaims]
		.sort((left, right) => left.id.localeCompare(right.id, "en"))
		.map((claim) => ({
			claim: claim.claim,
			confidence: claim.confidence,
			evidenceClass: claim.evidenceClass,
			id: claim.id,
			limitations: [...claim.limitations],
			researchRunId: claim.researchRunId,
			sourceExternalIds: [...claim.sourceExternalIds].sort((left, right) => left.localeCompare(right, "en")),
		}));
}

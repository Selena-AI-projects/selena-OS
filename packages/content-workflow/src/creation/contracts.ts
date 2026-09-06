/**
 * Idea, script and evidence contracts, transferred from `parkourcafe/youtube-pro`
 * at `63cd9b9c2ad19b9941a763be3d5cfcbd9bc13b25` under Apache-2.0. The licence and
 * the full provenance record are in
 * `packages/content-workflow/THIRD_PARTY_LICENSES/youtube-pro/`.
 *
 * Sources: `shared/evidence-contracts.ts`, the format/audience/provider-error
 * enums in `shared/schema.ts`, and `server/script-regeneration-contract.ts`.
 *
 * What these contracts are for: a generation adapter returns text, and text from
 * a model is not evidence. Everything below exists so that output which cannot
 * prove where its claims came from is rejected before it can become a content
 * version — the same reason the research registry stores provenance rather than
 * trusting a source's own account of itself.
 */

import { z } from "zod";

const boundedText = z.string().trim().min(1).max(2000);
/** Matches `content_research_sources.external_id`, which is what evidence cites. */
const sourceExternalId = z.string().trim().min(1).max(128);
const claimId = z.string().trim().min(1).max(128);

/**
 * Upstream used lower-case string unions. Persisted values are uppercase here so
 * they read the same way as every other enum in the registry, which is the
 * convention Slice 2 established for transferred vocabularies.
 */
export const evidenceClassSchema = z.enum(["OBSERVED", "INFERRED", "REQUIRES_STUDIO"]);
export type EvidenceClass = z.infer<typeof evidenceClassSchema>;

export const evidenceConfidenceSchema = z.enum(["HIGH", "MEDIUM", "LOW"]);

/**
 * Upstream bound a claim to a `snapshotId` naming a research snapshot. Here the
 * binding is the research run's own id: Slice 2 already makes a run immutable and
 * brand-scoped, so it is the thing a claim can be tied to without inventing a
 * second identity for the same evidence.
 */
export const evidenceClaimSchema = z
	.object({
		id: claimId,
		claim: boundedText,
		evidenceClass: evidenceClassSchema,
		sourceExternalIds: z.array(sourceExternalId).max(50),
		confidence: evidenceConfidenceSchema,
		limitations: z.array(boundedText).min(1).max(8),
		researchRunId: z.string().uuid(),
	})
	.strict()
	.superRefine((claim, ctx) => {
		// An observed claim asserts something was seen in a source. Without a source
		// it is an inference wearing a stronger word, so the class is a lie.
		if (claim.evidenceClass === "OBSERVED" && claim.sourceExternalIds.length === 0) {
			ctx.addIssue({
				code: "custom",
				path: ["sourceExternalIds"],
				message: "An observed claim must cite at least one research source",
			});
		}
	});
export type EvidenceClaim = z.infer<typeof evidenceClaimSchema>;

export const discoverySurfaceSchema = z.enum(["SEARCH", "BROWSE", "SUGGESTED", "SHORTS_FEED", "MIXED"]);

export const contentFormatSchema = z.enum(["SHORT", "LONG_FORM", "TUTORIAL", "REVIEW", "VLOG"]);
export type ContentFormat = z.infer<typeof contentFormatSchema>;

export const targetAudienceSchema = z.enum(["GENERAL", "TECH_SAVVY", "BEGINNERS", "PROFESSIONALS"]);
export type TargetAudience = z.infer<typeof targetAudienceSchema>;

export const ideaDifficultySchema = z.enum(["EASY", "MEDIUM", "HARD", "ADVANCED"]);

export const ideaPackageSchema = z
	.object({
		title: z.string().trim().min(1).max(100),
		description: boundedText,
		keywords: z.array(z.string().trim().min(1).max(80)).min(1).max(6),
		format: contentFormatSchema,
		difficulty: ideaDifficultySchema,
		honestPromise: z.string().trim().min(1).max(500),
		discoverySurface: discoverySurfaceSchema,
		payoff: z.string().trim().min(1).max(700),
		thumbnailConcept: z.string().trim().min(1).max(700),
		studioMetric: z.string().trim().min(1).max(500),
		experimentRule: z.string().trim().min(1).max(700),
		evidenceClaims: z.array(evidenceClaimSchema).min(1).max(8),
	})
	.strict();
export type IdeaPackage = z.infer<typeof ideaPackageSchema>;

/**
 * The evidence a generation runs against. Every claim must belong to the run this
 * context names; a claim that cites a different run is evidence from somewhere
 * else, and the whole point of the context is that it cannot be.
 */
export const researchEvidenceContextSchema = z
	.object({
		researchRunId: z.string().uuid(),
		opportunityKey: z.string().trim().min(1).max(200),
		sourceExternalIds: z.array(sourceExternalId).min(1).max(50),
		evidenceClaims: z.array(evidenceClaimSchema).min(1).max(24),
	})
	.strict()
	.superRefine((context, ctx) => {
		context.evidenceClaims.forEach((claim, index) => {
			if (claim.researchRunId !== context.researchRunId) {
				ctx.addIssue({
					code: "custom",
					path: ["evidenceClaims", index, "researchRunId"],
					message: "An evidence claim must belong to the active research run",
				});
			}
		});
	});
export type ResearchEvidenceContext = z.infer<typeof researchEvidenceContextSchema>;

/**
 * Exactly six. Not "at least" and not "up to": the count is the contract, because
 * a reviewer comparing six options is doing something different from a reviewer
 * accepting however many arrived.
 */
export const IDEA_PACKAGE_COUNT = 6;

export const ideaGenerationOutputSchema = z
	.object({
		ideas: z.array(ideaPackageSchema).length(IDEA_PACKAGE_COUNT),
	})
	.strict();
export type IdeaGenerationOutput = z.infer<typeof ideaGenerationOutputSchema>;

export const scriptEvidenceContextSchema = z
	.object({
		researchRunId: z.string().uuid(),
		sourceExternalIds: z.array(sourceExternalId).max(50),
		evidenceClaims: z.array(evidenceClaimSchema).min(1).max(24),
		ideaPackage: ideaPackageSchema,
	})
	.strict()
	.superRefine((context, ctx) => {
		const claims = [...context.evidenceClaims, ...context.ideaPackage.evidenceClaims];
		claims.forEach((claim, index) => {
			if (claim.researchRunId !== context.researchRunId) {
				ctx.addIssue({
					code: "custom",
					path: ["evidenceClaims", index, "researchRunId"],
					message: "An evidence claim must belong to the selected idea's research run",
				});
			}
		});
	});
export type ScriptEvidenceContext = z.infer<typeof scriptEvidenceContextSchema>;

export const scriptSectionSchema = z
	.object({
		section: z.string().trim().min(1).max(120),
		purpose: z.string().trim().min(1).max(500),
		evidenceClaimIds: z.array(claimId).max(8),
	})
	.strict();

export const scriptGenerationOutputSchema = z
	.object({
		titles: z.array(z.string().trim().min(1).max(100)).length(3),
		hook: z.string().trim().min(1).max(1500),
		structure: z.array(scriptSectionSchema).min(2).max(16),
		script: z.string().trim().min(1).max(80_000),
		payoff: z.string().trim().min(1).max(1000),
		primaryCta: z.string().trim().min(1).max(800),
		studioValidation: z.string().trim().min(1).max(800),
	})
	.strict();
export type ScriptGenerationOutput = z.infer<typeof scriptGenerationOutputSchema>;

export const titleRegenerationOutputSchema = z
	.object({
		titles: z.array(z.string().trim().min(1).max(100)).length(5),
	})
	.strict();

export const scriptRegenerationOutputSchema = z
	.object({
		content: z.string().trim().min(1).max(80_000),
		evidenceClaimIds: z.array(claimId).max(24),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (new Set(value.evidenceClaimIds).size !== value.evidenceClaimIds.length) {
			ctx.addIssue({
				code: "custom",
				path: ["evidenceClaimIds"],
				message: "Evidence claim ids must be unique",
			});
		}
	});
export type ScriptRegenerationOutput = z.infer<typeof scriptRegenerationOutputSchema>;

export const CREATION_ERROR_CODES = [
	"PROFILE_NOT_CONFIRMED",
	"OPPORTUNITY_NOT_SAVED",
	"INVALID_INPUT",
	"NOT_FOUND",
	"ADAPTER_DISABLED",
	"PROVIDER_UNAVAILABLE",
	"PROVIDER_RATE_LIMITED",
	"PROVIDER_AUTH_FAILED",
	"PROVIDER_QUOTA_EXCEEDED",
	"INVALID_GENERATION_OUTPUT",
	"IDEA_COUNT_INVALID",
	"EVIDENCE_OUT_OF_RUN",
	"EVIDENCE_CLAIM_UNKNOWN",
	"EVIDENCE_REQUIRED",
	"CONTENT_IMMUTABLE",
	"INTERNAL_ERROR",
] as const;

export type CreationErrorCode = (typeof CREATION_ERROR_CODES)[number];

export function isCreationErrorCode(value: unknown): value is CreationErrorCode {
	return typeof value === "string" && (CREATION_ERROR_CODES as readonly string[]).includes(value);
}

export class ContentCreationError extends Error {
	readonly code: CreationErrorCode;

	constructor(code: CreationErrorCode, message: string) {
		super(message);
		this.name = "ContentCreationError";
		this.code = code;
	}
}

/**
 * Transferred from upstream's `validateEvidenceSourceIds`, with the throw replaced
 * by a typed error so a caller can record a normalized code rather than a message.
 *
 * This is the rule that stops an adapter inventing a source: a claim may only cite
 * sources the active run actually produced.
 */
export function assertEvidenceSourcesInRun(
	claims: readonly EvidenceClaim[],
	allowedSourceExternalIds: readonly string[],
): void {
	const allowed = new Set(allowedSourceExternalIds);
	const unsupported = [...new Set(claims.flatMap((claim) => claim.sourceExternalIds.filter((id) => !allowed.has(id))))];
	if (unsupported.length > 0) {
		throw new ContentCreationError(
			"EVIDENCE_OUT_OF_RUN",
			`Evidence cites sources outside the active research run: ${unsupported.join(", ")}`,
		);
	}
}

/**
 * Transferred from upstream's `parseScriptRegenerationOutput`. A regeneration may
 * only cite claims the context already carries, so a revision cannot quietly
 * introduce evidence the reviewer never saw.
 */
export function assertCitedClaimsKnown(
	citedClaimIds: readonly string[],
	context: ScriptEvidenceContext | undefined,
): void {
	if (!context) {
		if (citedClaimIds.length > 0) {
			throw new ContentCreationError(
				"EVIDENCE_REQUIRED",
				"Generation cited evidence without an active evidence context",
			);
		}
		return;
	}
	const known = new Set([
		...context.evidenceClaims.map((claim) => claim.id),
		...context.ideaPackage.evidenceClaims.map((claim) => claim.id),
	]);
	const unsupported = citedClaimIds.find((id) => !known.has(id));
	if (unsupported) {
		throw new ContentCreationError(
			"EVIDENCE_CLAIM_UNKNOWN",
			`Generation cited an evidence claim outside its context: ${unsupported}`,
		);
	}
}

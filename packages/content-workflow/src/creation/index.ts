/**
 * The creation pipeline: a saved research opportunity becomes six ideas, and a
 * selected idea becomes a structured script.
 *
 * The shape is transferred from `parkourcafe/youtube-pro`'s idea and script
 * generation at `63cd9b9c2ad19b9941a763be3d5cfcbd9bc13b25`; the enforcement is
 * new. Upstream validated its provider's output against the same contracts but
 * had no notion of a brand, a confirmed profile or an immutable run, so nothing
 * there could ask the question this module exists to ask: does this evidence
 * belong to the run this brand actually approved?
 *
 * Provider clients are injected. This module cannot reach a network.
 */

import type { YouTubeVideoDocument } from "../content-document";
import { parseYouTubeVideoDocument, YOUTUBE_VIDEO_DOCUMENT_SCHEMA } from "../content-document";
import { isTooSimilarToSource } from "../research/anti-copy";
import type { ResearchOpportunity, ResearchSource } from "../research/contracts";
import type { CreationAdapter, IdeaGenerationRequest, ScriptGenerationRequest } from "./adapters";
import type {
	EvidenceClaim,
	IdeaPackage,
	ResearchEvidenceContext,
	ScriptEvidenceContext,
	ScriptGenerationOutput,
	TargetAudience,
} from "./contracts";
import {
	assertCitedClaimsKnown,
	assertEvidenceSourcesInRun,
	ContentCreationError,
	IDEA_PACKAGE_COUNT,
	ideaGenerationOutputSchema,
	researchEvidenceContextSchema,
	scriptEvidenceContextSchema,
	scriptGenerationOutputSchema,
} from "./contracts";

export * from "./adapters";
export * from "./contracts";
export * from "./thumbnails";

export const CREATION_VERSIONS = {
	pipeline: "content.creation/v1",
	ideaSchema: "content.creation.idea/v1",
	scriptSchema: "content.creation.script/v1",
} as const;

/**
 * Turns a saved opportunity and its run into the evidence a generation may use.
 *
 * Two kinds of claim come out of it, and the distinction is the honest part: what
 * the run observed about a source is `OBSERVED` and cites that source; what the
 * opportunity says still has to be checked is `REQUIRES_STUDIO` and cites
 * nothing, because it has not been established yet.
 */
export function buildEvidenceContext(input: {
	researchRunId: string;
	opportunity: ResearchOpportunity;
	sources: readonly Pick<ResearchSource, "externalId">[];
}): ResearchEvidenceContext {
	const sourceExternalIds = input.sources.map((source) => source.externalId);
	const claims: EvidenceClaim[] = [
		{
			id: `${input.opportunity.key}:observed`,
			claim: input.opportunity.evidenceSummary,
			evidenceClass: "OBSERVED",
			sourceExternalIds: [input.opportunity.sourceExternalId],
			confidence: input.opportunity.confidence,
			limitations: ["Measured against the creator's own baseline, not against the category."],
			researchRunId: input.researchRunId,
		},
		...input.opportunity.factRequirements.map((requirement, index) => ({
			id: `${input.opportunity.key}:requires-${index}`,
			claim: requirement,
			evidenceClass: "REQUIRES_STUDIO" as const,
			sourceExternalIds: [],
			confidence: "LOW" as const,
			limitations: ["Not established by the research run; must be verified before it is stated as fact."],
			researchRunId: input.researchRunId,
		})),
	];

	const parsed = researchEvidenceContextSchema.safeParse({
		researchRunId: input.researchRunId,
		opportunityKey: input.opportunity.key,
		sourceExternalIds,
		evidenceClaims: claims,
	});
	if (!parsed.success) {
		throw new ContentCreationError("EVIDENCE_REQUIRED", "The opportunity does not carry usable evidence");
	}
	return parsed.data;
}

export interface IdeaGenerationCounters {
	ideasReturned: number;
	ideasRejectedByAntiCopy: number;
	externalProviderCalls: number;
}

export interface IdeaGenerationOutcome {
	pipelineVersion: string;
	schemaVersion: string;
	ideas: IdeaPackage[];
	counters: IdeaGenerationCounters;
}

export interface RunIdeaGenerationInput {
	adapter: CreationAdapter;
	evidence: ResearchEvidenceContext;
	projectSlug: string;
	profileHash: string;
	languages: string[];
	audience: TargetAudience;
	/** The source titles the ideas must not simply restate. */
	sourceTitles: readonly string[];
	now: Date;
}

export async function runIdeaGeneration(input: RunIdeaGenerationInput): Promise<IdeaGenerationOutcome> {
	const request: IdeaGenerationRequest = {
		evidence: input.evidence,
		projectSlug: input.projectSlug,
		profileHash: input.profileHash,
		languages: input.languages,
		audience: input.audience,
		now: input.now,
	};

	const result = await input.adapter.generateIdeas(request);

	const parsed = ideaGenerationOutputSchema.safeParse(result.output);
	if (!parsed.success) {
		// The count is checked separately so the failure says which rule broke: a
		// reviewer told "invalid output" learns nothing, and "five ideas, not six"
		// is immediately actionable.
		const ideas = (result.output as { ideas?: unknown[] } | undefined)?.ideas;
		if (Array.isArray(ideas) && ideas.length !== IDEA_PACKAGE_COUNT) {
			throw new ContentCreationError(
				"IDEA_COUNT_INVALID",
				`Idea generation must return exactly ${IDEA_PACKAGE_COUNT} ideas; it returned ${ideas.length}`,
			);
		}
		throw new ContentCreationError("INVALID_GENERATION_OUTPUT", "Idea generation returned output that is not valid");
	}

	for (const idea of parsed.data.ideas) {
		assertEvidenceSourcesInRun(idea.evidenceClaims, input.evidence.sourceExternalIds);
		for (const claim of idea.evidenceClaims) {
			if (claim.researchRunId !== input.evidence.researchRunId) {
				throw new ContentCreationError(
					"EVIDENCE_OUT_OF_RUN",
					"An idea cites evidence from a research run other than the active one",
				);
			}
		}
	}

	// Anti-copy applies to ideas for the same reason it applies to opportunities:
	// an adaptation that restates a source's title is the source, relabelled.
	const kept = parsed.data.ideas.filter(
		(idea) => !input.sourceTitles.some((title) => isTooSimilarToSource(title, idea.title)),
	);
	if (kept.length !== parsed.data.ideas.length) {
		throw new ContentCreationError(
			"INVALID_GENERATION_OUTPUT",
			`Idea generation must return ${IDEA_PACKAGE_COUNT} ideas that do not restate a source title`,
		);
	}

	return {
		pipelineVersion: CREATION_VERSIONS.pipeline,
		schemaVersion: CREATION_VERSIONS.ideaSchema,
		ideas: parsed.data.ideas,
		counters: {
			ideasReturned: parsed.data.ideas.length,
			ideasRejectedByAntiCopy: parsed.data.ideas.length - kept.length,
			externalProviderCalls: result.externalProviderCalls,
		},
	};
}

export function buildScriptEvidenceContext(input: {
	evidence: ResearchEvidenceContext;
	idea: IdeaPackage;
}): ScriptEvidenceContext {
	const parsed = scriptEvidenceContextSchema.safeParse({
		researchRunId: input.evidence.researchRunId,
		sourceExternalIds: input.evidence.sourceExternalIds,
		evidenceClaims: input.evidence.evidenceClaims,
		ideaPackage: input.idea,
	});
	if (!parsed.success) {
		throw new ContentCreationError("EVIDENCE_REQUIRED", "The selected idea does not carry usable evidence");
	}
	return parsed.data;
}

export interface ScriptGenerationOutcome {
	pipelineVersion: string;
	schemaVersion: string;
	script: ScriptGenerationOutput;
	externalProviderCalls: number;
}

export async function runScriptGeneration(input: {
	adapter: CreationAdapter;
	evidence: ScriptEvidenceContext;
	projectSlug: string;
	profileHash: string;
	languages: string[];
	audience: TargetAudience;
	now: Date;
}): Promise<ScriptGenerationOutcome> {
	const request: ScriptGenerationRequest = {
		evidence: input.evidence,
		projectSlug: input.projectSlug,
		profileHash: input.profileHash,
		languages: input.languages,
		audience: input.audience,
		now: input.now,
	};

	const result = await input.adapter.generateScript(request);

	const parsed = scriptGenerationOutputSchema.safeParse(result.output);
	if (!parsed.success) {
		throw new ContentCreationError("INVALID_GENERATION_OUTPUT", "Script generation returned output that is not valid");
	}

	// Every claim a section cites has to be one the context carries. A section
	// that cites something else is a footnote to a document nobody has.
	const cited = [...new Set(parsed.data.structure.flatMap((section) => section.evidenceClaimIds))];
	assertCitedClaimsKnown(cited, input.evidence);

	return {
		pipelineVersion: CREATION_VERSIONS.pipeline,
		schemaVersion: CREATION_VERSIONS.scriptSchema,
		script: parsed.data,
		externalProviderCalls: result.externalProviderCalls,
	};
}

/**
 * The document a selected idea becomes, before any script exists.
 *
 * Selecting an idea creates the content item and its first version, so the
 * document is valid without a script: the concept and its evidence are already
 * a decision worth recording immutably, and the script arrives as a later
 * version rather than by editing this one.
 */
export function buildConceptDocument(input: {
	idea: IdeaPackage;
	evidence: ScriptEvidenceContext;
	audience: TargetAudience;
}): YouTubeVideoDocument {
	const claims = [...input.evidence.evidenceClaims, ...input.idea.evidenceClaims];
	return parseYouTubeVideoDocument({
		schema: YOUTUBE_VIDEO_DOCUMENT_SCHEMA,
		concept: {
			angle: input.idea.description,
			hook: input.idea.honestPromise,
			honestPromise: input.idea.honestPromise,
			format: input.idea.format,
			audience: input.audience,
			discoverySurface: input.idea.discoverySurface,
		},
		titles: [input.idea.title],
		evidenceClaimIds: [...new Set(claims.map((claim) => claim.id))],
	});
}

/** The same document with a generated script folded in, as a new version. */
export function buildScriptDocument(input: {
	concept: YouTubeVideoDocument;
	script: ScriptGenerationOutput;
}): YouTubeVideoDocument {
	return parseYouTubeVideoDocument({
		...input.concept,
		titles: [...new Set([...input.script.titles, ...input.concept.titles])].slice(0, 8),
		script: {
			hook: input.script.hook,
			// The generation contract carries a section's purpose and its claims; the
			// narration is the script body attributed to that section. Until a provider
			// returns per-section prose, the whole script sits on the first section
			// rather than being split by a guess at its boundaries — and the rest carry
			// no narration key at all. Repeating their purpose would present the same
			// sentence twice as though it were script, and an explicit `undefined`
			// would reach the canonical JSON the V2 digest is taken over, which
			// refuses it.
			sections: input.script.structure.map((section, index) => ({
				heading: section.section,
				purpose: section.purpose,
				...(index === 0 ? { narration: input.script.script } : {}),
				evidenceClaimIds: section.evidenceClaimIds,
			})),
			payoff: input.script.payoff,
			primaryCta: input.script.primaryCta,
			studioValidation: input.script.studioValidation,
		},
	});
}

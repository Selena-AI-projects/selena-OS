/**
 * Research run orchestration and the module contract.
 *
 * Transferred in shape from `lib/video-radar/run.ts` at
 * `b589a811a4e1f205a784e5128283f9d227143f32`, with its provider fetching,
 * Supabase persistence, quota bookkeeping and job scheduling removed: the run
 * here is a pure function of an adapter result, a brand-derived project and an
 * explicit clock, so the same inputs always produce the same run.
 */

import type { ResearchAdapter } from "./adapters";
import { isTooSimilarToSource } from "./anti-copy";
import { computeBaseline } from "./baseline";
import type {
	EvidenceConfidence,
	OpportunityState,
	ResearchOpportunity,
	ResearchProject,
	ResearchRunFailure,
	ResearchRunOutcome,
	ResearchSource,
	ScoredSource,
	SourceProvenance,
} from "./contracts";
import { ContentResearchError, emptyRunCounters, RESEARCH_VERSIONS } from "./contracts";
import { computeEngagement, computeVelocity } from "./metrics";
import { computeOutlier } from "./outlier";
import { computeRelevance } from "./relevance";
import { applyQuota, computeCandidateScore, passesQualityGate } from "./score";
import { classifyVideoType } from "./video-type";

export * from "./adapters";
export * from "./anti-copy";
export * from "./baseline";
export * from "./config";
export * from "./contracts";
export * from "./metrics";
export * from "./outlier";
export * from "./project";
export * from "./relevance";
export * from "./score";
export * from "./video-type";

/** A source with no usable provenance is dropped, never stored as anonymous. */
function hasUsableProvenance(provenance: SourceProvenance | undefined): provenance is SourceProvenance {
	if (!provenance) return false;
	if (!provenance.externalId.trim() || !provenance.sourceUrl.trim()) return false;
	return Number.isFinite(new Date(provenance.capturedAt).getTime());
}

function evidenceConfidenceFor(scored: ScoredSource): EvidenceConfidence {
	if (scored.baseline.confidence === "HIGH" && scored.outlier.maturity === "MATURE") return "HIGH";
	if (scored.baseline.confidence === "UNAVAILABLE" || scored.outlier.maturity === "PROVISIONAL") return "LOW";
	return "MEDIUM";
}

/**
 * The one-line evidence that travels with every opportunity, so the reason a
 * source was considered strong stays attached to the recommendation instead of
 * living only on a screen the reader may never open.
 */
export function evidenceSummaryFor(scored: ScoredSource): string {
	const views = typeof scored.source.views === "number" ? scored.source.views.toLocaleString("en-US") : "unknown";
	const ratio =
		typeof scored.outlier.ratio === "number"
			? `${scored.outlier.ratio.toFixed(1)}x creator baseline`
			: "no usable baseline";
	return `${scored.source.channelName} - ${views} views, ${ratio} (${scored.outlier.maturity.toLowerCase()}, baseline sample ${scored.baseline.sampleSize})`;
}

export interface ResearchRunInput {
	project: ResearchProject;
	adapter: ResearchAdapter;
	now: Date;
	/** Statements of the profile's VERIFIED facts, used to flag unsupported claims. */
	verifiedFactStatements: string[];
}

/**
 * Score one adapter result and turn what clears the gate into opportunities.
 * Nothing here performs I/O; persistence is the store's job.
 */
export async function runResearchPipeline(input: ResearchRunInput): Promise<ResearchRunOutcome> {
	const counters = emptyRunCounters();
	const failures: ResearchRunFailure[] = [];
	const occurredAt = input.now.toISOString();

	const fetched = await input.adapter.fetch({ project: input.project, now: input.now });
	counters.externalProviderCalls = fetched.externalProviderCalls;

	const provenanceById = new Map(fetched.provenance.map((entry) => [entry.externalId, entry]));
	const seen = new Set<string>();
	const accepted: { source: ResearchSource; provenance: SourceProvenance }[] = [];

	for (const source of fetched.sources) {
		counters.sourcesDiscovered += 1;
		const provenance = provenanceById.get(source.externalId);
		if (!hasUsableProvenance(provenance)) {
			failures.push({ stage: "provenance", subjectId: source.externalId, code: "MISSING_PROVENANCE", occurredAt });
			continue;
		}
		if (seen.has(source.externalId)) {
			counters.duplicateSourcesDropped += 1;
			continue;
		}
		seen.add(source.externalId);
		accepted.push({ source, provenance });
		if (source.transcript.status === "AVAILABLE") counters.transcriptsAvailable += 1;
		else counters.transcriptsUnavailable += 1;
	}

	const scored: ScoredSource[] = accepted.map(({ source, provenance }) => {
		const videoType = classifyVideoType(source.durationSeconds);
		const baseline = computeBaseline({
			targetExternalId: source.externalId,
			targetVideoType: videoType,
			targetPublishedAt: source.publishedAt,
			history: source.channelHistory.map((entry) => ({
				externalId: entry.externalId,
				videoType: classifyVideoType(entry.durationSeconds),
				publishedAt: entry.publishedAt,
				views: entry.views,
				invalid: entry.invalid,
			})),
			now: input.now,
		});
		const outlier = computeOutlier({
			views: source.views,
			baseline,
			publishedAt: source.publishedAt,
			videoType,
			now: input.now,
		});
		const relevance = computeRelevance({
			title: source.title,
			description: source.description,
			language: source.language,
			project: input.project,
			creatorPriority: source.creatorPriority,
		});
		const engagement = computeEngagement(source.views, source.likes, source.comments);
		const velocity = computeVelocity(source.snapshots);
		const score = computeCandidateScore({
			videoType,
			baseline,
			outlier,
			relevance,
			engagement,
			velocity,
			creatorPriority: source.creatorPriority,
		});
		const gate = passesQualityGate({ score, outlier, relevance, baseline });

		return {
			source,
			videoType,
			baseline,
			outlier,
			relevance,
			engagement,
			velocity,
			score,
			shortlisted: false,
			gateReasons: gate.reasons,
			provenance,
		};
	});

	counters.sourcesScored = scored.length;

	const gated = scored.filter((entry) => entry.gateReasons.length === 0);
	const shortlistedIds = new Set(
		applyQuota(
			gated.map((entry) => ({
				externalId: entry.source.externalId,
				videoType: entry.videoType,
				score: entry.score.score,
			})),
		).map((entry) => entry.externalId),
	);
	for (const entry of scored) entry.shortlisted = shortlistedIds.has(entry.source.externalId);
	counters.shortlisted = shortlistedIds.size;

	const opportunities: ResearchOpportunity[] = [];
	for (const entry of scored) {
		if (!entry.shortlisted) continue;
		const proposal = buildOpportunity(entry, input.project, input.verifiedFactStatements);
		// The anti-copy rule is the enforcement, not the proposal's own promise.
		if (
			isTooSimilarToSource(entry.source.title, proposal.proposedHook) ||
			isTooSimilarToSource(entry.source.title, proposal.proposedAngle)
		) {
			counters.opportunitiesRejectedByAntiCopy += 1;
			continue;
		}
		opportunities.push(proposal);
	}
	counters.opportunitiesProduced = opportunities.length;

	return {
		status: failures.length === 0 ? "COMPLETED" : "PARTIAL",
		pipelineVersion: RESEARCH_VERSIONS.pipeline,
		scoringVersion: RESEARCH_VERSIONS.scoring,
		baselineVersion: RESEARCH_VERSIONS.baseline,
		counters,
		failures,
		scored,
		opportunities,
	};
}

/**
 * Turn one shortlisted source into a proposal expressed in the brand's own
 * vocabulary rather than the source's. Any brand term the proposal leans on
 * that no VERIFIED fact supports is surfaced as a requirement instead of being
 * asserted.
 */
function buildOpportunity(
	scored: ScoredSource,
	project: ResearchProject,
	verifiedFactStatements: string[],
): ResearchOpportunity {
	const [firstNeed, secondNeed] = project.keywords;
	const need = firstNeed ?? project.slug;
	const supporting = verifiedFactStatements.map((statement) => statement.toLowerCase());
	const factRequirements = [need, secondNeed]
		.filter((term): term is string => typeof term === "string" && term.length > 0)
		.filter((term) => !supporting.some((statement) => statement.includes(term)))
		.map((term) => `FACT_REQUIRED: ${term}`);

	return {
		key: `${project.profileHash}:${scored.source.externalId}`,
		sourceExternalId: scored.source.externalId,
		proposedAngle: `Answer ${need} from this brand's own practice rather than restating the source`,
		proposedHook: `The part of ${need} that gets skipped`,
		contentFormat: scored.videoType === "SHORT" ? "SHORT_VIDEO" : "LONG_VIDEO",
		rationale: `The source clears the quality gate at ${scored.score.score.toFixed(2)} with ${Math.round(scored.score.weightCoverage * 100)}% weight coverage`,
		evidenceSummary: evidenceSummaryFor(scored),
		confidence: evidenceConfidenceFor(scored),
		factRequirements,
	};
}

export interface OpportunityDecisionInput {
	organizationId: string;
	brandId: string;
	opportunityId: string;
	decision: OpportunityState;
	reason?: string;
}

export interface OpportunityDecisionRef {
	id: string;
	opportunityId: string;
	decision: OpportunityState;
}

/** Decisions are recorded, never edited, so the rules are checked before the write. */
export function validateOpportunityDecision(input: OpportunityDecisionInput): void {
	if (!input.opportunityId.trim()) {
		throw new ContentResearchError("INVALID_INPUT", "An opportunity is required");
	}
	if (input.decision === "NEW") {
		throw new ContentResearchError("INVALID_INPUT", "NEW is the initial state and cannot be decided");
	}
	if (input.decision === "REJECTED" && !input.reason?.trim()) {
		throw new ContentResearchError("INVALID_INPUT", "A rejection reason is required");
	}
}

export interface ResearchRunRef {
	id: string;
	status: string;
	profileVersionId: string;
}

export interface ContentResearchModule {
	run(input: { organizationId: string; brandId: string; idempotencyKey: string }): Promise<ResearchRunRef>;
	decideOpportunity(input: OpportunityDecisionInput): Promise<OpportunityDecisionRef>;
}

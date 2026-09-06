/**
 * Transparent candidate ranking, transferred from `lib/video-radar/score.ts` at
 * `b589a811a4e1f205a784e5128283f9d227143f32`.
 *
 * This score exists to order a list, not to state a truth. So it never stores a
 * bare number: every component keeps its raw value, its weight and its
 * contribution, and the whole thing is stamped with a scoring version.
 *
 * Missing data is handled by renormalizing the weights over the components that
 * actually had data, rather than scoring the gap as zero. Scoring a hidden like
 * count as zero engagement would silently demote a source for a fact about the
 * creator's privacy settings. `weightCoverage` reports how much of the intended
 * weight was real, so a thin ranking is visible instead of implied.
 */

import { confidenceSignalValue, quotaFor, researchConfig, SCORE_COMPONENT_IDS, SCORE_COMPONENT_LABELS } from "./config";
import type {
	BaselineResult,
	CandidateScore,
	EngagementResult,
	OutlierResult,
	RelevanceResult,
	ScoreComponent,
	ScoreComponentId,
	VelocityResult,
	VideoType,
} from "./contracts";
import { RESEARCH_VERSIONS } from "./contracts";
import { engagementSignal, freshnessSignal, velocitySignal } from "./metrics";
import { outlierSignal } from "./outlier";

export interface ScoreInput {
	videoType: VideoType;
	baseline: BaselineResult;
	outlier: OutlierResult;
	relevance: RelevanceResult;
	engagement: EngagementResult;
	velocity: VelocityResult;
	/** 1..5 from a watchlist; null for a source discovered by search. */
	creatorPriority: number | null;
}

function rawSignals(input: ScoreInput): Record<ScoreComponentId, number | null> {
	const maturityFactor = researchConfig.score.maturityPenalty[input.outlier.maturity];

	return {
		outlierSignal: outlierSignal(input.outlier.ratio),
		// Confidence and maturity are one component: a high-confidence baseline on
		// a source too young to judge should not read as a trustworthy result.
		confidenceSignal: confidenceSignalValue(input.baseline.confidence) * maturityFactor,
		relevance: input.relevance.score,
		freshness: freshnessSignal(input.outlier.ageHours),
		engagement: engagementSignal(input.engagement),
		velocity: velocitySignal(input.velocity, input.videoType),
		creatorPriority:
			typeof input.creatorPriority === "number" ? Math.min(1, Math.max(0, input.creatorPriority) / 5) : null,
	};
}

export function computeCandidateScore(input: ScoreInput): CandidateScore {
	const signals = rawSignals(input);
	const weights = researchConfig.score.weights;

	const availableWeight = SCORE_COMPONENT_IDS.reduce(
		(total, id) => (signals[id] === null ? total : total + weights[id]),
		0,
	);
	const totalWeight = SCORE_COMPONENT_IDS.reduce((total, id) => total + weights[id], 0);

	const components: ScoreComponent[] = SCORE_COMPONENT_IDS.map((id) => {
		const value = signals[id];
		const available = value !== null;
		return {
			id,
			label: SCORE_COMPONENT_LABELS[id],
			value,
			weight: weights[id],
			contribution: available && availableWeight > 0 ? (weights[id] / availableWeight) * (value as number) : 0,
			available,
		};
	});

	return {
		score: components.reduce((total, component) => total + component.contribution, 0),
		components,
		scoringVersion: RESEARCH_VERSIONS.scoring,
		weightCoverage: totalWeight > 0 ? availableWeight / totalWeight : 0,
	};
}

export interface QualityGateInput {
	score: CandidateScore;
	outlier: OutlierResult;
	relevance: RelevanceResult;
	baseline: BaselineResult;
}

export interface QualityGateResult {
	passed: boolean;
	reasons: string[];
}

/**
 * Quality gate. Quotas are ceilings applied afterwards — this function never
 * lets a weak source through to fill one.
 */
export function passesQualityGate(input: QualityGateInput): QualityGateResult {
	const gate = researchConfig.qualityGate;
	const reasons: string[] = [];

	if (!input.outlier.available) {
		reasons.push("No usable outlier ratio (baseline unavailable or views missing)");
	} else if ((input.outlier.ratio as number) < gate.minOutlierRatio) {
		reasons.push(`Outlier ratio below ${gate.minOutlierRatio}x`);
	}

	if (!(gate.allowedBaselineConfidence as readonly string[]).includes(input.baseline.confidence)) {
		reasons.push(`Baseline confidence '${input.baseline.confidence}' is not accepted`);
	}
	if (input.relevance.score < gate.minRelevance) reasons.push(`Relevance below ${gate.minRelevance}`);
	if (input.score.score < gate.minCandidateScore) reasons.push(`Candidate score below ${gate.minCandidateScore}`);

	return { passed: reasons.length === 0, reasons };
}

export interface ShortlistCandidate {
	externalId: string;
	videoType: VideoType;
	score: number;
}

/**
 * Apply per-type quota ceilings to an already gated list. Returns whatever
 * cleared the gate, capped — never padded.
 */
export function applyQuota<T extends ShortlistCandidate>(candidates: T[]): T[] {
	// Ties are broken on the external id so a run is reproducible regardless of
	// the order the adapter happened to return.
	const ordered = [...candidates].sort((a, b) => b.score - a.score || a.externalId.localeCompare(b.externalId));
	const used = { SHORT: 0, LONG: 0 };
	const kept: T[] = [];

	for (const candidate of ordered) {
		// `UNKNOWN` shares the long-form ceiling rather than getting a third bucket.
		const bucket = candidate.videoType === "SHORT" ? "SHORT" : "LONG";
		if (used[bucket] >= quotaFor(candidate.videoType)) continue;
		used[bucket] += 1;
		kept.push(candidate);
	}

	return kept;
}

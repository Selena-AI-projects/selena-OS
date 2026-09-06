/**
 * Every research threshold in one place, transferred from
 * `data/video-radar/scoring.v1.json` at
 * `b589a811a4e1f205a784e5128283f9d227143f32`.
 *
 * Values stay data rather than inline literals so the numbers behind a stored
 * score remain traceable to a version string. Nothing here reads the
 * environment: this is tuning, not enablement.
 *
 * Modification: expressed as a frozen module constant rather than a JSON import,
 * because the workspace TypeScript configuration does not resolve JSON modules.
 */

import type { BaselineConfidence, OutlierBand, ScoreComponentId, VideoType } from "./contracts";

export const researchConfig = {
	videoType: {
		/** YouTube Shorts are capped at 180s. Unknown duration stays UNKNOWN. */
		shortMaxDurationSeconds: 180,
	},
	baseline: {
		targetSampleSize: 20,
		minStabilizationHours: 72,
		/**
		 * Keeps the comparison inside one era. A channel's audience this year is
		 * not the audience it had five years ago, so dividing an old source's
		 * views by today's median is arithmetic, not a baseline.
		 */
		maxComparisonAgeDays: 365,
		confidence: { highMinSample: 15, mediumMinSample: 8, lowMinSample: 4 },
	},
	maturity: {
		minAgeHoursByType: { SHORT: 72, LONG: 168, UNKNOWN: 168 },
	},
	outlier: {
		bands: [
			{ id: "NORMAL", minRatio: 0 },
			{ id: "INTERESTING", minRatio: 1.5 },
			{ id: "STRONG", minRatio: 2 },
			{ id: "MAJOR", minRatio: 5 },
			{ id: "EXCEPTIONAL", minRatio: 10 },
		],
		referenceRatioForFullSignal: 10,
	},
	score: {
		weights: {
			outlierSignal: 0.34,
			confidenceSignal: 0.16,
			relevance: 0.24,
			freshness: 0.1,
			engagement: 0.06,
			velocity: 0.06,
			creatorPriority: 0.04,
		},
		freshnessHalfLifeDays: 21,
		engagement: { referenceLikeRate: 0.06, referenceCommentRate: 0.005 },
		velocity: { referenceViewsPerHourByType: { SHORT: 2000, LONG: 500, UNKNOWN: 500 } },
		confidenceSignalValues: { HIGH: 1, MEDIUM: 0.7, LOW: 0.4, UNAVAILABLE: 0 },
		maturityPenalty: { MATURE: 1, PROVISIONAL: 0.75 },
	},
	qualityGate: {
		minCandidateScore: 0.42,
		minOutlierRatio: 1.5,
		minRelevance: 0.35,
		allowedBaselineConfidence: ["HIGH", "MEDIUM", "LOW"],
		/** Ceilings, never targets. If only 17 shorts clear the gate, 17 are returned. */
		quota: { short: 50, long: 20 },
	},
	relevance: {
		weights: { keyword: 0.6, languageMatch: 0.2, creatorPriority: 0.2 },
		negativeKeywordPenalty: 0.6,
		titleMatchBonus: 0.15,
	},
} as const;

export const SCORE_COMPONENT_IDS = [
	"outlierSignal",
	"confidenceSignal",
	"relevance",
	"freshness",
	"engagement",
	"velocity",
	"creatorPriority",
] as const satisfies readonly ScoreComponentId[];

export const SCORE_COMPONENT_LABELS: Record<ScoreComponentId, string> = {
	outlierSignal: "Outlier vs creator baseline",
	confidenceSignal: "Baseline confidence and maturity",
	relevance: "Brand relevance",
	freshness: "Freshness",
	engagement: "Engagement rates",
	velocity: "Measured velocity",
	creatorPriority: "Creator priority",
};

export function minMaturityAgeHours(videoType: VideoType): number {
	return researchConfig.maturity.minAgeHoursByType[videoType];
}

export function velocityReference(videoType: VideoType): number {
	return researchConfig.score.velocity.referenceViewsPerHourByType[videoType];
}

export function confidenceSignalValue(confidence: BaselineConfidence): number {
	return researchConfig.score.confidenceSignalValues[confidence];
}

/**
 * Quota ceiling for a video type. `UNKNOWN` deliberately has no ceiling of its
 * own — an unclassified source shares the long-form ceiling rather than creating
 * a third bucket nobody reviews.
 */
export function quotaFor(videoType: VideoType): number {
	return videoType === "SHORT" ? researchConfig.qualityGate.quota.short : researchConfig.qualityGate.quota.long;
}

export function outlierBandFor(ratio: number): OutlierBand {
	let band: OutlierBand = researchConfig.outlier.bands[0].id;
	for (const candidate of researchConfig.outlier.bands) {
		if (ratio >= candidate.minRatio) band = candidate.id;
	}
	return band;
}

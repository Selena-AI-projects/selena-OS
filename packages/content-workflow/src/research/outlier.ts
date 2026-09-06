/**
 * Outlier ratio and maturity, transferred from `lib/video-radar/outlier.ts` at
 * `b589a811a4e1f205a784e5128283f9d227143f32`.
 *
 * ratio = source views / comparable channel baseline views.
 *
 * Subscriber count is deliberately not the denominator. A creator's own recent
 * comparable performance is the honest reference; views per subscriber mostly
 * measures how long a channel has existed.
 */

import { minMaturityAgeHours, outlierBandFor, researchConfig } from "./config";
import type { BaselineResult, OutlierMaturity, OutlierResult, VideoType } from "./contracts";

export interface OutlierInput {
	views: number | null;
	baseline: BaselineResult;
	publishedAt: string;
	videoType: VideoType;
	now: Date;
}

export function ageHoursSince(publishedAt: string, now: Date): number {
	const published = new Date(publishedAt).getTime();
	if (!Number.isFinite(published)) return 0;
	return Math.max(0, (now.getTime() - published) / 3_600_000);
}

/**
 * A young source has had less exposure time than the mature totals it is being
 * compared against, so its ratio understates performance and cannot carry the
 * same confidence. It stays `PROVISIONAL` until it passes a configured minimum
 * age for its type.
 */
export function outlierMaturityFor(publishedAt: string, videoType: VideoType, now: Date): OutlierMaturity {
	return ageHoursSince(publishedAt, now) >= minMaturityAgeHours(videoType) ? "MATURE" : "PROVISIONAL";
}

export function computeOutlier(input: OutlierInput): OutlierResult {
	const maturity = outlierMaturityFor(input.publishedAt, input.videoType, input.now);
	const ageHours = ageHoursSince(input.publishedAt, input.now);
	const baselineViews = input.baseline.baselineViews;

	const unavailable: OutlierResult = { ratio: null, band: "UNAVAILABLE", maturity, ageHours, available: false };

	if (input.baseline.confidence === "UNAVAILABLE") return unavailable;
	if (typeof input.views !== "number" || !Number.isFinite(input.views) || input.views < 0) return unavailable;
	// Guard the division explicitly. A creator whose comparable median is 0 gives
	// no reference point at all, and Infinity here would rank a 3-view source top.
	if (typeof baselineViews !== "number" || !Number.isFinite(baselineViews) || baselineViews <= 0) return unavailable;

	const ratio = input.views / baselineViews;
	return { ratio, band: outlierBandFor(ratio), maturity, ageHours, available: true };
}

/** Normalize a ratio to 0..1 for ranking. Log-scaled so 20x does not swamp every other signal. */
export function outlierSignal(ratio: number | null): number | null {
	if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio <= 0) return null;
	const signal = Math.log(ratio) / Math.log(researchConfig.outlier.referenceRatioForFullSignal);
	return Math.min(1, Math.max(0, signal));
}

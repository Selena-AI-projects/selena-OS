/**
 * Velocity and engagement, transferred from `lib/video-radar/metrics.ts` at
 * `b589a811a4e1f205a784e5128283f9d227143f32`.
 *
 * Two rules drive this module:
 *
 * 1. Velocity requires two or more real snapshots. `current views / age` is not
 *    a measurement — it is an average over a window nobody observed, and it
 *    systematically flatters old sources. Without snapshots the answer is
 *    `UNAVAILABLE`, which is a usable fact; an invented number is not.
 * 2. Hidden or missing counts are null, never zero. A platform that lets a
 *    creator hide likes would otherwise rank that source as the worst
 *    performing one on the list.
 */

import { researchConfig, velocityReference } from "./config";
import type { EngagementResult, MetricSnapshot, VelocityResult, VideoType } from "./contracts";

export function computeVelocity(snapshots: MetricSnapshot[]): VelocityResult {
	const usable = snapshots
		.filter(
			(snapshot) =>
				typeof snapshot.views === "number" &&
				Number.isFinite(snapshot.views) &&
				Number.isFinite(new Date(snapshot.capturedAt).getTime()),
		)
		.sort((a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime());

	if (usable.length < 2) {
		return { status: "UNAVAILABLE", viewsPerHour: null, windowHours: null, snapshotCount: usable.length };
	}

	const first = usable[0];
	const last = usable[usable.length - 1];
	const windowHours = (new Date(last.capturedAt).getTime() - new Date(first.capturedAt).getTime()) / 3_600_000;

	// Two snapshots captured in the same instant (a double-invoked job, say) give
	// no window to divide by.
	if (!(windowHours > 0)) {
		return { status: "UNAVAILABLE", viewsPerHour: null, windowHours: null, snapshotCount: usable.length };
	}

	const delta = (last.views as number) - (first.views as number);
	return {
		status: "MEASURED",
		// Counts can go down when a platform re-audits views; a negative rate is
		// not meaningful, but the measurement is still real, so clamp rather than
		// discard.
		viewsPerHour: Math.max(0, delta / windowHours),
		windowHours,
		snapshotCount: usable.length,
	};
}

export function computeEngagement(
	views: number | null,
	likes: number | null,
	comments: number | null,
): EngagementResult {
	const hasViews = typeof views === "number" && Number.isFinite(views) && views > 0;
	if (!hasViews) return { likeRate: null, commentRate: null };

	const rate = (value: number | null) =>
		typeof value === "number" && Number.isFinite(value) && value >= 0 ? value / (views as number) : null;

	return { likeRate: rate(likes), commentRate: rate(comments) };
}

/**
 * Normalize engagement to 0..1 for ranking, or null when neither rate is known.
 * Capped at the configured reference so an unusual comment ratio cannot
 * dominate — platforms expose these signals inconsistently.
 */
export function engagementSignal(engagement: EngagementResult): number | null {
	const { referenceLikeRate, referenceCommentRate } = researchConfig.score.engagement;
	const parts: number[] = [];

	if (typeof engagement.likeRate === "number") parts.push(Math.min(1, engagement.likeRate / referenceLikeRate));
	if (typeof engagement.commentRate === "number")
		parts.push(Math.min(1, engagement.commentRate / referenceCommentRate));
	if (parts.length === 0) return null;

	return parts.reduce((sum, value) => sum + value, 0) / parts.length;
}

export function velocitySignal(velocity: VelocityResult, videoType: VideoType): number | null {
	if (velocity.status !== "MEASURED" || typeof velocity.viewsPerHour !== "number") return null;
	return Math.min(1, velocity.viewsPerHour / velocityReference(videoType));
}

/** Exponential decay so recent work outranks equally strong older work. */
export function freshnessSignal(ageHours: number): number {
	const halfLifeHours = researchConfig.score.freshnessHalfLifeDays * 24;
	return Math.min(1, Math.max(0, 0.5 ** (ageHours / halfLifeHours)));
}

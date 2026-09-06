/**
 * Short / long classification, transferred from `lib/video-radar/videoType.ts`
 * at `b589a811a4e1f205a784e5128283f9d227143f32`.
 *
 * This is the only place allowed to reason about duration thresholds.
 * Scattering `duration < 60` checks across the pipeline is how a short silently
 * ends up compared against long-form baselines, which produces a confident
 * wrong answer rather than a missing one.
 */

import { researchConfig } from "./config";
import type { VideoType } from "./contracts";

/**
 * ISO 8601 duration as returned by the YouTube Data API (`PT1M30S`). Returns
 * null for anything unparseable — callers must treat that as unknown, never as
 * zero.
 */
export function parseIsoDurationSeconds(iso: unknown): number | null {
	if (typeof iso !== "string") return null;
	const match = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso.trim());
	if (!match) return null;

	const [, days, hours, minutes, seconds] = match;
	if (!days && !hours && !minutes && !seconds) return null;

	const total =
		Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0);

	return Number.isFinite(total) ? total : null;
}

/**
 * Classify by duration. A missing, non-finite or non-positive duration yields
 * `UNKNOWN` rather than a guess.
 *
 * `isShortsUrl` is a corroborating signal only: it can promote an
 * unknown-duration source to `SHORT`, but never overrides a duration that says
 * otherwise, because a long video served on a shorts URL should stay comparable
 * to long-form.
 */
export function classifyVideoType(durationSeconds: number | null | undefined, isShortsUrl = false): VideoType {
	if (typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
		return isShortsUrl ? "SHORT" : "UNKNOWN";
	}
	return durationSeconds <= researchConfig.videoType.shortMaxDurationSeconds ? "SHORT" : "LONG";
}

/**
 * Whether two sources may be compared for baseline purposes. `UNKNOWN` only
 * ever matches `UNKNOWN`, so an unclassified source is compared with equally
 * unclassified peers or not at all.
 */
export function isComparableType(a: VideoType, b: VideoType): boolean {
	return a === b;
}

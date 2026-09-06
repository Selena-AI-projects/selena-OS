/**
 * Cheap relevance filtering, transferred from `lib/video-radar/relevance.ts` at
 * `b589a811a4e1f205a784e5128283f9d227143f32`.
 *
 * This runs on the whole discovery pool, so it stays pure string work — no
 * network, no model. Its job is to stop popularity alone from dominating and to
 * cut the pool down before anything expensive happens.
 *
 * Modification: upstream scored a source against a shared topic table and a
 * global project registry. Here there is exactly one project, derived from the
 * brand's confirmed profile, so a run can never be scored against another
 * brand's vocabulary.
 */

import { researchConfig } from "./config";
import type { RelevanceResult, ResearchProject } from "./contracts";

export interface RelevanceInput {
	title: string;
	description: string;
	language: string | null;
	project: ResearchProject;
	creatorPriority: number | null;
}

function normalize(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ");
}

function containsKeyword(haystack: string, keyword: string): boolean {
	const needle = keyword.toLowerCase().trim();
	if (!needle) return false;
	// Word-boundary match for single tokens so "ai" does not match "chair";
	// multi-word keywords are matched as phrases.
	if (/^[a-z0-9]+$/i.test(needle)) {
		return new RegExp(`(^|[^a-z0-9])${needle}([^a-z0-9]|$)`, "i").test(haystack);
	}
	return haystack.includes(needle);
}

export function computeRelevance(input: RelevanceInput): RelevanceResult {
	const title = normalize(input.title ?? "");
	const haystack = `${title} ${normalize(input.description ?? "")}`;
	const weights = researchConfig.relevance.weights;

	const blockedByNegativeKeyword = input.project.negativeKeywords.some((keyword) => containsKeyword(haystack, keyword));

	const matchedKeywords = input.project.keywords.filter((keyword) => containsKeyword(haystack, keyword));
	const titleHit = matchedKeywords.some((keyword) => containsKeyword(title, keyword));
	const keywordSignal = Math.min(1, matchedKeywords.length / 2);

	// An undetected language neither helps nor penalizes: half credit, because
	// "we could not detect it" is not evidence the source is in the wrong one.
	const languageMatched = input.language !== null && input.project.languages.includes(input.language);
	const languageSignal =
		input.language === null ? 0.5 : input.project.languages.length === 0 ? 1 : languageMatched ? 1 : 0;

	const creatorSignal =
		typeof input.creatorPriority === "number" ? Math.min(1, Math.max(0, input.creatorPriority) / 5) : 0;

	let score =
		keywordSignal * weights.keyword + languageSignal * weights.languageMatch + creatorSignal * weights.creatorPriority;

	if (titleHit) score += researchConfig.relevance.titleMatchBonus;
	if (blockedByNegativeKeyword) score *= 1 - researchConfig.relevance.negativeKeywordPenalty;

	return {
		score: Math.min(1, Math.max(0, score)),
		matchedKeywords,
		languageMatched,
		blockedByNegativeKeyword,
	};
}

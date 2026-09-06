/**
 * Anti-copy enforcement, transferred from `lib/video-radar/opportunities.ts` at
 * `b589a811a4e1f205a784e5128283f9d227143f32`.
 *
 * An adapter is asked to adapt the mechanic rather than the content, but a
 * request is not a guarantee. This module is the enforcement: adaptations that
 * stay too close to the source are dropped before they can become an
 * opportunity.
 */

/** Words too common to carry any signal about copying. */
const STOPWORDS = new Set([
	"the",
	"a",
	"an",
	"and",
	"or",
	"but",
	"of",
	"to",
	"in",
	"on",
	"for",
	"with",
	"at",
	"by",
	"from",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"it",
	"this",
	"that",
	"my",
	"your",
	"i",
	"we",
	"you",
	"how",
	"what",
	"why",
	"can",
	"do",
	"does",
	"did",
	"will",
	"would",
	"should",
]);

export function contentTokens(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/)
		.filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

/**
 * Jaccard overlap of content words. Deliberately blunt: it catches the failure
 * mode that matters here — a near-identical title with the nouns replaced —
 * which leaves most of the original wording intact. It is not, and does not
 * claim to be, a plagiarism detector.
 */
export function similarityRatio(a: string, b: string): number {
	const left = new Set(contentTokens(a));
	const right = new Set(contentTokens(b));
	if (left.size === 0 || right.size === 0) return 0;

	let shared = 0;
	for (const token of left) if (right.has(token)) shared += 1;
	return shared / (left.size + right.size - shared);
}

export const MAX_SOURCE_SIMILARITY = 0.5;

export function isTooSimilarToSource(sourceTitle: string, proposed: string): boolean {
	return similarityRatio(sourceTitle, proposed) > MAX_SOURCE_SIMILARITY;
}

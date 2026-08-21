import type { RunMeasurement } from "@workspace/selena-visibility-contracts";

/**
 * Deterministic extraction of one Evidence Ledger row from a provider answer.
 *
 * Pure string work on purpose: the same answer and context always produce the
 * same measurement, so every stored row can be re-derived from its raw
 * response and checked. No model is consulted — §6.10 lets an LLM explain and
 * group findings, never create them, and a mention that only an LLM can see is
 * not evidence a client can verify.
 *
 * factualErrors is always empty here for the same reason: string matching can
 * establish presence, not truth. Fact checking is a separate grounded stage
 * with its own provenance, not a by-product of extraction.
 */

export type ExtractionContext = {
	/** The brand name and every approved spelling variant (§6.1). */
	brandTerms: string[];
	/** Approved brand domains; a citation on one of these is an owned citation. */
	ownedDomains: string[];
	/** Each competitor with the spellings that count as seeing it. */
	competitors: { name: string; terms: string[] }[];
	language: string;
	region?: string;
};

export type ExtractionInput = {
	answerText: string;
	sources: { url: string; domain: string }[];
	system: string;
	model?: string;
	context: ExtractionContext;
};

// Combining marks count as word material: "кора" inside a combining-accented
// longer word is still inside that word, not a boundary hit.
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;

/** The full code point ending at index - 1, surrogate pairs included. */
function codePointBefore(text: string, index: number): string {
	if (index <= 0) return "";
	const unit = text.charCodeAt(index - 1);
	// A low surrogate means the code point started one unit earlier; reading
	// the lone unit would fail the word-char test and invent a boundary.
	if (unit >= 0xdc00 && unit <= 0xdfff && index >= 2) return text.slice(index - 2, index);
	return text[index - 1];
}

/** The full code point starting at index, surrogate pairs included. */
function codePointAt(text: string, index: number): string {
	if (index >= text.length) return "";
	const point = text.codePointAt(index);
	return point === undefined ? "" : String.fromCodePoint(point);
}

/**
 * Whether `term` appears in `text` as a whole word or phrase. Case-insensitive
 * and Unicode-aware, so Cyrillic brand names get the same boundary treatment
 * as Latin ones; a bare substring match would count "Kora" inside "Korall".
 */
export function containsTerm(text: string, term: string): boolean {
	const needle = term.trim().toLowerCase();
	if (needle === "") return false;
	const haystack = text.toLowerCase();
	let from = 0;
	for (;;) {
		const at = haystack.indexOf(needle, from);
		if (at === -1) return false;
		const before = codePointBefore(haystack, at);
		const after = codePointAt(haystack, at + needle.length);
		const isWordChar = (ch: string) => ch !== "" && WORD_CHAR.test(ch);
		if (!isWordChar(before) && !isWordChar(after)) return true;
		from = at + 1;
	}
}

function matchesAny(text: string, terms: string[]): boolean {
	return terms.some((term) => containsTerm(text, term));
}

/**
 * The enumerated recommendations of an answer, in presentation order.
 * Numbered items are trusted over bullets: when both exist the numbers are
 * the ranking and the bullets are prose structure.
 */
export function recommendationItems(answerText: string): string[] {
	const lines = answerText.split("\n");
	const numbered: string[] = [];
	const bulleted: string[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		const numberedMatch = /^\d{1,3}[.)]\s+(.*)$/.exec(trimmed);
		if (numberedMatch) {
			numbered.push(numberedMatch[1]);
			continue;
		}
		const bulletMatch = /^[-•*]\s+(.*)$/.exec(trimmed);
		if (bulletMatch) bulleted.push(bulletMatch[1]);
	}
	return numbered.length > 0 ? numbered : bulleted;
}

function normalizeDomain(domain: string): string {
	return domain
		.trim()
		.toLowerCase()
		.replace(/^www\./, "");
}

/** Whether `domain` is an owned domain or a subdomain of one. */
export function isOwnedDomain(domain: string, ownedDomains: string[]): boolean {
	const candidate = normalizeDomain(domain);
	if (candidate === "") return false;
	return ownedDomains.some((owned) => {
		const base = normalizeDomain(owned);
		return base !== "" && (candidate === base || candidate.endsWith(`.${base}`));
	});
}

export function extractMeasurement(input: ExtractionInput): RunMeasurement {
	const { answerText, sources, system, model, context } = input;

	const mention = matchesAny(answerText, context.brandTerms);

	// Position exists only where the answer itself ranks options: the 1-based
	// index of the first enumerated item naming the brand. A brand that appears
	// only in prose is mentioned but unranked — position stays null rather than
	// being invented from word order.
	let position: number | null = null;
	if (mention) {
		const items = recommendationItems(answerText);
		const index = items.findIndex((item) => matchesAny(item, context.brandTerms));
		if (index >= 0) position = index + 1;
	}

	const seenUrls = new Set<string>();
	const citations: { url: string; domain: string }[] = [];
	for (const source of sources) {
		const url = source.url.trim();
		const domain = normalizeDomain(source.domain);
		if (url === "" || domain === "" || seenUrls.has(url)) continue;
		seenUrls.add(url);
		citations.push({ url, domain });
	}

	const competitors = context.competitors
		.filter((competitor) => matchesAny(answerText, competitor.terms.length > 0 ? competitor.terms : [competitor.name]))
		.map((competitor) => competitor.name);

	return {
		system,
		...(model === undefined ? {} : { model }),
		language: context.language,
		...(context.region === undefined ? {} : { region: context.region }),
		mention,
		position,
		ownedCitation: citations.some((citation) => isOwnedDomain(citation.domain, context.ownedDomains)),
		citations,
		competitors,
		factualErrors: [],
	};
}

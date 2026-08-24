// Reads a retained AI answer and reports what is in it: who was named, in what
// order, and which sources the answer leaned on.
//
// Pure by construction — no storage, no network, no clock. An analysis that
// cannot be re-run over the same text on demand is not evidence, and keeping
// this module free of I/O is what makes recomputation cheap enough to be the
// reason the text is retained at all.

export type AnalysisSubject = {
	/** The name as the customer configured it; reported back unchanged. */
	name: string;
	/** Spellings that mean the same business — "KORA", "Kora Food Hall". */
	aliases?: readonly string[];
	/** Used to tell the customer's own site apart from a third-party source. */
	domain?: string;
};

export type MentionRole = "TARGET" | "COMPETITOR";

export type AnswerMention = {
	name: string;
	role: MentionRole;
	/** Character offset of the first occurrence; the ordering basis. */
	firstIndex: number;
	/** 1-based position among everyone named in this answer. */
	order: number;
};

export type AnswerAnalysis = {
	brandMentioned: boolean;
	/** Where the brand stood among everyone named, or null when absent. */
	brandOrder: number | null;
	mentions: AnswerMention[];
	/** Hosts the answer leaned on, lowercased and de-duplicated. */
	citedDomains: string[];
};

export type CitationGapEntry = {
	domain: string;
	timesCited: number;
	/** Citations in answers that named a competitor but not the brand. */
	timesCitedWithoutBrand: number;
	/** True when the domain is the brand's own site. */
	ownedByBrand: boolean;
};

export type CompetitorStanding = {
	name: string;
	answersMentioned: number;
	/** Mean position among named businesses, over answers naming it. */
	averageOrder: number;
};

export type ScenarioSetSummary = {
	answersAnalyzed: number;
	/**
	 * Share of analyzed answers naming the brand, and share of all mentions
	 * belonging to the brand. Both are null when nothing was analyzed: an empty
	 * set is UNKNOWN, never a confident zero.
	 */
	brandMentionRate: number | null;
	brandShareOfVoice: number | null;
	brandAverageOrder: number | null;
	competitors: CompetitorStanding[];
	citationGap: CitationGapEntry[];
};

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/gi;
// A bare host only counts with a known-looking TLD, so "т.е." and version
// numbers do not become sources. The trailing edge stops at a sentence period
// rather than rejecting the match: a source is routinely the last word of a
// sentence, and requiring no period after it would drop most of them.
const BARE_HOST_PATTERN = /(?<![@\w.])((?:[a-z0-9-]+\.)+[a-z]{2,})(?![\w-])/gi;

function escapeForRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether the character at an edge of a match is part of a word.
 *
 * `\b` is defined over ASCII word characters, so it fires in the middle of any
 * Cyrillic name — this project measures Russian answers, so boundaries are
 * checked explicitly instead.
 */
function isWordCharacter(character: string | undefined): boolean {
	if (character === undefined) return false;
	return /[\p{L}\p{N}_]/u.test(character);
}

/** Whether the needle occurs as a standalone word — the same boundary rule mentions use. */
export function hasStandaloneMention(haystack: string, needle: string): boolean {
	return firstStandaloneIndex(haystack, needle) >= 0;
}

function firstStandaloneIndex(haystack: string, needle: string): number {
	if (needle.trim() === "") return -1;
	const pattern = new RegExp(escapeForRegex(needle.trim()), "giu");
	for (const match of haystack.matchAll(pattern)) {
		const start = match.index ?? 0;
		const end = start + match[0].length;
		if (!isWordCharacter(haystack[start - 1]) && !isWordCharacter(haystack[end])) return start;
	}
	return -1;
}

function earliestIndexFor(text: string, subject: AnalysisSubject): number {
	const candidates = [subject.name, ...(subject.aliases ?? [])]
		.map((candidate) => firstStandaloneIndex(text, candidate))
		.filter((index) => index >= 0);
	return candidates.length === 0 ? -1 : Math.min(...candidates);
}

export function normalizeDomain(value: string): string {
	const trimmed = value.trim().toLowerCase();
	const withoutScheme = trimmed.replace(/^https?:\/\//, "");
	const host = withoutScheme.split(/[/?#]/)[0] ?? "";
	return host.replace(/^www\./, "").replace(/[.,;:]+$/, "");
}

/**
 * Hosts an answer leaned on: the ones the provider reported, plus links and
 * bare hostnames written into the text itself. Models routinely name a source
 * without linking it, and a source named but not linked is still the place the
 * answer came from.
 */
export function extractCitedDomains(text: string, providerUrls: readonly string[] = []): string[] {
	const domains = new Set<string>();
	for (const url of providerUrls) {
		const domain = normalizeDomain(url);
		if (domain !== "") domains.add(domain);
	}
	for (const match of text.matchAll(URL_PATTERN)) domains.add(normalizeDomain(match[0]));
	for (const match of text.matchAll(BARE_HOST_PATTERN)) domains.add(normalizeDomain(match[1] ?? ""));
	domains.delete("");
	return [...domains].sort();
}

export function analyzeAnswer(input: {
	text: string;
	brand: AnalysisSubject;
	competitors?: readonly AnalysisSubject[];
	citedUrls?: readonly string[];
}): AnswerAnalysis {
	const found: { subject: AnalysisSubject; role: MentionRole; firstIndex: number }[] = [];
	const brandIndex = earliestIndexFor(input.text, input.brand);
	if (brandIndex >= 0) found.push({ subject: input.brand, role: "TARGET", firstIndex: brandIndex });
	for (const competitor of input.competitors ?? []) {
		const index = earliestIndexFor(input.text, competitor);
		if (index >= 0) found.push({ subject: competitor, role: "COMPETITOR", firstIndex: index });
	}
	found.sort((left, right) => left.firstIndex - right.firstIndex);
	const mentions: AnswerMention[] = found.map((entry, position) => ({
		name: entry.subject.name,
		role: entry.role,
		firstIndex: entry.firstIndex,
		order: position + 1,
	}));
	const brandMention = mentions.find((mention) => mention.role === "TARGET") ?? null;
	return {
		brandMentioned: brandMention !== null,
		brandOrder: brandMention?.order ?? null,
		mentions,
		citedDomains: extractCitedDomains(input.text, input.citedUrls ?? []),
	};
}

function mean(values: number[]): number {
	return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * Roll a set of analyzed answers up into the numbers a report shows.
 *
 * The citation gap is the actionable half: domains the answers leaned on while
 * the brand was absent are exactly the places worth being present in, and they
 * are observed rather than inferred.
 */
export function summarizeScenarioSet(
	analyses: readonly AnswerAnalysis[],
	options: { brandDomain?: string } = {},
): ScenarioSetSummary {
	if (analyses.length === 0)
		return {
			answersAnalyzed: 0,
			brandMentionRate: null,
			brandShareOfVoice: null,
			brandAverageOrder: null,
			competitors: [],
			citationGap: [],
		};

	const brandDomain = options.brandDomain ? normalizeDomain(options.brandDomain) : null;
	const withBrand = analyses.filter((analysis) => analysis.brandMentioned);
	const totalMentions = analyses.reduce((total, analysis) => total + analysis.mentions.length, 0);

	const competitorRuns = new Map<string, number[]>();
	for (const analysis of analyses)
		for (const mention of analysis.mentions) {
			if (mention.role !== "COMPETITOR") continue;
			const orders = competitorRuns.get(mention.name) ?? [];
			orders.push(mention.order);
			competitorRuns.set(mention.name, orders);
		}

	const citations = new Map<string, { timesCited: number; timesCitedWithoutBrand: number }>();
	for (const analysis of analyses) {
		const competitorPresent = analysis.mentions.some((mention) => mention.role === "COMPETITOR");
		for (const domain of analysis.citedDomains) {
			const entry = citations.get(domain) ?? { timesCited: 0, timesCitedWithoutBrand: 0 };
			entry.timesCited += 1;
			if (!analysis.brandMentioned && competitorPresent) entry.timesCitedWithoutBrand += 1;
			citations.set(domain, entry);
		}
	}

	return {
		answersAnalyzed: analyses.length,
		brandMentionRate: withBrand.length / analyses.length,
		// No mentions at all leaves share of voice undefined rather than zero:
		// nobody was named, so no share was taken from the brand.
		brandShareOfVoice: totalMentions === 0 ? null : withBrand.length / totalMentions,
		brandAverageOrder:
			withBrand.length === 0 ? null : mean(withBrand.map((analysis) => analysis.brandOrder as number)),
		competitors: [...competitorRuns.entries()]
			.map(([name, orders]) => ({
				name,
				answersMentioned: orders.length,
				averageOrder: mean(orders),
			}))
			.sort((left, right) => right.answersMentioned - left.answersMentioned || left.averageOrder - right.averageOrder),
		citationGap: [...citations.entries()]
			.map(([domain, counts]) => ({
				domain,
				timesCited: counts.timesCited,
				timesCitedWithoutBrand: counts.timesCitedWithoutBrand,
				ownedByBrand: brandDomain !== null && domain === brandDomain,
			}))
			.sort(
				(left, right) =>
					right.timesCitedWithoutBrand - left.timesCitedWithoutBrand ||
					right.timesCited - left.timesCited ||
					left.domain.localeCompare(right.domain),
			),
	};
}

import type { LedgerMention, LedgerRow } from "./selena-ledger-metrics";

/**
 * Citation Gap and the Source Opportunity Map (addendum §3.5, §3.6, §6.4, §8).
 *
 * A gap is a checkable situation, not an inference: inside one locked scope a
 * source turns up in answers that name approved competitors and never in an
 * answer that names the brand. What the system observed is which sources an
 * answer cited and which entities that answer named — it never fetched the
 * source, so nothing here claims the source itself links to anyone. The
 * counters are counts of runs, and the wording of every field below says so.
 *
 * Pure: rows and mentions in, sources out. The formula is versioned because
 * §5.4 stores its results, and a stored number is only reproducible next to
 * the rule that produced it.
 */

export const CITATION_GAP_FORMULA_VERSION = "selena-citation-gap/1";

export type CitationGapType = "COMPETITOR_ONLY_SOURCE";
export type PriorityBand = "LOW" | "MEDIUM" | "HIGH";

export type CitationSource = {
	domain: string;
	/** Every distinct page of this source that was cited, in first-seen order. */
	urls: string[];
	/** Runs citing this source whose answer named the brand. */
	ownedCitationCount: number;
	/** Runs citing this source whose answer named at least one approved competitor. */
	competitorCitationCount: number;
	/** The approved competitors those answers named. */
	competitorNames: string[];
	scenarioCount: number;
	engineCount: number;
	/** The runs this source was seen in — §8 requires a recommendation to point at evidence. */
	evidenceRunIds: string[];
	firstSeen: Date | null;
	lastSeen: Date | null;
	/**
	 * How reliably the source comes back: averaged over the scenario × system
	 * groups where it appeared at all, the share of that group's repeats citing
	 * it. A source seen once out of three repeats is not the same finding as one
	 * cited every time.
	 */
	repeatStability: number | null;
	gapType: CitationGapType | null;
	priorityBand: PriorityBand;
};

export type CitationGapReport = {
	formulaVersion: string;
	/** Runs the report was computed over: VALID, measured, and nothing else. */
	measuredRuns: number;
	sources: CitationSource[];
	gaps: CitationSource[];
};

type ParsedCitation = { url: string; domain: string };

function normalizeDomain(domain: string): string {
	return domain
		.trim()
		.toLowerCase()
		.replace(/^www\./, "");
}

function parseCitations(value: unknown): ParsedCitation[] {
	if (!Array.isArray(value)) return [];
	const parsed: ParsedCitation[] = [];
	for (const item of value) {
		if (typeof item !== "object" || item === null) continue;
		const { url, domain } = item as { url?: unknown; domain?: unknown };
		if (typeof url !== "string" || typeof domain !== "string") continue;
		const host = normalizeDomain(domain);
		if (url.trim() === "" || host === "") continue;
		parsed.push({ url: url.trim(), domain: host });
	}
	return parsed;
}

function isOwned(domain: string, ownedDomains: string[]): boolean {
	return ownedDomains.some((owned) => {
		const base = normalizeDomain(owned);
		return base !== "" && (domain === base || domain.endsWith(`.${base}`));
	});
}

/**
 * §6.4 raises priority on transparent signals only: the source spans several
 * scenarios, several AI systems, or several approved competitors. The fourth
 * signal in the spec — the gap repeating across cycles — needs more than one
 * cycle's evidence and is therefore not decided here.
 */
function priorityBandFor(source: {
	scenarioCount: number;
	engineCount: number;
	competitorNames: string[];
}): PriorityBand {
	const signals = [source.scenarioCount > 1, source.engineCount > 1, source.competitorNames.length > 1].filter(
		Boolean,
	).length;
	if (signals >= 3) return "HIGH";
	return signals === 2 ? "MEDIUM" : "LOW";
}

type Accumulator = {
	domain: string;
	urls: string[];
	runIds: Set<string>;
	brandRuns: Set<string>;
	competitorRuns: Set<string>;
	competitorNames: Set<string>;
	scenarios: Set<string>;
	engines: Set<string>;
	groups: Set<string>;
	firstSeen: Date | null;
	lastSeen: Date | null;
};

export function computeCitationGaps(input: {
	rows: LedgerRow[];
	mentions: LedgerMention[];
	/** The brand's own domains: its own pages are not an opportunity to be cited elsewhere. */
	ownedDomains: string[];
}): CitationGapReport {
	const { rows, mentions, ownedDomains } = input;
	// The same population the ledger metrics use: an unmeasured answer has no
	// entities attached to its citations, so it can neither confirm nor deny a
	// gap and must not shrink one either.
	const measured = rows.filter((row) => row.validity === "VALID" && row.extractorVersion !== null);
	const measuredRunIds = new Set(measured.map((row) => row.runId));

	const brandRuns = new Set<string>();
	const competitorsByRun = new Map<string, Set<string>>();
	for (const mention of mentions) {
		if (!measuredRunIds.has(mention.runId)) continue;
		if (mention.entityType === "BRAND") brandRuns.add(mention.runId);
		else if (mention.entityType === "COMPETITOR") {
			const named = competitorsByRun.get(mention.runId) ?? new Set<string>();
			named.add(mention.name);
			competitorsByRun.set(mention.runId, named);
		}
	}

	// Group sizes are needed for repeat stability: the denominator is how many
	// repeats of that scenario × system there were, not how many cited anything.
	const groupKey = (row: LedgerRow) => `${row.scenarioId} ${row.system ?? row.channel}`;
	const groupSizes = new Map<string, number>();
	for (const row of measured) groupSizes.set(groupKey(row), (groupSizes.get(groupKey(row)) ?? 0) + 1);

	const groupHits = new Map<string, Map<string, number>>();
	const accumulators = new Map<string, Accumulator>();
	for (const row of measured) {
		const seenInRow = new Set<string>();
		for (const citation of parseCitations(row.citations)) {
			if (isOwned(citation.domain, ownedDomains)) continue;
			const accumulator = accumulators.get(citation.domain) ?? {
				domain: citation.domain,
				urls: [],
				runIds: new Set<string>(),
				brandRuns: new Set<string>(),
				competitorRuns: new Set<string>(),
				competitorNames: new Set<string>(),
				scenarios: new Set<string>(),
				engines: new Set<string>(),
				groups: new Set<string>(),
				firstSeen: null,
				lastSeen: null,
			};
			if (!accumulator.urls.includes(citation.url)) accumulator.urls.push(citation.url);
			accumulator.runIds.add(row.runId);
			accumulator.scenarios.add(row.scenarioId);
			accumulator.engines.add(row.system ?? row.channel);
			accumulator.groups.add(groupKey(row));
			if (brandRuns.has(row.runId)) accumulator.brandRuns.add(row.runId);
			const named = competitorsByRun.get(row.runId);
			if (named !== undefined && named.size > 0) {
				accumulator.competitorRuns.add(row.runId);
				for (const name of named) accumulator.competitorNames.add(name);
			}
			if (row.finishedAt !== null) {
				if (accumulator.firstSeen === null || row.finishedAt < accumulator.firstSeen)
					accumulator.firstSeen = row.finishedAt;
				if (accumulator.lastSeen === null || row.finishedAt > accumulator.lastSeen)
					accumulator.lastSeen = row.finishedAt;
			}
			accumulators.set(citation.domain, accumulator);
			// A source cited twice in one answer is one sighting in that run.
			if (!seenInRow.has(citation.domain)) {
				seenInRow.add(citation.domain);
				const hits = groupHits.get(citation.domain) ?? new Map<string, number>();
				hits.set(groupKey(row), (hits.get(groupKey(row)) ?? 0) + 1);
				groupHits.set(citation.domain, hits);
			}
		}
	}

	const sources: CitationSource[] = [...accumulators.values()]
		.map((accumulator) => {
			const hits = groupHits.get(accumulator.domain);
			const shares = hits ? [...hits.entries()].map(([group, count]) => count / (groupSizes.get(group) ?? count)) : [];
			const competitorNames = [...accumulator.competitorNames].sort((a, b) => a.localeCompare(b));
			const scenarioCount = accumulator.scenarios.size;
			const engineCount = accumulator.engines.size;
			const ownedCitationCount = accumulator.brandRuns.size;
			const competitorCitationCount = accumulator.competitorRuns.size;
			return {
				domain: accumulator.domain,
				urls: accumulator.urls,
				ownedCitationCount,
				competitorCitationCount,
				competitorNames,
				scenarioCount,
				engineCount,
				evidenceRunIds: [...accumulator.runIds].sort(),
				firstSeen: accumulator.firstSeen,
				lastSeen: accumulator.lastSeen,
				repeatStability: shares.length === 0 ? null : shares.reduce((sum, share) => sum + share, 0) / shares.length,
				// §6.4: a gap needs competitors on one side and nothing owned on the
				// other. Both counts come from the same runs, so a source that ever
				// turned up alongside the brand is not a gap however often it
				// appears alongside competitors.
				gapType: competitorCitationCount > 0 && ownedCitationCount === 0 ? ("COMPETITOR_ONLY_SOURCE" as const) : null,
				priorityBand: priorityBandFor({ scenarioCount, engineCount, competitorNames }),
			};
		})
		.sort(
			(a, b) =>
				b.evidenceRunIds.length - a.evidenceRunIds.length ||
				b.competitorCitationCount - a.competitorCitationCount ||
				a.domain.localeCompare(b.domain),
		);

	return {
		formulaVersion: CITATION_GAP_FORMULA_VERSION,
		measuredRuns: measured.length,
		sources,
		gaps: sources.filter((source) => source.gapType !== null),
	};
}

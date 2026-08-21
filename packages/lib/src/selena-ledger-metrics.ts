/**
 * Evidence Ledger metrics (ТЗ §12, addendum §6), computed from completed runs
 * and the mention rows extracted from them.
 *
 * Pure on purpose: rows go in, numbers come out, nothing here reads the
 * database or a clock. Branded and discovery scenarios are never merged into
 * one figure — §6.5 keeps direct brand questions on a separate indicator, so
 * the report entry point returns them as separate blocks.
 *
 * Mentions and positions come from the normalized rows rather than from the
 * run's own jsonb, because addendum §5.3 puts a position on a mention inside a
 * run, not on the run. Both are written in one transaction, so reading the
 * normalized side cannot disagree with the run it belongs to.
 */

export type LedgerScenarioKind = "branded" | "discovery";

export type LedgerRow = {
	runId: string;
	scenarioId: string;
	/** Which AI surface answered; falls back to the dispatch channel when the adapter did not name one. */
	system: string | null;
	channel: string;
	validity: string | null;
	/**
	 * Set exactly when an extraction was stored for this run. It is what
	 * separates a measured absence from an answer nobody has measured yet: with
	 * no extraction there are no mention rows either, and the two states would
	 * otherwise be indistinguishable.
	 */
	extractorVersion: string | null;
	/** How the answer was obtained: live search, training data, or not established. */
	captureMode: string | null;
	ownedCitation: boolean | null;
	citations: unknown;
	/** When the run reached a terminal state; what dates a source's first and last sighting. */
	finishedAt: Date | null;
};

export type LedgerMention = {
	runId: string;
	entityType: string;
	name: string;
	ordinalPosition: number | null;
	captureMode: string | null;
};

export type LedgerMetrics = {
	totalRuns: number;
	validRuns: number;
	/**
	 * VALID runs whose answer was stored without extraction (no context wired,
	 * or resolution failed). They stay out of every evidence denominator: an
	 * unmeasured row is not a measured "no mention", and counting it as one
	 * would fabricate negative observations.
	 */
	unmeasuredRuns: number;
	invalidRate: number | null;
	/** Addendum §6.1: share of measured runs containing the brand. Coverage, deliberately not called Share of Voice. */
	mentionCoverage: number | null;
	/** Share of scenario × system groups whose every valid repeat mentions the brand. */
	stableMentionRate: number | null;
	ownedCitationRate: number | null;
	citationCoverage: number | null;
	/** §12 / addendum §6.3: averaged over mentions only — a non-mention has no position at all. */
	averageBrandPosition: number | null;
	/** Addendum §6.2: the brand's share among all tracked-entity mentions. */
	relativeMentionShare: {
		brand: number | null;
		competitors: { name: string; mentions: number; share: number }[];
	};
	visitorApiDivergence: {
		visitorMentionRate: number | null;
		apiMentionRate: number | null;
		divergence: number | null;
	};
	/**
	 * Measured runs by capture mode. A live-search answer and a training-data
	 * answer are observations of different things, so a reader has to be able to
	 * see what a rate is made of before comparing two of them.
	 */
	captureModes: Record<string, number>;
};

const BRAND = "BRAND";
const COMPETITOR = "COMPETITOR";

function citationCount(value: unknown): number {
	return Array.isArray(value) ? value.length : 0;
}

function isVisitorChannel(channel: string): boolean {
	return channel.toLowerCase().startsWith("visitor");
}

function isApiChannel(channel: string): boolean {
	return channel.toLowerCase().startsWith("api");
}

function ratio(numerator: number, denominator: number): number | null {
	return denominator === 0 ? null : numerator / denominator;
}

/**
 * Brand mentions indexed by run. One entity is not supposed to hold two
 * positions in one run (addendum §5.3); if a duplicate does arrive the run
 * still counts once and keeps the earliest position, so a repeated row can
 * neither inflate coverage nor move the average.
 */
function brandMentionsByRun(mentions: LedgerMention[], runIds: ReadonlySet<string>): Map<string, number | null> {
	const byRun = new Map<string, number | null>();
	for (const mention of mentions) {
		if (mention.entityType !== BRAND || !runIds.has(mention.runId)) continue;
		const existing = byRun.get(mention.runId);
		if (existing === undefined) {
			byRun.set(mention.runId, mention.ordinalPosition);
			continue;
		}
		if (mention.ordinalPosition !== null && (existing === null || mention.ordinalPosition < existing))
			byRun.set(mention.runId, mention.ordinalPosition);
	}
	return byRun;
}

/** Competitor appearances counted once per run, for the same reason. */
function competitorMentionCounts(mentions: LedgerMention[], runIds: ReadonlySet<string>): Map<string, number> {
	const seen = new Set<string>();
	const counts = new Map<string, number>();
	for (const mention of mentions) {
		if (mention.entityType !== COMPETITOR || !runIds.has(mention.runId)) continue;
		const key = `${mention.runId} ${mention.name}`;
		if (seen.has(key)) continue;
		seen.add(key);
		counts.set(mention.name, (counts.get(mention.name) ?? 0) + 1);
	}
	return counts;
}

export function computeLedgerMetrics(rows: LedgerRow[], mentions: LedgerMention[]): LedgerMetrics {
	// A row with no recorded validity never finished measuring; counting it
	// either way would shift every rate, so it is excluded from the ledger.
	const terminal = rows.filter((row) => row.validity !== null);
	const valid = terminal.filter((row) => row.validity === "VALID");
	// Evidence rates are computed over rows that actually carry an extraction.
	// A VALID run without one is reported in unmeasuredRuns instead of being
	// scored as if the brand was observed to be absent.
	const measured = valid.filter((row) => row.extractorVersion !== null);
	const measuredRunIds = new Set(measured.map((row) => row.runId));
	const brandPositions = brandMentionsByRun(mentions, measuredRunIds);
	const mentioned = measured.filter((row) => brandPositions.has(row.runId));

	const groups = new Map<string, { total: number; mentioned: number }>();
	for (const row of measured) {
		const key = `${row.scenarioId} ${row.system ?? row.channel}`;
		const group = groups.get(key) ?? { total: 0, mentioned: 0 };
		group.total += 1;
		if (brandPositions.has(row.runId)) group.mentioned += 1;
		groups.set(key, group);
	}
	const stableGroups = [...groups.values()].filter((group) => group.mentioned === group.total).length;

	const positions = mentioned
		.map((row) => brandPositions.get(row.runId) ?? null)
		.filter((position): position is number => position !== null);

	const competitorMentions = competitorMentionCounts(mentions, measuredRunIds);
	const totalCompetitorMentions = [...competitorMentions.values()].reduce((sum, count) => sum + count, 0);
	const voiceDenominator = mentioned.length + totalCompetitorMentions;

	const visitorMeasured = measured.filter((row) => isVisitorChannel(row.channel));
	const apiMeasured = measured.filter((row) => isApiChannel(row.channel));
	const visitorMentionRate = ratio(
		visitorMeasured.filter((row) => brandPositions.has(row.runId)).length,
		visitorMeasured.length,
	);
	const apiMentionRate = ratio(apiMeasured.filter((row) => brandPositions.has(row.runId)).length, apiMeasured.length);

	const captureModes: Record<string, number> = {};
	for (const row of measured) {
		const mode = row.captureMode ?? "unknown";
		captureModes[mode] = (captureModes[mode] ?? 0) + 1;
	}

	return {
		totalRuns: terminal.length,
		validRuns: valid.length,
		unmeasuredRuns: valid.length - measured.length,
		invalidRate: ratio(terminal.length - valid.length, terminal.length),
		mentionCoverage: ratio(mentioned.length, measured.length),
		stableMentionRate: ratio(stableGroups, groups.size),
		ownedCitationRate: ratio(measured.filter((row) => row.ownedCitation === true).length, measured.length),
		citationCoverage: ratio(measured.filter((row) => citationCount(row.citations) > 0).length, measured.length),
		averageBrandPosition:
			positions.length === 0 ? null : positions.reduce((sum, position) => sum + position, 0) / positions.length,
		relativeMentionShare: {
			brand: ratio(mentioned.length, voiceDenominator),
			competitors: [...competitorMentions.entries()]
				.map(([name, count]) => ({ name, mentions: count, share: count / voiceDenominator }))
				.sort((a, b) => b.mentions - a.mentions || a.name.localeCompare(b.name)),
		},
		visitorApiDivergence: {
			visitorMentionRate,
			apiMentionRate,
			divergence: visitorMentionRate === null || apiMentionRate === null ? null : visitorMentionRate - apiMentionRate,
		},
		captureModes,
	};
}

/**
 * A group's result. A group with no measured run is UNKNOWN, never a set of
 * zeroes: "we measured nothing here" and "the brand appeared in none of the
 * answers" are different statements, and only one of them is evidence.
 */
export type LedgerGroup =
	| { status: "UNKNOWN"; reason: "NO_MEASURED_RUNS"; runs: number }
	| { status: "MEASURED"; metrics: LedgerMetrics };

export type LedgerReport = {
	/** Questions that name the brand. */
	branded: LedgerGroup;
	/** Discovery questions — the non-branded bucket §6.5 keeps on its own indicator. */
	nonBranded: LedgerGroup;
	/**
	 * Both buckets together, derived and labelled. "Do people find us when they
	 * ask for us" and "do people find us when they ask for the category" are
	 * different questions; one number over both is only honest with the label
	 * attached.
	 */
	mixed: { mixed: true; group: LedgerGroup };
	/** Rows whose scenario has no classification; reported, never guessed into a bucket. */
	unclassifiedRuns: number;
};

function groupFor(rows: LedgerRow[], mentions: LedgerMention[]): LedgerGroup {
	const measured = rows.filter((row) => row.validity === "VALID" && row.extractorVersion !== null);
	if (measured.length === 0) return { status: "UNKNOWN", reason: "NO_MEASURED_RUNS", runs: rows.length };
	return { status: "MEASURED", metrics: computeLedgerMetrics(rows, mentions) };
}

export function computeLedgerReport(
	rows: LedgerRow[],
	mentions: LedgerMention[],
	scenarioKinds: ReadonlyMap<string, LedgerScenarioKind>,
): LedgerReport {
	const branded: LedgerRow[] = [];
	const nonBranded: LedgerRow[] = [];
	let unclassified = 0;
	for (const row of rows) {
		const kind = scenarioKinds.get(row.scenarioId);
		if (kind === "branded") branded.push(row);
		else if (kind === "discovery") nonBranded.push(row);
		else unclassified += 1;
	}
	return {
		branded: groupFor(branded, mentions),
		nonBranded: groupFor(nonBranded, mentions),
		mixed: { mixed: true, group: groupFor([...branded, ...nonBranded], mentions) },
		unclassifiedRuns: unclassified,
	};
}

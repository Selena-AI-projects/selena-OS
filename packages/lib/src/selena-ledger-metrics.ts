/**
 * Evidence Ledger metrics (ТЗ §12), computed from completed sv_runs rows.
 *
 * Pure on purpose: rows go in, numbers come out, nothing here reads the
 * database or a clock. Branded and discovery scenarios are never merged into
 * one figure — §6.5 keeps direct brand questions on a separate indicator, so
 * the report entry point returns them as separate blocks.
 */

export type LedgerScenarioKind = "branded" | "discovery";

export type LedgerRow = {
	scenarioId: string;
	/** Which AI surface answered; falls back to the dispatch channel when the adapter did not name one. */
	system: string | null;
	channel: string;
	validity: string | null;
	mention: boolean | null;
	position: number | null;
	ownedCitation: boolean | null;
	citations: unknown;
	competitors: unknown;
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
};

function citationCount(value: unknown): number {
	return Array.isArray(value) ? value.length : 0;
}

function competitorNames(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item) =>
			typeof item === "string"
				? item
				: typeof item === "object" && item !== null && typeof (item as { name?: unknown }).name === "string"
					? (item as { name: string }).name
					: null,
		)
		.filter((name): name is string => name !== null);
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

export function computeLedgerMetrics(rows: LedgerRow[]): LedgerMetrics {
	// A row with no recorded validity never finished measuring; counting it
	// either way would shift every rate, so it is excluded from the ledger.
	const terminal = rows.filter((row) => row.validity !== null);
	const valid = terminal.filter((row) => row.validity === "VALID");
	// Evidence rates are computed over rows that actually carry an extraction.
	// A VALID run without one is reported in unmeasuredRuns instead of being
	// scored as if the brand was observed to be absent.
	const measured = valid.filter((row) => row.mention !== null);
	const mentions = measured.filter((row) => row.mention === true);

	const groups = new Map<string, { total: number; mentioned: number }>();
	for (const row of measured) {
		const key = `${row.scenarioId} ${row.system ?? row.channel}`;
		const group = groups.get(key) ?? { total: 0, mentioned: 0 };
		group.total += 1;
		if (row.mention === true) group.mentioned += 1;
		groups.set(key, group);
	}
	const stableGroups = [...groups.values()].filter((group) => group.mentioned === group.total).length;

	const positions = mentions
		.map((row) => row.position)
		.filter((position): position is number => typeof position === "number");

	const competitorMentions = new Map<string, number>();
	for (const row of measured)
		for (const name of competitorNames(row.competitors))
			competitorMentions.set(name, (competitorMentions.get(name) ?? 0) + 1);
	const totalCompetitorMentions = [...competitorMentions.values()].reduce((sum, count) => sum + count, 0);
	const voiceDenominator = mentions.length + totalCompetitorMentions;

	const visitorMeasured = measured.filter((row) => isVisitorChannel(row.channel));
	const apiMeasured = measured.filter((row) => isApiChannel(row.channel));
	const visitorMentionRate = ratio(
		visitorMeasured.filter((row) => row.mention === true).length,
		visitorMeasured.length,
	);
	const apiMentionRate = ratio(apiMeasured.filter((row) => row.mention === true).length, apiMeasured.length);

	return {
		totalRuns: terminal.length,
		validRuns: valid.length,
		unmeasuredRuns: valid.length - measured.length,
		invalidRate: ratio(terminal.length - valid.length, terminal.length),
		mentionCoverage: ratio(mentions.length, measured.length),
		stableMentionRate: ratio(stableGroups, groups.size),
		ownedCitationRate: ratio(measured.filter((row) => row.ownedCitation === true).length, measured.length),
		citationCoverage: ratio(measured.filter((row) => citationCount(row.citations) > 0).length, measured.length),
		averageBrandPosition:
			positions.length === 0 ? null : positions.reduce((sum, position) => sum + position, 0) / positions.length,
		relativeMentionShare: {
			brand: ratio(mentions.length, voiceDenominator),
			competitors: [...competitorMentions.entries()]
				.map(([name, count]) => ({ name, mentions: count, share: count / voiceDenominator }))
				.sort((a, b) => b.mentions - a.mentions || a.name.localeCompare(b.name)),
		},
		visitorApiDivergence: {
			visitorMentionRate,
			apiMentionRate,
			divergence: visitorMentionRate === null || apiMentionRate === null ? null : visitorMentionRate - apiMentionRate,
		},
	};
}

export type LedgerReport = {
	branded: LedgerMetrics | null;
	discovery: LedgerMetrics | null;
	/** Rows whose scenario has no classification; reported, never guessed into a bucket. */
	unclassifiedRuns: number;
};

export function computeLedgerReport(
	rows: LedgerRow[],
	scenarioKinds: ReadonlyMap<string, LedgerScenarioKind>,
): LedgerReport {
	const branded: LedgerRow[] = [];
	const discovery: LedgerRow[] = [];
	let unclassified = 0;
	for (const row of rows) {
		const kind = scenarioKinds.get(row.scenarioId);
		if (kind === "branded") branded.push(row);
		else if (kind === "discovery") discovery.push(row);
		else unclassified += 1;
	}
	return {
		branded: branded.length > 0 ? computeLedgerMetrics(branded) : null,
		discovery: discovery.length > 0 ? computeLedgerMetrics(discovery) : null,
		unclassifiedRuns: unclassified,
	};
}

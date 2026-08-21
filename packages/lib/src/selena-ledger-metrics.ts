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
	invalidRate: number | null;
	mentionRate: number | null;
	/** Share of scenario × system groups whose every valid repeat mentions the brand. */
	stableMentionRate: number | null;
	ownedCitationRate: number | null;
	citationCoverage: number | null;
	/** §12: averaged over mentions only — a non-mention has no position at all. */
	averagePosition: number | null;
	shareOfVoice: {
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
	return Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : [];
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
	const mentions = valid.filter((row) => row.mention === true);

	const groups = new Map<string, { total: number; mentioned: number }>();
	for (const row of valid) {
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
	for (const row of valid)
		for (const name of competitorNames(row.competitors))
			competitorMentions.set(name, (competitorMentions.get(name) ?? 0) + 1);
	const totalCompetitorMentions = [...competitorMentions.values()].reduce((sum, count) => sum + count, 0);
	const voiceDenominator = mentions.length + totalCompetitorMentions;

	const visitorValid = valid.filter((row) => isVisitorChannel(row.channel));
	const apiValid = valid.filter((row) => isApiChannel(row.channel));
	const visitorMentionRate = ratio(visitorValid.filter((row) => row.mention === true).length, visitorValid.length);
	const apiMentionRate = ratio(apiValid.filter((row) => row.mention === true).length, apiValid.length);

	return {
		totalRuns: terminal.length,
		validRuns: valid.length,
		invalidRate: ratio(terminal.length - valid.length, terminal.length),
		mentionRate: ratio(mentions.length, valid.length),
		stableMentionRate: ratio(stableGroups, groups.size),
		ownedCitationRate: ratio(valid.filter((row) => row.ownedCitation === true).length, valid.length),
		citationCoverage: ratio(valid.filter((row) => citationCount(row.citations) > 0).length, valid.length),
		averagePosition:
			positions.length === 0 ? null : positions.reduce((sum, position) => sum + position, 0) / positions.length,
		shareOfVoice: {
			brand: ratio(mentions.length, voiceDenominator),
			competitors: [...competitorMentions.entries()]
				.map(([name, count]) => ({ name, mentions: count, share: count / voiceDenominator }))
				.sort((a, b) => b.mentions - a.mentions || a.name.localeCompare(b.name)),
		},
		visitorApiDivergence: {
			visitorMentionRate,
			apiMentionRate,
			divergence:
				visitorMentionRate === null || apiMentionRate === null ? null : visitorMentionRate - apiMentionRate,
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

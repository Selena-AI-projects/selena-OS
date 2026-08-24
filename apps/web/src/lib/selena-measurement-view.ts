import type { LedgerGroup, LedgerScenarioKind } from "@workspace/lib/selena-ledger-metrics";

/**
 * Pure helpers for the cabinet's step-4 "Measurement" section. The invariants
 * live here where they are unit-testable: an empty group renders UNKNOWN
 * (never 0%), branded and non-branded stay separate, and no composite
 * headline score is ever derived.
 */

export function scenarioKindsFrom(rows: { id: string; intentType: string }[]): Map<string, LedgerScenarioKind> {
	const kinds = new Map<string, LedgerScenarioKind>();
	for (const row of rows) {
		// Anything else stays unclassified and is surfaced as a count by the
		// ledger report rather than guessed into a bucket.
		if (row.intentType === "branded") kinds.set(row.id, "branded");
		else if (row.intentType === "discovery") kinds.set(row.id, "discovery");
	}
	return kinds;
}

/** A ratio as a whole-percent string, or null when the input is unmeasured. */
export function formatShare(value: number | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	return `${Math.round(value * 100)}%`;
}

export type GroupView =
	| { state: "unknown"; runs: number }
	| {
			state: "measured";
			measuredRuns: number;
			unmeasuredRuns: number;
			mentionCoverage: string | null;
			averageBrandPosition: number | null;
	  };

export function groupView(group: LedgerGroup): GroupView {
	if (group.status === "UNKNOWN") return { state: "unknown", runs: group.runs };
	const metrics = group.metrics;
	return {
		state: "measured",
		measuredRuns: metrics.validRuns - metrics.unmeasuredRuns,
		unmeasuredRuns: metrics.unmeasuredRuns,
		mentionCoverage: formatShare(metrics.mentionCoverage),
		averageBrandPosition: metrics.averageBrandPosition,
	};
}

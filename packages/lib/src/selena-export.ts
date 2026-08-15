export type SelenaLedgerRow = {
	runId: string;
	cycleId: string;
	channel: "Visitor View" | "API View";
	brand: string;
	scenarioId: string;
	scenarioText: string;
	system: string;
	model: string | null;
	timestamp: string;
	language: string;
	region: string | null;
	validity: string;
	rawResponseReference: string | null;
	mention: boolean;
	position: number | null;
	ownedCitation: boolean;
	citations: string[];
	competitors: string[];
	factualErrors: string[];
	tokenUsage: { input: number; output: number; total: number } | null;
	cost: number | null;
	qcStatus: string;
};

export const ledgerColumns = [
	"run_id",
	"cycle_id",
	"channel",
	"brand",
	"scenario_id",
	"scenario_text",
	"system",
	"model",
	"timestamp",
	"language",
	"region",
	"validity",
	"raw_response_reference",
	"mention",
	"position",
	"owned_citation",
	"citations",
	"competitors",
	"factual_errors",
	"input_tokens",
	"output_tokens",
	"total_tokens",
	"cost",
	"qc_status",
] as const;

function csvCell(value: unknown): string {
	const text = Array.isArray(value)
		? JSON.stringify(value)
		: value === null || value === undefined
			? ""
			: String(value);
	return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function ledgerToCsv(rows: SelenaLedgerRow[]): string {
	const lines = [ledgerColumns.join(",")];
	for (const row of rows) {
		lines.push(
			[
				row.runId,
				row.cycleId,
				row.channel,
				row.brand,
				row.scenarioId,
				row.scenarioText,
				row.system,
				row.model,
				row.timestamp,
				row.language,
				row.region,
				row.validity,
				row.rawResponseReference,
				row.mention,
				row.position,
				row.ownedCitation,
				row.citations,
				row.competitors,
				row.factualErrors,
				row.tokenUsage?.input ?? null,
				row.tokenUsage?.output ?? null,
				row.tokenUsage?.total ?? null,
				row.cost,
				row.qcStatus,
			]
				.map(csvCell)
				.join(","),
		);
	}
	return `${lines.join("\n")}\n`;
}

export function assertCanonicalDataset(rows: SelenaLedgerRow[], expectedRuns: number): void {
	if (rows.length !== expectedRuns) throw new Error(`DATASET_CARDINALITY_MISMATCH:${rows.length}:${expectedRuns}`);
	const ids = new Set(rows.map((row) => row.runId));
	if (ids.size !== rows.length) throw new Error("DATASET_DUPLICATE_RUN_ID");
	if (rows.some((row) => !row.runId || !row.cycleId || !row.scenarioId)) throw new Error("DATASET_MISSING_ID");
}

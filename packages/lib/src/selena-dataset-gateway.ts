import { createHash } from "node:crypto";
import type { EvidenceItem, InputManifest } from "@workspace/selena-visibility-contracts";
import { stableId } from "@workspace/selena-visibility-contracts";
import type { SelenaLedgerRow } from "./selena-export";

export type SelenaRulepack = {
	version: string;
	name: string;
	claimThresholds: { mention: number; ownedCitation: number; invalid: number };
};

export const rulepacks: Record<string, SelenaRulepack> = {
	"selena-visibility-v1": {
		version: "selena-visibility-v1",
		name: "AI Visibility baseline",
		claimThresholds: { mention: 0.2, ownedCitation: 0.2, invalid: 0.1 },
	},
};

export type SelenaSourceSnapshot = {
	id: string;
	tenantId: string;
	source: string;
	capturedAt: string;
	contentHash: string;
	immutable: true;
};

export type SelenaDataset = {
	id: string;
	tenantId: string;
	rows: SelenaLedgerRow[];
	evidence: EvidenceItem[];
	snapshot: SelenaSourceSnapshot;
	manifest: InputManifest;
	rulepack: SelenaRulepack;
};

function hashRows(rows: SelenaLedgerRow[]): string {
	return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function metadata(row: SelenaLedgerRow): Record<string, string> {
	return {
		channel: row.channel,
		mention: String(row.mention),
		owned_citation: String(row.ownedCitation),
		validity: row.validity,
		position: row.position === null ? "" : String(row.position),
	};
}

export function normalizeLedgerRows(rows: SelenaLedgerRow[], tenantId: string, snapshotId: string): EvidenceItem[] {
	return rows.map((row) => ({
		id: row.runId,
		tenantId,
		snapshotId,
		kind: "AI_RESPONSE",
		accessClass: "PUBLIC",
		sourceRef: row.rawResponseReference ?? `evidence-ledger://${row.runId}`,
		capturedAt: row.timestamp,
		subject: row.scenarioText,
		text: row.scenarioText,
		metadata: metadata(row),
	}));
}

export function createSelenaDataset(
	tenantId: string,
	datasetId: string,
	rows: SelenaLedgerRow[],
	options: { source?: string; capturedAt?: string; rulepackVersion?: string } = {},
): SelenaDataset {
	if (!tenantId || !datasetId) throw new Error("DATASET_ID_REQUIRED");
	const rulepack = rulepacks[options.rulepackVersion ?? "selena-visibility-v1"];
	if (!rulepack) throw new Error("RULEPACK_NOT_FOUND");
	const contentHash = hashRows(rows);
	const snapshotId = stableId("snapshot", `${tenantId}:${datasetId}:${contentHash}`);
	const evidence = normalizeLedgerRows(rows, tenantId, snapshotId);
	const manifest: InputManifest = {
		id: stableId("manifest", `${tenantId}:${datasetId}:${contentHash}:${rulepack.version}`),
		tenantId,
		datasetId,
		evidenceIds: evidence.map((item) => item.id),
		snapshotIds: [snapshotId],
		rulepackVersion: rulepack.version,
		createdAt: options.capturedAt ?? new Date().toISOString(),
		immutable: true,
	};
	return {
		id: stableId("dataset", `${tenantId}:${datasetId}:${contentHash}`),
		tenantId,
		rows: rows.map((row) => ({
			...row,
			citations: [...row.citations],
			competitors: [...row.competitors],
			factualErrors: [...row.factualErrors],
		})),
		evidence,
		snapshot: {
			id: snapshotId,
			tenantId,
			source: options.source ?? "existing-evidence-ledger",
			capturedAt: options.capturedAt ?? new Date().toISOString(),
			contentHash,
			immutable: true,
		},
		manifest,
		rulepack,
	};
}

export function assertDatasetTenant(dataset: SelenaDataset, tenantId: string): void {
	if (dataset.tenantId !== tenantId || dataset.evidence.some((item) => item.tenantId !== tenantId))
		throw new Error("TENANT_ISOLATION_BLOCKED");
}

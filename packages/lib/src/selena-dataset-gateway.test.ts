import { describe, expect, it } from "vitest";
import { assertDatasetTenant, createSelenaDataset } from "./selena-dataset-gateway";
import type { SelenaLedgerRow } from "./selena-export";

const row: SelenaLedgerRow = {
	runId: "run-1",
	cycleId: "cycle-1",
	channel: "API View",
	brand: "Brand",
	scenarioId: "scenario-1",
	scenarioText: "What is Brand?",
	system: "existing-engine",
	model: null,
	timestamp: "2026-08-15T00:00:00Z",
	language: "en",
	region: null,
	validity: "valid",
	rawResponseReference: null,
	mention: true,
	position: 1,
	ownedCitation: false,
	citations: [],
	competitors: [],
	factualErrors: [],
	tokenUsage: null,
	cost: null,
	qcStatus: "not_required",
};

describe("Selena Dataset Gateway", () => {
	it("normalizes the existing ledger and creates immutable deterministic boundaries", () => {
		const first = createSelenaDataset("tenant-a", "dataset-1", [row], { capturedAt: "2026-08-15T00:00:00Z" });
		const second = createSelenaDataset("tenant-a", "dataset-1", [row], { capturedAt: "2026-08-15T00:00:00Z" });
		expect(first.snapshot.immutable).toBe(true);
		expect(first.manifest.immutable).toBe(true);
		expect(first.manifest).toEqual(second.manifest);
		expect(first.evidence[0]?.metadata.channel).toBe("API View");
		expect(first.rulepack.version).toBe("selena-visibility-v1");
	});

	it("blocks cross-tenant dataset use", () => {
		const dataset = createSelenaDataset("tenant-a", "dataset-1", [row]);
		expect(() => assertDatasetTenant(dataset, "tenant-b")).toThrow("TENANT_ISOLATION_BLOCKED");
	});
});

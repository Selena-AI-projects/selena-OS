import { describe, expect, it } from "vitest";
import {
	buildActionPlan,
	buildManifest,
	mergeActionPlans,
	parseEvidenceCsv,
	validateGrounding,
} from "./recommendation-engine";

const csv = `run_id,channel,mention,owned_citation,scenario,timestamp\nrow-1,API View,false,false,Where to eat in Ubud?,2026-08-14T00:00:00Z\nrow-2,API View,true,false,Where to eat in Ubud?,2026-08-14T00:00:01Z\nrow-3,Visitor View,true,true,Where to eat in Ubud?,2026-08-14T00:00:02Z`;

describe("recommendation engine Phase 0-1", () => {
	it("builds a deterministic manifest and a grounded vertical chain", () => {
		const evidence = parseEvidenceCsv(csv, "tenant-a", "snapshot-usha-20260814");
		const manifest = buildManifest("tenant-a", "usha-240", evidence);
		const plan = buildActionPlan("tenant-a", manifest, evidence);
		expect(buildManifest("tenant-a", "usha-240", evidence)).toEqual(manifest);
		expect(plan.findings.length).toBeGreaterThan(0);
		expect(plan.recommendations[0]?.evidenceIds.every((id) => manifest.evidenceIds.includes(id))).toBe(true);
		expect(plan.tasks[0]?.verificationPlan.length).toBeGreaterThan(0);
		expect(validateGrounding(plan, evidence)).toEqual([]);
	});

	it("blocks cross-tenant evidence", () => {
		const evidence = parseEvidenceCsv(csv, "tenant-a", "snapshot-usha-20260814");
		const manifest = buildManifest("tenant-a", "usha-240", evidence);
		expect(() => buildActionPlan("tenant-b", manifest, evidence)).toThrow("TENANT_ISOLATION_BLOCKED");
	});

	it("does not turn absent data into a claim", () => {
		const evidence = parseEvidenceCsv(
			"run_id,channel,mention,owned_citation\nrow-1,Visitor View,false,false",
			"tenant-a",
			"snapshot",
		);
		const plan = buildActionPlan("tenant-a", buildManifest("tenant-a", "empty-signal", evidence), evidence);
		expect(plan.findings).toEqual([]);
	});

	it("rejects evidence outside the finding manifest", () => {
		const evidence = parseEvidenceCsv(csv, "tenant-a", "snapshot-usha-20260814");
		const manifest = buildManifest("tenant-a", "usha-240", evidence);
		const plan = buildActionPlan("tenant-a", manifest, evidence);
		const altered = {
			...plan,
			recommendations: plan.recommendations.map((item) => ({ ...item, evidenceIds: ["unknown-run"] })),
		};
		expect(validateGrounding(altered, evidence).some((error) => error.includes("UNKNOWN_EVIDENCE"))).toBe(true);
	});

	it("merges AI and website plans only within one tenant", () => {
		const evidence = parseEvidenceCsv(csv, "tenant-a", "snapshot-usha-20260814");
		const plan = buildActionPlan("tenant-a", buildManifest("tenant-a", "usha-240", evidence), evidence);
		expect(mergeActionPlans("tenant-a", "combined-manifest", [plan, plan]).findings).toHaveLength(
			plan.findings.length * 2,
		);
		expect(() => mergeActionPlans("tenant-b", "combined-manifest", [plan])).toThrow("TENANT_ISOLATION_BLOCKED");
	});
});

import { describe, expect, it } from "vitest";
import {
	buildPublicEvidenceActionPlan,
	collectPublicSourceFixture,
	connectorContracts,
} from "./public-source-adapters";

describe("public source fixture adapters", () => {
	it("creates immutable provenance-preserving evidence without provider calls", () => {
		const first = collectPublicSourceFixture({
			tenantId: "tenant-a",
			kind: "SEARCH",
			sourceUrl: "https://fixture.test/search",
			payload: { query: "best brand", results: [{ title: "Brand" }] },
			collectedAt: "2026-08-15T00:00:00Z",
		});
		const second = collectPublicSourceFixture({
			tenantId: "tenant-a",
			kind: "SEARCH",
			sourceUrl: "https://fixture.test/search",
			payload: { query: "best brand", results: [{ title: "Brand" }] },
			collectedAt: "2026-08-15T00:00:00Z",
		});
		expect(first.snapshot.immutable).toBe(true);
		expect(first.snapshot.contentHash).toBe(second.snapshot.contentHash);
		expect(first.evidence[0]?.sourceRef).toBe("https://fixture.test/search");
		expect(first.evidence[0]?.metadata.limitations).toContain("fixture data; no reach or conversion inference");
	});
	it("keeps optional OAuth connectors integration-ready but inactive", () => {
		expect(connectorContracts).toHaveLength(4);
		expect(connectorContracts.every((connector) => connector.status === "NOT_ACTIVATED")).toBe(true);
	});
	it("preserves channel semantics for public-source fixtures", () => {
		for (const kind of ["SEARCH", "MAPS", "REVIEWS", "SOCIAL"] as const) {
			const result = collectPublicSourceFixture({
				tenantId: "tenant-a",
				kind,
				sourceUrl: `https://fixture.test/${kind.toLowerCase()}`,
				payload: { kind },
			});
			expect(result.evidence[0]?.kind).toBe(kind === "REVIEWS" ? "REVIEW" : kind);
			expect(result.evidence[0]?.metadata.channel).toBe(kind);
		}
	});
	it("feeds public evidence through deterministic findings to a grounded action plan", () => {
		const result = buildPublicEvidenceActionPlan({
			tenantId: "tenant-a",
			datasetId: "public-fixture",
			collections: [
				collectPublicSourceFixture({
					tenantId: "tenant-a",
					kind: "SEARCH",
					sourceUrl: "https://fixture.test/search",
					payload: { query: "x" },
					collectedAt: "2026-08-15T00:00:00Z",
				}),
				collectPublicSourceFixture({
					tenantId: "tenant-a",
					kind: "REVIEWS",
					sourceUrl: "https://fixture.test/reviews",
					payload: { rating: 4.2, review: "good" },
					collectedAt: "2026-08-15T00:00:00Z",
				}),
			],
		});
		expect(result.groundingErrors).toEqual([]);
		expect(result.actionPlan.findings).toHaveLength(1);
		expect(result.actionPlan.recommendations[0]?.evidenceIds).toEqual([result.evidence[0]?.id]);
		expect(result.actionPlan.tasks[0]?.verificationPlan).toHaveLength(1);
	});
	it("blocks cross-tenant public evidence before rule evaluation", () => {
		const collection = collectPublicSourceFixture({
			tenantId: "tenant-b",
			kind: "SOCIAL",
			sourceUrl: "https://fixture.test/social",
			payload: { profile: "x" },
		});
		expect(() =>
			buildPublicEvidenceActionPlan({ tenantId: "tenant-a", datasetId: "cross-tenant", collections: [collection] }),
		).toThrow("TENANT_ISOLATION_BLOCKED");
	});
});

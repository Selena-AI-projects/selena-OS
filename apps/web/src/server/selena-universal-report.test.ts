import { describe, expect, it, vi } from "vitest";
import {
	buildUniversalReportView,
	createUniversalReportHandler,
	renderUniversalReport,
	type UniversalReport,
	universalReportCsv,
} from "./selena-universal-report";

function fixture(organizationId = "customer-a", queryCount = 2, pointCount = 9): UniversalReport {
	const queries = Array.from({ length: queryCount }, (_, i) => ({ id: `query-${i}`, text: `Dinner query ${i}` }));
	const points = Array.from({ length: pointCount }, (_, i) => ({
		id: `point-${i}`,
		latitude: -8 + i / 1000,
		longitude: 115,
	}));
	return {
		version: 1,
		organizationId,
		projectId: `${organizationId}-project`,
		reportId: `${organizationId}-report`,
		orderId: `${organizationId}-order`,
		publication: "PUBLISHED",
		measurementMode: "FIXTURE",
		restaurant: { identity: `${organizationId}-place`, name: `Restaurant ${organizationId}` },
		queries,
		points,
		protocol: { language: "en", device: "mobile", timezone: "Asia/Makassar", requestedDepth: 20 },
		observations: queries.flatMap((q) =>
			points.map((p) => ({
				id: `${q.id}-${p.id}`,
				queryId: q.id,
				pointId: p.id,
				outcome: "FOUND",
				capturedAt: "2026-09-12T09:00:00Z",
				sourceId: "source-1",
				targetRank: 2,
				returnedCount: 3,
				competitionComplete: true,
				items: [
					{ identity: "ad", name: "Sponsor", rank: 1, kind: "AD" },
					{ identity: "leader", name: "Other restaurant", rank: 1, kind: "ORGANIC" },
					{ identity: `${organizationId}-place`, name: `Restaurant ${organizationId}`, rank: 2, kind: "ORGANIC" },
				],
			})),
		),
		sources: [{ id: "source-1", label: "Explicit fixture evidence", capturedAt: "2026-09-12T09:00:00Z" }],
		analysis: { status: "PENDING", actions: [] },
	};
}
const scope = (r: UniversalReport) => ({ organizationId: r.organizationId, projectId: r.projectId });

describe("universal report presentation", () => {
	it("permits report downloads while keeping script and form execution blocked", async () => {
		const r = fixture();
		const handler = createUniversalReportHandler({
			authenticate: async () => ({ authType: "session", ...scope(r) }),
			loadPublication: async () => r,
		});
		for (const suffix of ["", "?format=csv"]) {
			const response = await handler(new Request(`https://example.test/report${suffix}`), r.reportId);
			expect(response.status).toBe(200);
			const csp = response.headers.get("Content-Security-Policy");
			expect(csp).toContain("sandbox allow-popups allow-downloads");
			expect(csp).toContain("form-action 'none'");
			expect(csp).not.toContain("allow-scripts");
			expect(csp).not.toContain("allow-same-origin");
			expect(response.headers.get("Cache-Control")).toBe("private, no-store");
			if (suffix) expect(response.headers.get("Content-Disposition")).toContain("attachment");
		}
	});
	it("opens retained legacy reports without fabricating an order and links to production export routes", () => {
		const r = { ...fixture(), orderId: null };
		const html = renderUniversalReport(buildUniversalReportView(r, scope(r)));
		expect(html).toContain('href="/selena/local/checkout">К кабинету');
		expect(html).toContain(`/api/v1/selena/local-prepayment/reports/${r.reportId}?format=csv`);
		expect(html).not.toContain("?order=null");
		expect(html).not.toContain("local-publications/");
	});
	for (const [queries, points] of [
		[1, 9],
		[4, 9],
		[15, 25],
	]) {
		it(`handles ${queries} queries and ${points} points without AVLI-specific data`, () => {
			const r = fixture("fresh-client", queries, points);
			const view = buildUniversalReportView(r, scope(r));
			expect(view.expected).toBe(queries * points);
			expect(view.valid).toBe(queries * points);
			expect(view.queries.every((q) => q.top3 === points)).toBe(true);
			expect(view.competitors.some((c) => c.identity === "ad")).toBe(false);
			expect(view.analysisComplete).toBe(false);
			expect(renderUniversalReport(view)).toContain("Демонстрационные данные");
			expect(renderUniversalReport(view)).not.toContain("AVLI");
		});
	}
	it("does not count unknown, invalid, missing or cancelled slots as absent or valid", () => {
		const r = fixture();
		for (const [i, outcome] of ["UNKNOWN", "INVALID", "CANCELLED"].entries())
			Object.assign(r.observations[i], {
				outcome,
				targetRank: null,
				capturedAt: null,
				sourceId: null,
				items: [],
				returnedCount: 0,
			});
		r.observations.pop();
		const view = buildUniversalReportView(r, scope(r));
		expect(view.valid).toBe(14);
		expect(view.unresolved).toBe(4);
		expect(view.measurementComplete).toBe(false);
		expect(view.queries.reduce((n, q) => n + q.notFound, 0)).toBe(0);
	});
	it("preserves a valid not-found result without inventing rank 21", () => {
		const r = fixture();
		Object.assign(r.observations[0], { outcome: "NOT_FOUND", targetRank: null, items: [], returnedCount: 0 });
		const view = buildUniversalReportView(r, scope(r));
		expect(view.queries[0].notFound).toBe(1);
		expect(view.valid).toBe(18);
		expect(universalReportCsv(view)).toContain('"NOT_FOUND",""');
	});
	it("rejects contradictory target identity, duplicate slots and unlinked evidence", () => {
		const r = fixture();
		r.observations[0].items[2].identity = "different-place";
		expect(() => buildUniversalReportView(r, scope(r))).toThrow("REPORT_TARGET_IDENTITY_MISMATCH");
		const duplicate = fixture();
		duplicate.observations.push({ ...duplicate.observations[0], id: "copy" });
		expect(() => buildUniversalReportView(duplicate, scope(duplicate))).toThrow("REPORT_SLOT_DUPLICATE");
		const missing = fixture();
		missing.observations[0].sourceId = "unrelated";
		expect(() => buildUniversalReportView(missing, scope(missing))).toThrow("REPORT_EVIDENCE_MISSING");
	});
	it("rejects foreign scope and unpublished/revoked documents", () => {
		const r = fixture();
		expect(() => buildUniversalReportView(r, { organizationId: "customer-b", projectId: r.projectId })).toThrow(
			"REPORT_NOT_FOUND",
		);
		expect(() => buildUniversalReportView(r, { ...scope(r), projectId: "other" })).toThrow("REPORT_NOT_FOUND");
		for (const publication of ["DRAFT", "REVOKED"] as const)
			expect(() => buildUniversalReportView({ ...r, publication }, scope(r))).toThrow("REPORT_NOT_PUBLISHED");
	});
	it("keeps names escaped and spreadsheet formulas inert", () => {
		const r = fixture();
		r.restaurant.name = '<img src=x onerror="alert(1)">';
		r.queries[0].text = '=HYPERLINK("https://example.test")';
		const view = buildUniversalReportView(r, scope(r));
		expect(renderUniversalReport(view)).not.toContain("<img src=x");
		expect(renderUniversalReport(view)).toContain("&lt;img");
		expect(universalReportCsv(view)).toContain("'=HYPERLINK");
	});
	it("requires reviewed actions tied to valid observations and real source references", () => {
		const r = fixture();
		r.analysis.actions = [
			{
				id: "action",
				title: "Review booking",
				observationIds: [r.observations[0].id],
				sourceIds: ["source-1"],
				finding: "Observed position",
				hypothesis: "Booking clarity may differ",
				work: "Test actual booking path",
				factOwner: "Owner",
				implementationOwner: "Editor",
				acceptance: "Path works",
				measurement: "Same protocol",
			},
		];
		expect(() => buildUniversalReportView(r, scope(r))).toThrow("REPORT_ANALYSIS_NOT_REVIEWED");
		r.analysis.status = "REVIEWED";
		expect(buildUniversalReportView(r, scope(r)).analysisComplete).toBe(true);
		r.analysis.actions[0].sourceIds = ["unknown"];
		expect(() => buildUniversalReportView(r, scope(r))).toThrow("REPORT_ACTION_EVIDENCE_MISSING");
	});
});

describe("report HTTP boundary with injected store", () => {
	it("isolates two clients for HTML and CSV even when a store returns the wrong document", async () => {
		const a = fixture(),
			b = fixture("customer-b");
		const handler = createUniversalReportHandler({
			authenticate: async () => ({ ...scope(a), authType: "session" }),
			loadPublication: async (_, id) => (id === b.reportId ? b : a),
		});
		for (const format of ["html", "csv"]) {
			const own = await handler(new Request(`https://example.test/report?format=${format}`), a.reportId);
			expect(own.status).toBe(200);
			expect(own.headers.get("Cache-Control")).toBe("private, no-store");
			const other = await handler(new Request(`https://example.test/report?format=${format}`), b.reportId);
			expect(other.status).toBe(404);
			expect(await other.text()).not.toContain(b.restaurant.name);
		}
	});
	it("does not read storage before authentication and hides failures", async () => {
		const loadPublication = vi.fn();
		const handler = createUniversalReportHandler({
			authenticate: async () => {
				throw new Error("Unauthorized: sign in");
			},
			loadPublication,
		});
		expect((await handler(new Request("https://example.test/report"), "report")).status).toBe(401);
		expect(loadPublication).not.toHaveBeenCalled();
	});
});

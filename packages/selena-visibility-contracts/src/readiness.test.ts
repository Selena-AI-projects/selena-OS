import { describe, expect, it } from "vitest";
import { compareReadiness, generateReadinessFix, previewReadinessFix, scorePublicReadiness } from "./readiness";

const page = { pageUrl: "https://example.com/", status: 200, robots: "User-agent: *", canonical: "https://example.com/", headings: ["About"], visibleText: "A".repeat(600), jsonLd: [{ "@type": "Organization" }], contacts: ["mailto:hello@example.com"], services: ["Services"], metadata: { title: "Example", description: "A useful description" }, internalLinks: ["https://example.com/about"] };

describe("Public Readiness", () => {
	it("scores technical readiness without claiming AI visibility", () => {
		const result = scorePublicReadiness(page);
		expect(result.score).toBeGreaterThan(90);
		expect(result.paidProviderCalls).toBe(0);
		expect(result.visibilityClaim).toContain("not observed AI visibility");
		expect(result.components.find((item) => item.id === "llms-txt")?.weight).toBe(0);
	});
	it("returns evidence-backed findings for a sparse page", () => {
		const result = scorePublicReadiness({ ...page, robots: null, headings: [], jsonLd: [], contacts: [], services: [], metadata: {} });
		expect(result.findings.map((item) => item.ruleId)).toEqual(expect.arrayContaining(["READINESS-CRAWL-001", "READINESS-SCHEMA-001", "READINESS-CITABILITY-001"]));
	});
	it("creates a non-applying fix preview and keeps readiness comparison separate from AI visibility", () => {
		const baseline = scorePublicReadiness({ pageUrl: "https://example.com", status: 200, robots: null, canonical: null, headings: [], visibleText: "short", jsonLd: [], contacts: [], services: [], metadata: {}, internalLinks: [] });
		const finding = baseline.findings[0];
		expect(finding).toBeDefined();
		if (!finding) return;
		const fix = generateReadinessFix(finding);
		const preview = previewReadinessFix(fix, finding);
		expect(fix.autoApply).toBe(false);
		expect(preview.applied).toBe(false);
		const comparison = compareReadiness(baseline, { ...baseline, score: 70 });
		expect(comparison.delta).toBe(70 - baseline.score);
		expect(comparison.aiVisibilityCompared).toBe(false);
	});
});

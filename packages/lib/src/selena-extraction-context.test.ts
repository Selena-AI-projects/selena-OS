import { runMeasurementSchema } from "@workspace/selena-visibility-contracts";
import { describe, expect, it } from "vitest";
import { extractMeasurement } from "./selena-answer-extraction";
import { buildExtractionContext, hostOf, lockedProfileBlock, parseLockedProfile } from "./selena-extraction-context";

const profile = {
	brandName: "KORA Food Hall",
	primaryDomain: "https://www.korafoodhall.com/menu",
	competitorSnapshot: [
		{ name: "Rival Cafe", domains: ["rivalcafe.id"] },
		{ name: "Other Place", domains: [] },
	],
};

describe("hostOf", () => {
	it("reduces a url, a bare domain and a www host to the same host", () => {
		expect(hostOf("https://www.korafoodhall.com/menu?x=1")).toBe("korafoodhall.com");
		expect(hostOf("korafoodhall.com")).toBe("korafoodhall.com");
		expect(hostOf("WWW.KoraFoodHall.com")).toBe("korafoodhall.com");
	});

	it("returns nothing for a value that is not a host", () => {
		expect(hostOf("  ")).toBe("");
		expect(hostOf("not a domain at all")).toBe("");
	});
});

describe("buildExtractionContext", () => {
	it("puts the canonical brand name first and matches the brand by domain too", () => {
		const context = buildExtractionContext({ profile, language: "en", region: "ID" });
		expect(context.brandTerms).toEqual(["KORA Food Hall", "korafoodhall.com"]);
		expect(context.ownedDomains).toEqual(["korafoodhall.com"]);
		expect(context.language).toBe("en");
		expect(context.region).toBe("ID");
	});

	it("gives competitors the same domain matching as the brand", () => {
		const context = buildExtractionContext({ profile, language: "en" });
		expect(context.competitors).toEqual([
			{ name: "Rival Cafe", terms: ["Rival Cafe", "rivalcafe.id"] },
			{ name: "Other Place", terms: ["Other Place"] },
		]);
	});

	it("owns the brand domain only, never a shared platform the brand has a page on", () => {
		const context = buildExtractionContext({
			profile: { ...profile, primaryDomain: "korafoodhall.com" },
			language: "en",
		});
		expect(context.ownedDomains).toEqual(["korafoodhall.com"]);
	});

	it("omits the region rather than storing a blank one", () => {
		expect(buildExtractionContext({ profile, language: "en", region: "  " }).region).toBeUndefined();
		expect(buildExtractionContext({ profile, language: "en" }).region).toBeUndefined();
	});

	it("drops a competitor with no usable term instead of matching an empty string", () => {
		const context = buildExtractionContext({
			profile: {
				...profile,
				competitorSnapshot: [
					{ name: "  ", domains: [] },
					{ name: "Kept", domains: [] },
				],
			},
			language: "en",
		});
		expect(context.competitors).toEqual([{ name: "Kept", terms: ["Kept"] }]);
	});

	it("refuses to build a context the contract could not store", () => {
		expect(() => buildExtractionContext({ profile: { ...profile, brandName: " " }, language: "en" })).toThrow(
			"SELENA_EXTRACTION_BRAND_MISSING",
		);
		expect(() => buildExtractionContext({ profile, language: " " })).toThrow("SELENA_EXTRACTION_LANGUAGE_MISSING");
		expect(() =>
			buildExtractionContext({ profile: { ...profile, competitorSnapshot: "nope" }, language: "en" }),
		).toThrow("SELENA_COMPETITOR_SNAPSHOT_INVALID");
	});

	it("measures a real answer into a contract-valid row", () => {
		const measurement = extractMeasurement({
			answerText: ["1. Rival Cafe — busy.", "2. KORA Food Hall — calm mornings."].join("\n"),
			sources: [{ url: "https://korafoodhall.com/menu", domain: "korafoodhall.com" }],
			system: "chatgpt",
			context: buildExtractionContext({ profile, language: "en", region: "ID" }),
		});
		expect(() => runMeasurementSchema.parse(measurement)).not.toThrow();
		expect(measurement.brand).toBe("KORA Food Hall");
		expect(measurement.position).toBe(2);
		expect(measurement.ownedCitation).toBe(true);
		expect(measurement.competitors).toEqual([{ name: "Rival Cafe", position: 1 }]);
	});
});

describe("parseLockedProfile", () => {
	it("treats a lock without a profile block as absent", () => {
		expect(parseLockedProfile(null)).toBeNull();
		expect(parseLockedProfile({})).toBeNull();
		expect(parseLockedProfile({ measurementScope: {} })).toBeNull();
	});

	it("reads the block a lock does carry", () => {
		expect(parseLockedProfile({ profile: { brandName: "KORA", primaryDomain: "korafoodhall.com" } })).toEqual({
			brandName: "KORA",
			primaryDomain: "korafoodhall.com",
			competitorSnapshot: [],
		});
	});

	it("throws on a corrupt block rather than falling back to the live profile", () => {
		expect(() => parseLockedProfile({ profile: { brandName: 7 } })).toThrow();
	});
});

describe("lockedProfileBlock", () => {
	it("round-trips through parseLockedProfile", () => {
		const block = lockedProfileBlock({
			brandName: "KORA Food Hall",
			primaryDomain: "https://korafoodhall.com",
			competitorSnapshot: [
				{ name: "Rival Cafe", domains: ["rivalcafe.id"] },
				{ name: "Other Place", domains: [] },
			],
		});
		expect(parseLockedProfile({ profile: block })).toEqual(block);
	});

	it("accepts the older single-domain competitor form", () => {
		const block = lockedProfileBlock({
			brandName: "KORA",
			primaryDomain: "korafoodhall.com",
			competitorSnapshot: [{ name: "Rival Cafe", domain: "rivalcafe.id" }],
		});
		expect(block.competitorSnapshot).toEqual([{ name: "Rival Cafe", domains: ["rivalcafe.id"] }]);
	});

	it("drops nameless entries and non-arrays instead of freezing garbage", () => {
		expect(lockedProfileBlock({ brandName: "K", primaryDomain: "k.com", competitorSnapshot: "oops" }).competitorSnapshot).toEqual([]);
		expect(
			lockedProfileBlock({ brandName: "K", primaryDomain: "k.com", competitorSnapshot: [{ domains: ["x.com"] }, null] })
				.competitorSnapshot,
		).toEqual([]);
	});
});

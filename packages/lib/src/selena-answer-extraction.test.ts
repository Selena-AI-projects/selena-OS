import { runMeasurementSchema } from "@workspace/selena-visibility-contracts";
import { describe, expect, it } from "vitest";
import { containsTerm, extractMeasurement, isOwnedDomain, recommendationItems } from "./selena-answer-extraction";

const context = {
	brandTerms: ["KORA Food Hall", "KORA"],
	ownedDomains: ["korafoodhall.com"],
	competitors: [
		{ name: "Rival Cafe", terms: ["Rival Cafe", "Rival"] },
		{ name: "Other Place", terms: [] },
	],
	language: "en",
	region: "ID",
};

describe("containsTerm", () => {
	it("matches whole words case-insensitively and refuses substrings", () => {
		expect(containsTerm("Try kora for breakfast", "KORA")).toBe(true);
		expect(containsTerm("The Korall reef bar", "KORA")).toBe(false);
		expect(containsTerm("KORA, then the beach", "kora")).toBe(true);
		expect(containsTerm("visit KORA Food Hall today", "KORA Food Hall")).toBe(true);
	});

	it("gives Cyrillic names the same boundary treatment as Latin ones", () => {
		expect(containsTerm("Загляните в КОРА на завтрак", "кора")).toBe(true);
		expect(containsTerm("декоративная коралловая стена", "кора")).toBe(false);
	});

	it("treats surrogate-pair neighbours and combining marks as word material, not boundaries", () => {
		// An astral-plane letter (𝐀, U+1D400) directly attached to the term is
		// part of the same word; a lone-surrogate boundary test would match.
		expect(containsTerm("\u{1D400}kora", "kora")).toBe(false);
		expect(containsTerm("kora\u{1D400}", "kora")).toBe(false);
		// A combining accent extends the word rather than ending it.
		expect(containsTerm("kora\u0301l", "kora")).toBe(false);
		// An emoji is not a letter: standing next to it is a legitimate hit.
		expect(containsTerm("\u{1F60A} kora", "kora")).toBe(true);
	});

	it("never matches an empty term", () => {
		expect(containsTerm("anything", "  ")).toBe(false);
	});
});

describe("recommendationItems", () => {
	it("prefers numbered items over bullets when both exist", () => {
		const text = ["Intro line", "1. First pick", "2) Second pick", "- a stray bullet"].join("\n");
		expect(recommendationItems(text)).toEqual(["First pick", "Second pick"]);
	});

	it("falls back to bullets when nothing is numbered", () => {
		expect(recommendationItems("• Alpha\n* Beta\n- Gamma")).toEqual(["Alpha", "Beta", "Gamma"]);
	});

	it("returns nothing for prose", () => {
		expect(recommendationItems("Just a paragraph about breakfast.")).toEqual([]);
	});
});

describe("isOwnedDomain", () => {
	it("accepts the domain itself and its subdomains, ignoring www and case", () => {
		expect(isOwnedDomain("korafoodhall.com", ["korafoodhall.com"])).toBe(true);
		expect(isOwnedDomain("www.KoraFoodHall.com", ["korafoodhall.com"])).toBe(true);
		expect(isOwnedDomain("menu.korafoodhall.com", ["korafoodhall.com"])).toBe(true);
		expect(isOwnedDomain("notkorafoodhall.com", ["korafoodhall.com"])).toBe(false);
	});
});

describe("extractMeasurement", () => {
	it("produces a contract-valid row from a ranked answer with sources", () => {
		const measurement = extractMeasurement({
			answerText: [
				"Here are the best food halls in Canggu:",
				"1. **Rival Cafe** — busy but reliable.",
				"2. **KORA Food Hall** — calm mornings, great coffee.",
				"3. Some Other Spot",
			].join("\n"),
			sources: [
				{ url: "https://korafoodhall.com/menu", domain: "korafoodhall.com" },
				{ url: "https://guide.example/best", domain: "guide.example" },
				{ url: "https://guide.example/best", domain: "guide.example" },
			],
			system: "chatgpt",
			context,
		});
		expect(() => runMeasurementSchema.parse(measurement)).not.toThrow();
		expect(measurement).toEqual({
			system: "chatgpt",
			language: "en",
			region: "ID",
			mention: true,
			position: 2,
			ownedCitation: true,
			citations: [
				{ url: "https://korafoodhall.com/menu", domain: "korafoodhall.com" },
				{ url: "https://guide.example/best", domain: "guide.example" },
			],
			competitors: ["Rival Cafe"],
			factualErrors: [],
		});
	});

	it("reports a prose-only mention as unranked rather than inventing a position", () => {
		const measurement = extractMeasurement({
			answerText: "KORA is a good option, though many prefer Rival Cafe.",
			sources: [],
			system: "gemini",
			context,
		});
		expect(measurement.mention).toBe(true);
		expect(measurement.position).toBeNull();
		expect(measurement.ownedCitation).toBe(false);
		expect(measurement.competitors).toEqual(["Rival Cafe"]);
	});

	it("stays contract-valid when the brand is absent entirely", () => {
		const measurement = extractMeasurement({
			answerText: "1. Rival Cafe\n2. Some Other Spot",
			sources: [{ url: "https://guide.example/best", domain: "guide.example" }],
			system: "perplexity",
			model: "sonar",
			context,
		});
		expect(() => runMeasurementSchema.parse(measurement)).not.toThrow();
		expect(measurement.mention).toBe(false);
		expect(measurement.position).toBeNull();
		expect(measurement.model).toBe("sonar");
	});

	it("falls back to the competitor name when no terms are configured", () => {
		const measurement = extractMeasurement({
			answerText: "Other Place is the local favourite.",
			sources: [],
			system: "chatgpt",
			context,
		});
		expect(measurement.competitors).toEqual(["Other Place"]);
	});

	it("drops sources without a usable url or domain instead of storing blanks", () => {
		const measurement = extractMeasurement({
			answerText: "KORA",
			sources: [
				{ url: " ", domain: "korafoodhall.com" },
				{ url: "https://korafoodhall.com", domain: " " },
			],
			system: "chatgpt",
			context,
		});
		expect(measurement.citations).toEqual([]);
		expect(measurement.ownedCitation).toBe(false);
	});
});

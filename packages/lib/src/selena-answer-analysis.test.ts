import { describe, expect, it } from "vitest";
import {
	analyzeAnswer,
	type AnswerAnalysis,
	extractCitedDomains,
	summarizeScenarioSet,
} from "./selena-answer-analysis";

const brand = { name: "KORA Food Hall", aliases: ["KORA"], domain: "korafoodhall.com" };
const competitors = [{ name: "La Brisa" }, { name: "Милу" }];

describe("reading who an AI answer named", () => {
	it("reports the brand and its standing among everyone named", () => {
		const analysis = analyzeAnswer({
			text: "Попробуйте La Brisa, затем KORA Food Hall, а ещё Милу.",
			brand,
			competitors,
		});
		expect(analysis.brandMentioned).toBe(true);
		expect(analysis.brandOrder).toBe(2);
		expect(analysis.mentions.map((mention) => [mention.name, mention.role, mention.order])).toEqual([
			["La Brisa", "COMPETITOR", 1],
			["KORA Food Hall", "TARGET", 2],
			["Милу", "COMPETITOR", 3],
		]);
	});

	it("reports an absent brand as absent rather than as last place", () => {
		const analysis = analyzeAnswer({ text: "Лучший выбор — La Brisa.", brand, competitors });
		expect(analysis.brandMentioned).toBe(false);
		expect(analysis.brandOrder).toBeNull();
	});

	it("matches an alias the customer configured", () => {
		expect(analyzeAnswer({ text: "Многие советуют KORA.", brand, competitors }).brandMentioned).toBe(true);
	});

	it("does not match a name buried inside a longer Cyrillic word", () => {
		// "Милу" inside "Милуоки": ASCII word boundaries would accept this.
		const analysis = analyzeAnswer({ text: "Это заведение в Милуоки.", brand, competitors });
		expect(analysis.mentions).toEqual([]);
	});
});

describe("reading what an answer leaned on", () => {
	it("collects linked, written and provider-reported sources as one host list", () => {
		const domains = extractCitedDomains(
			"Подробнее на https://www.TripAdvisor.com/Restaurant_Review-g123 и на canggu-guide.com.",
			["https://maps.google.com/?cid=1"],
		);
		expect(domains).toEqual(["canggu-guide.com", "maps.google.com", "tripadvisor.com"]);
	});

	it("does not read an abbreviation or a decimal as a source", () => {
		expect(extractCitedDomains("Цена 1.5 млн, т.е. дорого.")).toEqual([]);
	});
});

describe("rolling a set of answers up into a report", () => {
	const analyze = (text: string): AnswerAnalysis => analyzeAnswer({ text, brand, competitors });

	it("returns UNKNOWN rather than zero when nothing was analyzed", () => {
		const summary = summarizeScenarioSet([]);
		expect(summary.answersAnalyzed).toBe(0);
		expect(summary.brandMentionRate).toBeNull();
		expect(summary.brandShareOfVoice).toBeNull();
		expect(summary.brandAverageOrder).toBeNull();
	});

	it("leaves share of voice undefined when the answers named nobody at all", () => {
		const summary = summarizeScenarioSet([analyze("В этом районе сложно что-то советовать.")]);
		expect(summary.answersAnalyzed).toBe(1);
		expect(summary.brandMentionRate).toBe(0);
		expect(summary.brandShareOfVoice).toBeNull();
	});

	it("counts coverage, share of voice and standing over the set", () => {
		const summary = summarizeScenarioSet([
			analyze("Сначала La Brisa, потом KORA Food Hall."),
			analyze("Только La Brisa."),
		]);
		expect(summary.brandMentionRate).toBe(0.5);
		expect(summary.brandShareOfVoice).toBeCloseTo(1 / 3);
		expect(summary.brandAverageOrder).toBe(2);
		expect(summary.competitors[0]).toEqual({ name: "La Brisa", answersMentioned: 2, averageOrder: 1 });
	});

	it("ranks the citation gap by sources the brand was missing from", () => {
		const summary = summarizeScenarioSet(
			[
				analyze("Рекомендуем La Brisa — canggu-guide.com."),
				analyze("La Brisa лидирует, см. canggu-guide.com."),
				analyze("KORA Food Hall хвалят на tripadvisor.com и korafoodhall.com."),
			],
			{ brandDomain: "https://korafoodhall.com" },
		);
		const [first] = summary.citationGap;
		expect(first).toEqual({
			domain: "canggu-guide.com",
			timesCited: 2,
			timesCitedWithoutBrand: 2,
			ownedByBrand: false,
		});
		expect(summary.citationGap.find((entry) => entry.domain === "korafoodhall.com")?.ownedByBrand).toBe(true);
	});
});

import { describe, expect, it } from "vitest";
import { analyzeAnswer } from "./selena-answer-analysis";
import { type GraderRunInput, buildGraderReport, isBrandedQuestion } from "./selena-grader-report";

const brand = { name: "KORA Food Hall", aliases: ["KORA"], domain: "korafoodhall.com" };
const competitors = [{ name: "Milk & Madu" }, { name: "Zest Ubud" }, { name: "Sayuri" }];
const subjects = { brand, competitors };

let runSeq = 0;
function run(input: {
	systemId: string;
	channel?: "VISITOR" | "API";
	scenarioId: string;
	text: string;
	language?: string;
	answer: string | null;
}): GraderRunInput {
	runSeq += 1;
	return {
		runId: `run-${runSeq}`,
		systemId: input.systemId,
		channel: input.channel ?? "VISITOR",
		scenarioId: input.scenarioId,
		scenarioText: input.text,
		scenarioLanguage: input.language ?? "en",
		analysis:
			input.answer === null
				? null
				: analyzeAnswer({ text: input.answer, brand, competitors }),
	};
}

describe("isBrandedQuestion", () => {
	it("detects the brand name and aliases case-insensitively, including in Russian text", () => {
		expect(isBrandedQuestion("is kora food hall worth visiting", brand)).toBe(true);
		expect(isBrandedQuestion("KORA — отзывы и меню", brand)).toBe(true);
		expect(isBrandedQuestion("best cafe in Ubud", brand)).toBe(false);
	});

	it("requires a standalone word, so a brand hiding inside another word is not branded", () => {
		const rusBrand = { name: "Кора" };
		expect(isBrandedQuestion("Какие декоративные растения купить", rusBrand)).toBe(false);
		expect(isBrandedQuestion("Кора — отзывы", rusBrand)).toBe(true);
	});

	it("recognizes two-character brand names", () => {
		expect(isBrandedQuestion("VK отзывы и цены", { name: "VK" })).toBe(true);
		expect(isBrandedQuestion("вконтакте что нового", { name: "VK" })).toBe(false);
	});
});

describe("buildGraderReport", () => {
	it("splits branded and category questions per system and keeps unanswered runs visible", () => {
		const report = buildGraderReport({
			subjects,
			runs: [
				run({ systemId: "chatgpt", scenarioId: "q1", text: "best cafe in Ubud", answer: "Try Milk & Madu and Zest Ubud." }),
				run({ systemId: "chatgpt", scenarioId: "q2", text: "is KORA worth visiting", answer: "KORA Food Hall is popular." }),
				run({ systemId: "chatgpt", scenarioId: "q3", text: "breakfast in Ubud", answer: null }),
			],
		});
		const chatgpt = report.systems.find((system) => system.systemId === "chatgpt");
		expect(chatgpt).toMatchObject({
			answersExpected: 3,
			answersAnalyzed: 2,
			brandMentioned: 1,
			branded: { answers: 1, mentioned: 1 },
			category: { answers: 1, mentioned: 0 },
		});
		expect(report.methodology).toMatchObject({ questions: 3, answersExpected: 3, answersAnalyzed: 2, answersMissing: 1 });
	});

	it("attaches per-system results to each approved question without turning missing answers into misses", () => {
		const report = buildGraderReport({
			subjects,
			runs: [
				run({ systemId: "chatgpt", scenarioId: "q1", text: "best cafe in Ubud", answer: "Try KORA Food Hall." }),
				run({ systemId: "chatgpt", scenarioId: "q1", text: "best cafe in Ubud", answer: null }),
				run({ systemId: "gemini", scenarioId: "q1", text: "best cafe in Ubud", answer: "Try Zest Ubud." }),
			],
		});
		expect(report.questions).toHaveLength(1);
		expect(report.questions[0]).toMatchObject({
			scenarioId: "q1",
			systems: [
				{
					systemId: "chatgpt",
					answersExpected: 2,
					answersAnalyzed: 1,
					brandMentioned: 1,
					runs: [
						{ brandMentioned: true },
						{ brandMentioned: null },
					],
				},
				{ systemId: "gemini", answersExpected: 1, answersAnalyzed: 1, brandMentioned: 0 },
			],
		});
	});

	it("orders visitor systems before API systems", () => {
		const report = buildGraderReport({
			subjects,
			runs: [
				run({ systemId: "anthropic/claude-haiku-4.5", channel: "API", scenarioId: "q1", text: "best cafe in Ubud", answer: "Sayuri." }),
				run({ systemId: "perplexity", channel: "VISITOR", scenarioId: "q1", text: "best cafe in Ubud", answer: "Zest Ubud." }),
			],
		});
		expect(report.systems.map((system) => system.channel)).toEqual(["VISITOR", "API"]);
	});

	it("keeps never-mentioned competitors on the roster as UNKNOWN rather than dropping them", () => {
		const report = buildGraderReport({
			subjects,
			runs: [run({ systemId: "chatgpt", scenarioId: "q1", text: "best cafe in Ubud", answer: "Milk & Madu is great; KORA Food Hall too." })],
		});
		const sayuri = report.roster.find((entry) => entry.name === "Sayuri");
		expect(sayuri).toMatchObject({ answersMentioned: 0, averageOrder: null });
		expect(report.roster[0]).toMatchObject({ name: brand.name, isBrand: true, answersMentioned: 1 });
	});

	it("lists a gap row only when a competitor was named and the brand was not", () => {
		const report = buildGraderReport({
			subjects,
			runs: [
				run({ systemId: "chatgpt", scenarioId: "q1", text: "best cafe in Ubud", answer: "Zest Ubud and Milk & Madu, per tripadvisor.com." }),
				run({ systemId: "chatgpt", scenarioId: "q2", text: "vegan food Ubud", answer: "KORA Food Hall and Zest Ubud." }),
				run({ systemId: "chatgpt", scenarioId: "q3", text: "quiet cafes", answer: "Nothing specific comes to mind." }),
			],
		});
		expect(report.gaps).toHaveLength(1);
		expect(report.gaps[0]).toMatchObject({
			scenarioText: "best cafe in Ubud",
			competitorsShown: ["Zest Ubud", "Milk & Madu"],
			citedDomains: ["tripadvisor.com"],
		});
	});

	it("derives recommendations from observations and stays silent with no data", () => {
		expect(buildGraderReport({ subjects, runs: [] }).recommendations).toEqual([]);
		const report = buildGraderReport({
			subjects,
			runs: [
				run({ systemId: "chatgpt", scenarioId: "q1", text: "best cafe in Ubud", answer: "Milk & Madu — see tripadvisor.com and honeycombers.com." }),
				run({ systemId: "gemini", scenarioId: "q1", text: "best cafe in Ubud", answer: "KORA Food Hall, per korafoodhall.com." }),
			],
		});
		const kinds = report.recommendations.map((entry) => entry.kind);
		expect(kinds).toContain("SOURCE_PRESENCE");
		expect(kinds).toContain("CATEGORY_CONTENT");
		const sourceDomains = report.recommendations
			.filter((entry) => entry.kind === "SOURCE_PRESENCE")
			.map((entry) => entry.domain);
		expect(sourceDomains).toEqual(expect.arrayContaining(["tripadvisor.com", "honeycombers.com"]));
		const category = report.recommendations.find((entry) => entry.kind === "CATEGORY_CONTENT");
		expect(category).toMatchObject({ missedAnswers: 1, categoryAnswers: 2, exampleQuestions: ["best cafe in Ubud"] });
	});

	it("recommends the own site only when an external source out-cites it", () => {
		const outCited = buildGraderReport({
			subjects,
			runs: [run({ systemId: "chatgpt", scenarioId: "q1", text: "best cafe in Ubud", answer: "Milk & Madu, per tripadvisor.com." })],
		});
		expect(outCited.recommendations.some((entry) => entry.kind === "OWN_SITE_UNDERCITED")).toBe(true);
		const wellCited = buildGraderReport({
			subjects,
			runs: [run({ systemId: "chatgpt", scenarioId: "q1", text: "best cafe in Ubud", answer: "KORA Food Hall — korafoodhall.com." })],
		});
		expect(wellCited.recommendations.some((entry) => entry.kind === "OWN_SITE_UNDERCITED")).toBe(false);
	});

	it("never merges two channels into one system row", () => {
		const report = buildGraderReport({
			subjects,
			runs: [
				{ runId: "r1", systemId: "unattributed", channel: "VISITOR", scenarioId: "q1", scenarioText: "best cafe in Ubud", scenarioLanguage: "en", analysis: analyzeAnswer({ text: "Zest Ubud.", brand, competitors }) },
				{ runId: "r2", systemId: "unattributed", channel: "API", scenarioId: "q1", scenarioText: "best cafe in Ubud", scenarioLanguage: "en", analysis: analyzeAnswer({ text: "KORA Food Hall.", brand, competitors }) },
			],
		});
		expect(report.systems).toHaveLength(2);
		expect(report.systems.map((system) => system.channel)).toEqual(["VISITOR", "API"]);
		expect(report.methodology).toMatchObject({ visitorSystems: 1, apiSystems: 1 });
	});

	it("compares the own site against the most-cited external source, not the gap-ranked one", () => {
		const report = buildGraderReport({
			subjects,
			runs: [
				run({ systemId: "chatgpt", scenarioId: "q1", text: "is KORA worth it", answer: "KORA Food Hall, per yelp.com." }),
				run({ systemId: "chatgpt", scenarioId: "q2", text: "KORA menu", answer: "KORA Food Hall — yelp.com and korafoodhall.com." }),
				run({ systemId: "chatgpt", scenarioId: "q3", text: "best cafe in Ubud", answer: "Sayuri, per smallblog.com." }),
			],
		});
		const own = report.recommendations.find((entry) => entry.kind === "OWN_SITE_UNDERCITED");
		expect(own).toMatchObject({ topExternalDomain: "yelp.com", topExternalCited: 2, timesCited: 1 });
	});

	it("stays silent about the own site when it matches the top external citation count", () => {
		const report = buildGraderReport({
			subjects,
			runs: [
				run({ systemId: "chatgpt", scenarioId: "q1", text: "is KORA worth it", answer: "KORA Food Hall — korafoodhall.com, also yelp.com." }),
			],
		});
		expect(report.recommendations.some((entry) => entry.kind === "OWN_SITE_UNDERCITED")).toBe(false);
	});

	it("treats brand subdomains as owned, never as sources to get into", () => {
		const report = buildGraderReport({
			subjects,
			runs: [
				run({ systemId: "chatgpt", scenarioId: "q1", text: "best cafe in Ubud", answer: "Sayuri, per blog.korafoodhall.com." }),
			],
		});
		expect(report.recommendations.some((entry) => entry.kind === "SOURCE_PRESENCE")).toBe(false);
		expect(report.recommendations.some((entry) => entry.kind === "OWN_SITE_UNDERCITED")).toBe(false);
	});

	it("does not recommend sources that were only cited alongside the brand", () => {
		const report = buildGraderReport({
			subjects,
			runs: [
				run({ systemId: "chatgpt", scenarioId: "q1", text: "is KORA worth it", answer: "KORA Food Hall, per tripadvisor.com." }),
			],
		});
		expect(report.recommendations.some((entry) => entry.kind === "SOURCE_PRESENCE")).toBe(false);
	});

	it("caps source recommendations at three, keeping the most gap-heavy domains", () => {
		const report = buildGraderReport({
			subjects,
			runs: [
				run({ systemId: "chatgpt", scenarioId: "q1", text: "best cafe in Ubud", answer: "Sayuri — a.com, a.com is great; also b.com and c.com and d.com." }),
				run({ systemId: "chatgpt", scenarioId: "q2", text: "vegan Ubud", answer: "Zest Ubud — a.com, b.com, c.com." }),
			],
		});
		const sources = report.recommendations.filter((entry) => entry.kind === "SOURCE_PRESENCE");
		expect(sources).toHaveLength(3);
		expect(sources.map((entry) => entry.domain)).toEqual(["a.com", "b.com", "c.com"]);
	});

	it("orders competitors by how often they were named", () => {
		const report = buildGraderReport({
			subjects,
			runs: [
				run({ systemId: "chatgpt", scenarioId: "q1", text: "best cafe in Ubud", answer: "Zest Ubud and Milk & Madu." }),
				run({ systemId: "chatgpt", scenarioId: "q2", text: "vegan Ubud", answer: "Zest Ubud again." }),
			],
		});
		const names = report.roster.filter((entry) => !entry.isBrand).map((entry) => entry.name);
		expect(names.slice(0, 2)).toEqual(["Zest Ubud", "Milk & Madu"]);
	});

	it("reports repeats as UNKNOWN when the scope did not say", () => {
		expect(buildGraderReport({ subjects, runs: [] }).methodology.repeats).toBeNull();
		expect(buildGraderReport({ subjects, runs: [], repeats: 5 }).methodology.repeats).toBe(5);
	});

	it("keeps a run with a lost question out of the question list and both groups", () => {
		const report = buildGraderReport({
			subjects,
			runs: [
				{ runId: "r1", systemId: "chatgpt", channel: "VISITOR", scenarioId: "gone", scenarioText: "", scenarioLanguage: "", analysis: analyzeAnswer({ text: "Milk & Madu.", brand, competitors }) },
			],
		});
		expect(report.questions).toHaveLength(0);
		const system = report.systems[0];
		expect(system.branded.answers + system.category.answers).toBe(0);
		expect(system.answersAnalyzed).toBe(1);
		expect(report.recommendations.some((entry) => entry.kind === "CATEGORY_CONTENT")).toBe(false);
	});

	it("reports UNKNOWN summaries for a system whose runs all failed", () => {
		const report = buildGraderReport({
			subjects,
			runs: [run({ systemId: "grok", channel: "API", scenarioId: "q1", text: "best cafe in Ubud", answer: null })],
		});
		const grok = report.systems[0];
		expect(grok.shareOfVoice).toBeNull();
		expect(grok.averageOrder).toBeNull();
		expect(grok.answersAnalyzed).toBe(0);
	});
});

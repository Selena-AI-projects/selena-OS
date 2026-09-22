import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyMentions, describeDryRunPayload, heuristicMentions } from "./classifier";
import { makeBrand, makeCompetitor, SYNTHETIC_CASES } from "./fixtures";

/**
 * The canonical baseline this pilot compares against is process-prompt.ts's
 * analyzeMentions — NOT report-worker.ts's, which is a separately-drifted copy
 * missing alias support and using a different Competitor shape. Neither function is
 * exported, so this test extracts both functions' BODIES (which contain no
 * TypeScript-only syntax — the type annotations live only in the signatures) from the
 * live source and actually EXECUTES them via `new Function`, then asserts their
 * output matches `heuristicMentions` on the same inputs. This is a behavior
 * comparison, not a text/shape comparison: a harmless refactor of `analyzeMentions`
 * (renaming locals, reformatting, reordering statements) leaves this test green as
 * long as the input/output behavior is unchanged; only an actual behavior change
 * breaks it.
 */
/** Extracts the brace-balanced body starting at the first '{' found at/after `fromIndex`, excluding the outer braces. */
function extractBraceBalancedBody(source: string, fromIndex: number): string {
	const bodyStart = source.indexOf("{", fromIndex);
	if (bodyStart === -1) throw new Error("no opening brace found");
	let depth = 0;
	for (let i = bodyStart; i < source.length; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}") {
			depth--;
			if (depth === 0) return source.slice(bodyStart + 1, i);
		}
	}
	throw new Error("unbalanced braces");
}

function loadLiveAnalyzeMentions(): (
	content: string,
	brand: { name: string; aliases?: string[]; website: string; additionalDomains?: string[] },
	competitorsList: { name: string; aliases?: string[]; domains?: string[] }[],
) => { brandMentioned: boolean; competitorsMentioned: string[] } {
	const source = readFileSync(join(__dirname, "../../jobs/process-prompt.ts"), "utf-8");

	// extractDomainFromUrl's signature has no return-type object literal, so its
	// body's opening '{' is simply the first one after the function name.
	const domainFnMarker = source.indexOf("function extractDomainFromUrl(");
	if (domainFnMarker === -1) throw new Error("extractDomainFromUrl not found in process-prompt.ts");
	const extractDomainFromUrlBody = extractBraceBalancedBody(source, domainFnMarker);
	// biome-ignore lint/security/noGlobalEval: deliberately executing the live baseline's own source, extracted at test time, to prove behavior (not just text) equivalence — see comment above.
	const extractDomainFromUrl = new Function("urlOrDomain", extractDomainFromUrlBody) as (u: string) => string;

	// analyzeMentions's return-type annotation (`): { brandMentioned: boolean; ... }`)
	// is itself a brace block before the real body, so brace-balancing from the
	// function name would stop at the annotation instead — anchored on its known
	// first/last statements instead, which is body-content, not signature shape.
	const analyzeFnMarker = source.indexOf("function analyzeMentions(");
	if (analyzeFnMarker === -1) throw new Error("analyzeMentions not found in process-prompt.ts");
	const bodyStart = source.indexOf("const contentLower = content.toLowerCase();", analyzeFnMarker);
	const bodyEnd = source.indexOf("return { brandMentioned, competitorsMentioned };", bodyStart);
	if (bodyStart === -1 || bodyEnd === -1) throw new Error("could not bound analyzeMentions's body");
	const analyzeMentionsBody = source.slice(bodyStart, bodyEnd) + "return { brandMentioned, competitorsMentioned };";
	const analyzeMentionsLive = new Function(
		"content",
		"brand",
		"competitorsList",
		"extractDomainFromUrl",
		analyzeMentionsBody,
	) as (
		content: string,
		brand: { name: string; aliases?: string[]; website: string; additionalDomains?: string[] },
		competitorsList: { name: string; aliases?: string[]; domains?: string[] }[],
		extractDomainFromUrl: (u: string) => string,
	) => { brandMentioned: boolean; competitorsMentioned: string[] };

	return (content, brand, competitorsList) => analyzeMentionsLive(content, brand, competitorsList, extractDomainFromUrl);
}

describe("heuristicMentions: behaviorally matches the live baseline (process-prompt.ts, not report-worker.ts)", () => {
	const analyzeMentionsLive = loadLiveAnalyzeMentions();

	const representativeCases = SYNTHETIC_CASES.filter((c) =>
		["straightforward", "collision", "negation"].includes(c.category),
	).slice(0, 6);

	it.each(representativeCases.map((c) => [c.name, c] as const))("matches on: %s", (_name, testCase) => {
		const brand = testCase.brand;
		const competitors = [...testCase.competitors];
		expect(heuristicMentions(testCase.text, brand, competitors)).toEqual(
			analyzeMentionsLive(testCase.text, brand, competitors),
		);
	});
});

const ORIGINAL_ENABLED = process.env.JEV_PILOT_ENABLED;
const ORIGINAL_KEY = process.env.TYPESAFE_API_KEY;

beforeEach(() => {
	delete process.env.JEV_PILOT_ENABLED;
	delete process.env.TYPESAFE_API_KEY;
});

afterEach(() => {
	if (ORIGINAL_ENABLED === undefined) delete process.env.JEV_PILOT_ENABLED;
	else process.env.JEV_PILOT_ENABLED = ORIGINAL_ENABLED;
	if (ORIGINAL_KEY === undefined) delete process.env.TYPESAFE_API_KEY;
	else process.env.TYPESAFE_API_KEY = ORIGINAL_KEY;
});

describe("classifyMentions: kill switch", () => {
	it("defaults to the existing heuristic when JEV_PILOT_ENABLED is unset", async () => {
		const brand = makeBrand();
		const competitors = [makeCompetitor()];
		const text = "Elmo tracks AI visibility; Profound is one alternative.";

		const outcome = await classifyMentions({ text, brand, competitors });

		expect(outcome.status).toBe("fallback");
		if (outcome.status !== "fallback") throw new Error("unreachable");
		expect(outcome.heuristic).toEqual(heuristicMentions(text, brand, competitors));
	});

	it("stays on the fallback path even with dryRun/enabled options when the env kill switch is off and no explicit override is given", async () => {
		const brand = makeBrand();
		const outcome = await classifyMentions({ text: "Elmo is mentioned here.", brand, competitors: [] });
		expect(outcome.status).toBe("fallback");
	});
});

describe("classifyMentions: insufficient_data", () => {
	it("flags empty answer text", async () => {
		const outcome = await classifyMentions({ text: "", brand: makeBrand(), competitors: [makeCompetitor()] });
		expect(outcome).toEqual({ status: "insufficient_data", reason: "empty answer text" });
	});

	it("flags a brand with no name", async () => {
		const outcome = await classifyMentions({
			text: "Some answer text.",
			brand: makeBrand({ name: "" }),
			competitors: [],
		});
		expect(outcome.status).toBe("insufficient_data");
	});
});

describe("classifyMentions: fails closed without a real connection", () => {
	it("falls back instead of throwing when the pilot is enabled but TYPESAFE_API_KEY is missing", async () => {
		const brand = makeBrand();
		const outcome = await classifyMentions(
			{ text: "Elmo and Profound both come up here.", brand, competitors: [makeCompetitor()] },
			{ enabled: true },
		);
		expect(outcome.status).toBe("fallback");
		if (outcome.status !== "fallback") throw new Error("unreachable");
		expect(outcome.reason).toMatch(/client construction failed/);
	});
});

describe("describeDryRunPayload: data/instruction separation", () => {
	it("puts the answer text only in state, never inside a question's instructions", () => {
		const injectionCase = SYNTHETIC_CASES.find((c) => c.name.startsWith("adversarial"))!;
		const payload = describeDryRunPayload({
			text: injectionCase.text,
			brand: injectionCase.brand,
			competitors: [...injectionCase.competitors],
		});

		expect((payload.state as { answer_text: string }).answer_text).toBe(injectionCase.text);

		for (const question of Object.values(payload.questions) as Array<{ instructions?: unknown }>) {
			const instructions = JSON.stringify(question.instructions ?? "");
			expect(instructions).not.toContain("Ignore all previous instructions");
			expect(instructions).not.toContain(injectionCase.text);
		}
	});

	it("emits exactly one question per entity (brand + each competitor)", () => {
		const brand = makeBrand();
		const competitors = [makeCompetitor(), makeCompetitor({ id: "c2", name: "Otterly" })];
		const payload = describeDryRunPayload({ text: "some text", brand, competitors });
		expect(Object.keys(payload.questions)).toHaveLength(1 + competitors.length);
	});
});

describe("classifyMentions: dry-run mode", () => {
	it("returns the request shape without needing an API key", async () => {
		const brand = makeBrand();
		const outcome = await classifyMentions(
			{ text: "Elmo shows up here.", brand, competitors: [] },
			{ enabled: true, dryRun: true },
		);
		expect(outcome.status).toBe("dry_run");
	});
});

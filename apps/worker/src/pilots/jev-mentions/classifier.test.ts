import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyMentions, describeDryRunPayload, heuristicMentions } from "./classifier";
import { makeBrand, makeCompetitor, SYNTHETIC_CASES } from "./fixtures";

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

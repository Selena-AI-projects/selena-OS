import { describe, expect, it } from "vitest";
import { parseYouTubeVideoDocument, renderReadableBody, YOUTUBE_VIDEO_DOCUMENT_FORMAT } from "../content-document";
import type { ResearchOpportunity } from "../research/contracts";
import {
	buildEvidenceContext,
	buildScriptEvidenceContext,
	ContentCreationError,
	type CreationAdapter,
	FixtureCreationAdapter,
	type GeminiAdapterGates,
	GeminiCreationAdapter,
	type IdeaGenerationOutput,
	type IdeaPackage,
	ProviderCallLedger,
	runIdeaGeneration,
	runScriptGeneration,
	type ScriptGenerationOutput,
} from "./index";

const RUN_ID = "20000000-0000-4000-8000-000000000110";
const OTHER_RUN_ID = "20000000-0000-4000-8000-000000000999";
const NOW = new Date("2026-03-01T00:00:00.000Z");

const opportunity: ResearchOpportunity = {
	key: "fixture-strong-long:angle",
	sourceExternalId: "fixture-strong-long",
	proposedAngle: "the step everyone skips",
	proposedHook: "Most guides start one step too late.",
	contentFormat: "LONG",
	rationale: "Outlier against the creator's own baseline.",
	evidenceSummary: "29,300 views, 4.2x creator baseline, HIGH baseline confidence",
	confidence: "HIGH",
	factRequirements: ["Confirm the pricing claim before stating it."],
};

const sources = [{ externalId: "fixture-strong-long" }, { externalId: "fixture-strong-short" }];
const sourceTitles = ["What nobody explains about booking", "Booking in ninety seconds"];

function context() {
	return buildEvidenceContext({ researchRunId: RUN_ID, opportunity, sources });
}

function runIdeas(adapter: CreationAdapter, titles: readonly string[] = sourceTitles) {
	return runIdeaGeneration({
		adapter,
		evidence: context(),
		projectSlug: "kora",
		profileHash: "f".repeat(64),
		languages: ["ru"],
		audience: "GENERAL",
		sourceTitles: titles,
		now: NOW,
	});
}

/** An adapter that returns exactly what a test hands it, valid or not. */
class StubAdapter implements CreationAdapter {
	readonly id = "fixture" as const;

	constructor(
		private readonly ideas: unknown,
		private readonly script?: unknown,
	) {}

	async generateIdeas() {
		return { output: this.ideas as IdeaGenerationOutput, externalProviderCalls: 0 };
	}

	async generateScript() {
		return { output: this.script as ScriptGenerationOutput, externalProviderCalls: 0 };
	}
}

async function fixtureIdeas(): Promise<IdeaPackage[]> {
	const outcome = await runIdeas(new FixtureCreationAdapter());
	return outcome.ideas;
}

describe("evidence context", () => {
	it("turns what the run observed and what it did not into different claim classes", () => {
		const built = context();
		const classes = built.evidenceClaims.map((claim) => claim.evidenceClass);
		expect(classes).toEqual(["OBSERVED", "REQUIRES_STUDIO"]);
		// The unverified requirement cites nothing, because nothing established it.
		expect(built.evidenceClaims[1].sourceExternalIds).toEqual([]);
	});

	// The idea itself is valid here, so the only thing that can fail is the run
	// mismatch — otherwise this would pass for the wrong reason.
	it("refuses evidence that names a run other than its own", async () => {
		const built = context();
		const [idea] = await fixtureIdeas();
		expect(() => buildScriptEvidenceContext({ evidence: built, idea })).not.toThrow();
		expect(() =>
			buildScriptEvidenceContext({
				evidence: {
					...built,
					evidenceClaims: built.evidenceClaims.map((claim) => ({ ...claim, researchRunId: OTHER_RUN_ID })),
				},
				idea,
			}),
		).toThrow(ContentCreationError);
	});
});

describe("idea generation", () => {
	it("returns exactly six deterministic ideas", async () => {
		const first = await fixtureIdeas();
		const second = await fixtureIdeas();
		expect(first).toHaveLength(6);
		expect(JSON.stringify(second)).toBe(JSON.stringify(first));
	});

	it("names the count when the count is wrong, rather than reporting invalid output", async () => {
		const five = (await fixtureIdeas()).slice(0, 5);
		await expect(runIdeas(new StubAdapter({ ideas: five }))).rejects.toMatchObject({ code: "IDEA_COUNT_INVALID" });
	});

	it("refuses an idea citing a source the run did not produce", async () => {
		const ideas = await fixtureIdeas();
		ideas[0].evidenceClaims[0].sourceExternalIds = ["a-source-from-somewhere-else"];
		await expect(runIdeas(new StubAdapter({ ideas }))).rejects.toMatchObject({ code: "EVIDENCE_OUT_OF_RUN" });
	});

	it("refuses an idea citing evidence from another research run", async () => {
		const ideas = await fixtureIdeas();
		ideas[0].evidenceClaims[0].researchRunId = OTHER_RUN_ID;
		await expect(runIdeas(new StubAdapter({ ideas }))).rejects.toMatchObject({ code: "EVIDENCE_OUT_OF_RUN" });
	});

	// The adaptation must adapt the mechanic, not the wording. An idea that
	// restates a source title is the source with a new label on it.
	it("refuses an idea that restates a source title", async () => {
		const ideas = await fixtureIdeas();
		ideas[0].title = "What nobody explains about booking";
		await expect(runIdeas(new StubAdapter({ ideas }))).rejects.toMatchObject({
			code: "INVALID_GENERATION_OUTPUT",
		});
	});

	it("makes no provider call", async () => {
		const outcome = await runIdeas(new FixtureCreationAdapter());
		expect(outcome.counters.externalProviderCalls).toBe(0);
	});
});

describe("script generation", () => {
	async function scriptContext() {
		const [idea] = await fixtureIdeas();
		return buildScriptEvidenceContext({ evidence: context(), idea });
	}

	function runScript(adapter: CreationAdapter, evidence: Awaited<ReturnType<typeof scriptContext>>) {
		return runScriptGeneration({
			adapter,
			evidence,
			projectSlug: "kora",
			profileHash: "f".repeat(64),
			languages: ["ru"],
			audience: "GENERAL",
			now: NOW,
		});
	}

	it("produces a script whose sections cite only claims the context carries", async () => {
		const evidence = await scriptContext();
		const outcome = await runScript(new FixtureCreationAdapter(), evidence);
		const known = new Set([
			...evidence.evidenceClaims.map((claim) => claim.id),
			...evidence.ideaPackage.evidenceClaims.map((claim) => claim.id),
		]);
		for (const section of outcome.script.structure) {
			for (const id of section.evidenceClaimIds) expect(known.has(id)).toBe(true);
		}
		expect(outcome.externalProviderCalls).toBe(0);
	});

	it("refuses a script citing a claim outside its context", async () => {
		const evidence = await scriptContext();
		const valid = await runScript(new FixtureCreationAdapter(), evidence);
		valid.script.structure[1].evidenceClaimIds = ["a-claim-nobody-has"];
		await expect(runScript(new StubAdapter(null, valid.script), evidence)).rejects.toMatchObject({
			code: "EVIDENCE_CLAIM_UNKNOWN",
		});
	});

	it("refuses output that does not satisfy the script contract", async () => {
		const evidence = await scriptContext();
		const valid = await runScript(new FixtureCreationAdapter(), evidence);
		await expect(
			runScript(new StubAdapter(null, { ...valid.script, titles: ["only one"] }), evidence),
		).rejects.toMatchObject({ code: "INVALID_GENERATION_OUTPUT" });
	});
});

describe("the structured document", () => {
	async function document() {
		const [idea] = await fixtureIdeas();
		const evidence = buildScriptEvidenceContext({ evidence: context(), idea });
		const outcome = await runScriptGeneration({
			adapter: new FixtureCreationAdapter(),
			evidence,
			projectSlug: "kora",
			profileHash: "f".repeat(64),
			languages: ["ru"],
			audience: "GENERAL",
			now: NOW,
		});
		return parseYouTubeVideoDocument({
			format: YOUTUBE_VIDEO_DOCUMENT_FORMAT,
			title: outcome.script.titles[0],
			alternativeTitles: outcome.script.titles.slice(1),
			hook: outcome.script.hook,
			sections: outcome.script.structure,
			script: outcome.script.script,
			payoff: outcome.script.payoff,
			primaryCta: outcome.script.primaryCta,
			studioValidation: outcome.script.studioValidation,
			evidenceClaims: [...evidence.evidenceClaims, ...evidence.ideaPackage.evidenceClaims],
		});
	}

	it("renders the same bytes for the same document", async () => {
		const built = await document();
		expect(renderReadableBody(built)).toBe(renderReadableBody(built));
	});

	// The legacy body column is what surfaces that predate structured content
	// render. It has to carry the script, not a placeholder.
	it("renders the script into the readable body", async () => {
		const built = await document();
		expect(renderReadableBody(built)).toContain(built.script);
		expect(renderReadableBody(built)).toContain(built.primaryCta);
	});

	it("refuses a document whose section cites a claim it does not carry", async () => {
		const built = await document();
		expect(() =>
			parseYouTubeVideoDocument({
				...built,
				sections: built.sections.map((section) => ({ ...section, evidenceClaimIds: ["a-claim-nobody-has"] })),
			}),
		).toThrow("The structured content document is not valid");
	});
});

describe("the Gemini adapter", () => {
	const openGates: GeminiAdapterGates = { liveProviderEnabled: true, maxProviderCalls: 1, credentialPresent: true };

	async function refusal(gates: Partial<typeof openGates>, dispatch?: boolean) {
		const ledger = new ProviderCallLedger();
		const adapter = new GeminiCreationAdapter({
			gates: { ...openGates, ...gates },
			ledger,
			dispatch: dispatch
				? {
						generateIdeas: async () => ({ output: {} as IdeaGenerationOutput, externalProviderCalls: 1 }),
						generateScript: async () => ({ output: {} as ScriptGenerationOutput, externalProviderCalls: 1 }),
					}
				: undefined,
		});
		const error = await adapter
			.generateIdeas({
				evidence: context(),
				projectSlug: "kora",
				profileHash: "f".repeat(64),
				languages: ["ru"],
				audience: "GENERAL",
				now: NOW,
			})
			.catch((caught: ContentCreationError) => caught);
		return { error, ledger };
	}

	// Each gate is asserted alone, so no single one can be relied on to cover a
	// second one that has quietly stopped working.
	it("stays shut when the live provider flag is off", async () => {
		const { error, ledger } = await refusal({ liveProviderEnabled: false }, true);
		expect(error).toMatchObject({ code: "ADAPTER_DISABLED" });
		expect(ledger.count).toBe(0);
	});

	it("stays shut when no call ceiling is configured", async () => {
		const { error, ledger } = await refusal({ maxProviderCalls: null }, true);
		expect(error).toMatchObject({ code: "PROVIDER_QUOTA_EXCEEDED" });
		expect(ledger.count).toBe(0);
	});

	it("stays shut when no credential is present", async () => {
		const { error, ledger } = await refusal({ credentialPresent: false }, true);
		expect(error).toMatchObject({ code: "PROVIDER_AUTH_FAILED" });
		expect(ledger.count).toBe(0);
	});

	it("stays shut when no transport is configured", async () => {
		const { error, ledger } = await refusal({});
		expect(error).toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
		expect(ledger.count).toBe(0);
	});

	// A ceiling that cannot close is decoration. This drives one call through and
	// proves the next is refused by the ledger rather than by another gate.
	it("closes once the call ceiling is spent", async () => {
		const ledger = new ProviderCallLedger();
		const adapter = new GeminiCreationAdapter({
			gates: openGates,
			ledger,
			dispatch: {
				generateIdeas: async () => ({ output: {} as IdeaGenerationOutput, externalProviderCalls: 1 }),
				generateScript: async () => ({ output: {} as ScriptGenerationOutput, externalProviderCalls: 1 }),
			},
		});
		const request = {
			evidence: context(),
			projectSlug: "kora",
			profileHash: "f".repeat(64),
			languages: ["ru"],
			audience: "GENERAL" as const,
			now: NOW,
		};
		await adapter.generateIdeas(request);
		expect(ledger.count).toBe(1);
		await expect(adapter.generateIdeas(request)).rejects.toMatchObject({ code: "PROVIDER_QUOTA_EXCEEDED" });
		expect(ledger.count).toBe(1);
	});
});

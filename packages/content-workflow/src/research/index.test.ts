import { describe, expect, it } from "vitest";
import { normalizeProfile, type ProjectProfileInput, profileHash } from "../profile/index";
import {
	ContentResearchError,
	deriveResearchProject,
	FixtureResearchAdapter,
	isTooSimilarToSource,
	ProviderCallLedger,
	type ResearchProject,
	type ResearchSource,
	runResearchPipeline,
	VideoRadarAdapter,
	validateOpportunityDecision,
} from "./index";

const profileInput: ProjectProfileInput = {
	languages: ["en"],
	audience: {
		primary: "independent studio owners",
		secondary: ["studio managers"],
		needs: ["booking workflow", "client retention"],
	},
	voice: { traits: ["direct"], examples: [], exclusions: ["guaranteed revenue"] },
	ctaRules: [],
	visualRules: { palette: [], imagery: [], avoid: ["stock robots"] },
	claimRules: { requireSources: true, allowedStates: ["VERIFIED"] },
	facts: [
		{
			id: "retention",
			statement: "Client retention improves when reminders are automated",
			state: "VERIFIED",
			sourceRefs: ["https://example.com/retention"],
		},
	],
	sourceRefs: [{ uri: "https://example.com/retention" }],
};

const NOW = new Date("2026-02-01T00:00:00.000Z");

function project(): ResearchProject {
	const profile = normalizeProfile(profileInput);
	return deriveResearchProject({
		brandId: "brand-a",
		profileVersionId: "11111111-1111-4111-8111-111111111111",
		profileHash: profileHash(profile),
		profile,
	});
}

function run(adapter = new FixtureResearchAdapter()) {
	return runResearchPipeline({
		project: project(),
		adapter,
		now: NOW,
		verifiedFactStatements: ["Client retention improves when reminders are automated"],
	});
}

describe("research project derivation", () => {
	it("derives the same project from the same confirmed profile", () => {
		expect(deriveResearchProject({ ...deriveInput(), profile: normalizeProfile(profileInput) })).toEqual(project());
	});

	it("refuses a profile with no audience or voice terms to research against", () => {
		const empty = normalizeProfile({
			...profileInput,
			audience: { primary: "a", secondary: [], needs: [] },
			voice: { traits: ["ab"], examples: [], exclusions: [] },
		});
		expect(() => deriveResearchProject({ ...deriveInput(), profile: empty })).toThrow(ContentResearchError);
	});

	it("carries the brand's own exclusions into negative keywords", () => {
		expect(project().negativeKeywords).toContain("guaranteed revenue");
		expect(project().negativeKeywords).toContain("stock robots");
	});

	function deriveInput() {
		const profile = normalizeProfile(profileInput);
		return {
			brandId: "brand-a",
			profileVersionId: "11111111-1111-4111-8111-111111111111",
			profileHash: profileHash(profile),
			profile,
		};
	}
});

describe("fixture research run", () => {
	it("produces byte-identical output for the same inputs", async () => {
		const first = await run();
		const second = await run();
		expect(JSON.stringify(second)).toBe(JSON.stringify(first));
	});

	it("makes no external provider call", async () => {
		expect((await run()).counters.externalProviderCalls).toBe(0);
	});

	it("shortlists only what clears the quality gate", async () => {
		const outcome = await run();
		for (const entry of outcome.scored) {
			expect(entry.shortlisted).toBe(entry.gateReasons.length === 0);
		}
		expect(outcome.counters.shortlisted).toBeGreaterThan(0);
	});

	it("explains every score it reports", async () => {
		const outcome = await run();
		for (const entry of outcome.scored) {
			expect(entry.score.components.length).toBeGreaterThan(0);
			// A component that had no data contributes nothing rather than a zero
			// that would read as a measured result.
			for (const component of entry.score.components) {
				if (!component.available) expect(component.contribution).toBe(0);
			}
		}
	});

	it("records an unavailable transcript as unavailable rather than empty text", async () => {
		const outcome = await run();
		for (const entry of outcome.scored) {
			if (entry.source.transcript.status !== "AVAILABLE") {
				expect(entry.source.transcript.text).toBeNull();
				expect(entry.source.transcript.failureReason).not.toBeNull();
			}
		}
		expect(outcome.counters.transcriptsUnavailable).toBeGreaterThan(0);
	});

	it("attaches evidence and a source to every opportunity", async () => {
		const outcome = await run();
		expect(outcome.opportunities.length).toBeGreaterThan(0);
		const externalIds = new Set(outcome.scored.map((entry) => entry.source.externalId));
		for (const opportunity of outcome.opportunities) {
			expect(externalIds.has(opportunity.sourceExternalId)).toBe(true);
			expect(opportunity.evidenceSummary.length).toBeGreaterThan(0);
		}
	});

	it("flags a brand term that no verified fact supports", async () => {
		const outcome = await runResearchPipeline({
			project: project(),
			adapter: new FixtureResearchAdapter(),
			now: NOW,
			verifiedFactStatements: [],
		});
		expect(outcome.opportunities[0]?.factRequirements.length).toBeGreaterThan(0);
	});

	it("drops a source that arrives without usable provenance", async () => {
		const outcome = await run(new ProvenanceLessAdapter());
		expect(outcome.counters.sourcesScored).toBe(0);
		expect(outcome.failures.map((failure) => failure.code)).toEqual(["MISSING_PROVENANCE"]);
		expect(outcome.status).toBe("PARTIAL");
	});

	it("counts a repeated source once", async () => {
		const outcome = await run(new DuplicatingAdapter());
		expect(outcome.counters.duplicateSourcesDropped).toBe(1);
		expect(outcome.counters.sourcesScored).toBe(1);
	});

	it("rejects an adaptation that stays too close to the source", async () => {
		const outcome = await run(new EchoingAdapter());
		expect(outcome.counters.opportunitiesRejectedByAntiCopy).toBeGreaterThan(0);
		expect(outcome.opportunities).toHaveLength(0);
	});
});

describe("anti-copy rule", () => {
	it("catches a title with the nouns replaced", () => {
		expect(
			isTooSimilarToSource("How I doubled my studio bookings in 30 days", "How I doubled my salon bookings in 30 days"),
		).toBe(true);
	});

	it("accepts a genuinely different angle", () => {
		expect(
			isTooSimilarToSource("How I doubled my studio bookings in 30 days", "What reminder timing actually changes"),
		).toBe(false);
	});
});

describe("video radar adapter", () => {
	const request = { project: project(), now: NOW };

	function adapter(
		overrides: Partial<{ liveProviderEnabled: boolean; maxProviderCalls: number | null; credentialPresent: boolean }>,
		ledger: ProviderCallLedger,
	) {
		return new VideoRadarAdapter({
			gates: { liveProviderEnabled: true, maxProviderCalls: 5, credentialPresent: true, ...overrides },
			ledger,
			dispatch: async () => {
				throw new Error("the dispatcher must never be reached in Stage 1");
			},
		});
	}

	it("fails closed when the live provider flag is absent", async () => {
		const ledger = new ProviderCallLedger();
		await expect(adapter({ liveProviderEnabled: false }, ledger).fetch(request)).rejects.toMatchObject({
			code: "ADAPTER_DISABLED",
		});
		expect(ledger.count).toBe(0);
	});

	it("fails closed when no call ceiling is configured", async () => {
		const ledger = new ProviderCallLedger();
		await expect(adapter({ maxProviderCalls: null }, ledger).fetch(request)).rejects.toMatchObject({
			code: "PROVIDER_QUOTA_EXCEEDED",
		});
		expect(ledger.count).toBe(0);
	});

	it("fails closed when no credential is present", async () => {
		const ledger = new ProviderCallLedger();
		await expect(adapter({ credentialPresent: false }, ledger).fetch(request)).rejects.toMatchObject({
			code: "PROVIDER_AUTH_FAILED",
		});
		expect(ledger.count).toBe(0);
	});

	it("fails closed when every gate is open but no transport is configured", async () => {
		const ledger = new ProviderCallLedger();
		const withoutDispatch = new VideoRadarAdapter({
			gates: { liveProviderEnabled: true, maxProviderCalls: 5, credentialPresent: true },
			ledger,
		});
		await expect(withoutDispatch.fetch(request)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
		expect(ledger.count).toBe(0);
	});

	// A ceiling is only a ceiling if the ledger it counts against outlives one
	// call. With a fresh ledger per call the count is always zero and the gate
	// never closes, so this exercises a ledger that persists across calls.
	it("stops dispatching once the call ceiling is reached", async () => {
		const ledger = new ProviderCallLedger();
		const dispatched = new VideoRadarAdapter({
			gates: { liveProviderEnabled: true, maxProviderCalls: 1, credentialPresent: true },
			ledger,
			dispatch: async () => ({ sources: [], provenance: [], externalProviderCalls: 1 }),
		});
		await expect(dispatched.fetch(request)).resolves.toMatchObject({ externalProviderCalls: 1 });
		expect(ledger.count).toBe(1);
		await expect(dispatched.fetch(request)).rejects.toMatchObject({ code: "PROVIDER_QUOTA_EXCEEDED" });
		expect(ledger.count).toBe(1);
	});
});

describe("opportunity decisions", () => {
	const base = { organizationId: "org", brandId: "brand-a", opportunityId: "opp-1" } as const;

	it("requires a reason to reject", () => {
		expect(() => validateOpportunityDecision({ ...base, decision: "REJECTED" })).toThrow(ContentResearchError);
	});

	it("refuses to decide back into the initial state", () => {
		expect(() => validateOpportunityDecision({ ...base, decision: "NEW" })).toThrow(ContentResearchError);
	});

	it("accepts saving and sending to creation", () => {
		expect(() => validateOpportunityDecision({ ...base, decision: "SAVED" })).not.toThrow();
		expect(() => validateOpportunityDecision({ ...base, decision: "SENT_TO_CREATION" })).not.toThrow();
	});
});

function fixtureSource(overrides: Partial<ResearchSource> = {}): ResearchSource {
	return {
		externalId: "source-1",
		platform: "youtube",
		channelId: "channel-1",
		channelName: "Channel One",
		title: "Booking workflow lessons",
		description: "About booking workflow and client retention",
		sourceUrl: "https://example.test/source-1",
		publishedAt: "2026-01-01T00:00:00.000Z",
		durationSeconds: 600,
		language: "en",
		views: 20_000,
		likes: 1_000,
		comments: 80,
		channelHistory: Array.from({ length: 16 }, (_, index) => ({
			externalId: `history-${index}`,
			publishedAt: new Date(Date.parse("2026-01-01T00:00:00.000Z") - (index + 1) * 168 * 3_600_000).toISOString(),
			durationSeconds: 600,
			views: 5_000,
		})),
		snapshots: [],
		transcript: { status: "AVAILABLE", language: "en", text: "transcript", failureReason: null },
		creatorPriority: 5,
		...overrides,
	};
}

class ProvenanceLessAdapter extends FixtureResearchAdapter {
	override async fetch() {
		return { sources: [fixtureSource()], provenance: [], externalProviderCalls: 0 };
	}
}

class DuplicatingAdapter extends FixtureResearchAdapter {
	override async fetch() {
		const source = fixtureSource();
		return {
			sources: [source, source],
			provenance: [
				{
					adapterId: "fixture" as const,
					platform: "youtube" as const,
					externalId: source.externalId,
					sourceUrl: source.sourceUrl,
					capturedAt: NOW.toISOString(),
				},
			],
			externalProviderCalls: 0,
		};
	}
}

/** Returns a source whose title is the brand's own vocabulary, so any proposal echoes it. */
class EchoingAdapter extends FixtureResearchAdapter {
	override async fetch() {
		const source = fixtureSource({
			externalId: "echo-1",
			title: "The part of booking workflow that gets skipped",
			sourceUrl: "https://example.test/echo-1",
		});
		return {
			sources: [source],
			provenance: [
				{
					adapterId: "fixture" as const,
					platform: "youtube" as const,
					externalId: source.externalId,
					sourceUrl: source.sourceUrl,
					capturedAt: NOW.toISOString(),
				},
			],
			externalProviderCalls: 0,
		};
	}
}

import { runOutcomeSchema } from "@workspace/selena-visibility-contracts";
import { describe, expect, it } from "vitest";
import type { ExtractionContext } from "../selena-answer-extraction";
import type { SelenaExecutablePermit } from "../selena-measurement";
import {
	createStubMeasurementAdapter,
	STUB_GAP_SOURCE,
	STUB_MODEL,
	STUB_PROVIDER,
	STUB_SOURCE_POOL,
	stubAnswer,
} from "./stub-measurement-adapter";

const context: ExtractionContext = {
	brandTerms: ["KORA Food Hall", "korafoodhall.com"],
	ownedDomains: ["korafoodhall.com"],
	competitors: [
		{ name: "Rival Cafe", terms: ["Rival Cafe"] },
		{ name: "Other Place", terms: ["Other Place"] },
	],
	language: "en",
	region: "ID",
};

function permitFor(overrides: Partial<SelenaExecutablePermit> = {}): SelenaExecutablePermit {
	return {
		id: "permit-1",
		organizationId: "org-1",
		cycleId: "cycle-1",
		scenarioId: "scenario-1",
		systemId: "chatgpt",
		channel: "API",
		dispatchKey: "order-1:scenario-1:chatgpt:0:1",
		expiresAt: new Date("2026-08-21T11:00:00.000Z"),
		consumedAt: null,
		...overrides,
	};
}

const adapter = createStubMeasurementAdapter({ resolveExtractionContext: () => context });

describe("createStubMeasurementAdapter", () => {
	it("produces a contract-valid outcome attributed to the permit's own system", async () => {
		const outcome = runOutcomeSchema.parse(await adapter.execute(permitFor()));
		expect(outcome.status).toBe("SUCCEEDED");
		expect(outcome.validity).toBe("VALID");
		expect(outcome.measurement?.system).toBe("chatgpt");
		expect(outcome.measurement?.model).toBe(STUB_MODEL);
		expect(outcome.measurement?.language).toBe("en");
	});

	it("leaves the rehearsal recognizable as one in every field it writes", async () => {
		const outcome = await adapter.execute(permitFor());
		expect(outcome.costUsd).toBe(0);
		expect(outcome.provider).toBe(STUB_PROVIDER);
		expect(outcome.rawResponseReference).toMatch(/^stub:sha256:[0-9a-f]{64}$/);
	});

	it("answers the same way for the same permit and differently across permits", () => {
		expect(stubAnswer(permitFor(), context)).toBe(stubAnswer(permitFor(), context));
		const answers = new Set(
			Array.from({ length: 40 }, (_, i) => stubAnswer(permitFor({ dispatchKey: `key-${i}` }), context)),
		);
		expect(answers.size).toBeGreaterThan(1);
	});

	it("names the brand in some runs and not others, so coverage is not a constant", () => {
		const mentioning = Array.from({ length: 40 }, (_, i) =>
			stubAnswer(permitFor({ dispatchKey: `key-${i}` }), context).includes("KORA Food Hall"),
		);
		expect(mentioning.some(Boolean)).toBe(true);
		expect(mentioning.some((seen) => !seen)).toBe(true);
	});

	it("cites a source that is not the brand's own, so the opportunity map has data", async () => {
		const outcome = await adapter.execute(permitFor());
		const domains = outcome.measurement?.citations.map((citation) => citation.domain) ?? [];
		expect(domains.some((domain) => [...STUB_SOURCE_POOL, STUB_GAP_SOURCE].includes(domain))).toBe(true);
	});

	it("keeps one source to answers that leave the brand out, so the gap path has data", async () => {
		const outcomes = await Promise.all(
			Array.from({ length: 40 }, (_, i) => adapter.execute(permitFor({ dispatchKey: `key-${i}` }))),
		);
		const gapRuns = outcomes.filter((outcome) =>
			outcome.measurement?.citations.some((citation) => citation.domain === STUB_GAP_SOURCE),
		);
		expect(gapRuns.length).toBeGreaterThan(0);
		expect(gapRuns.every((outcome) => outcome.measurement?.mention === false)).toBe(true);
	});

	it("records an unusable context as INVALID instead of measuring nothing into the ledger", async () => {
		const failing = createStubMeasurementAdapter({
			resolveExtractionContext: () => {
				throw new Error("SELENA_PROJECT_PROFILE_NOT_FOUND");
			},
		});
		const outcome = runOutcomeSchema.parse(await failing.execute(permitFor()));
		expect(outcome.validity).toBe("INVALID");
		expect(outcome.invalidReason).toBe("STUB_EXTRACTION_CONTEXT_UNAVAILABLE");
		expect(outcome.measurement).toBeUndefined();
	});

	it("refuses a permit from another channel", async () => {
		await expect(adapter.measure({ ...permitFor(), channel: "visitor_view" } as never)).rejects.toThrow(
			"MEASUREMENT_CHANNEL_MISMATCH",
		);
	});
});

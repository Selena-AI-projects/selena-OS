import { describe, expect, it } from "vitest";
import {
	LOCAL_AI_DISCOVERY_POLICY,
	type LocalAiDiscoveryLockBlock,
	type ObserverContext,
	type PilotObservation,
	assertCaptureMethodAllowed,
	assertClientResultsAllowed,
	assertLocalDiscoveryEnabled,
	assertManualPilotAllowed,
	assertMentionMatch,
	assertObservationCardinality,
	assertObservationSubmission,
	contextHash,
	entityInclusionRate,
	expectedObservations,
	explicitAveragePosition,
	factualErrorRate,
	familyEntityIds,
	familyPresenceRate,
	isCountableMention,
	localAiDiscoveryLockBlockSchema,
	localDiscoveryConfigFromEnv,
	observationSubmissionViolations,
	observerContextSchema,
	repeatStability,
	resolveExplicitPosition,
	visibleSourceRate,
} from "./local-discovery";

describe("Selena local AI discovery boundary", () => {
	it("defaults every flag to off", () => {
		const config = localDiscoveryConfigFromEnv({});
		expect(config).toEqual({ enabled: false, manualPilotEnabled: false, clientResultsEnabled: false });
		expect(() => assertLocalDiscoveryEnabled(config)).toThrow("LOCAL_AI_DISCOVERY_DISABLED");
		expect(() => assertManualPilotAllowed(config)).toThrow("LOCAL_AI_DISCOVERY_DISABLED");
		expect(() => assertClientResultsAllowed(config)).toThrow("LOCAL_AI_DISCOVERY_DISABLED");
	});

	it("gates the manual pilot behind both flags", () => {
		const pilotOnly = localDiscoveryConfigFromEnv({ ASK_MAPS_MANUAL_PILOT_ENABLED: "true" });
		expect(() => assertManualPilotAllowed(pilotOnly)).toThrow("LOCAL_AI_DISCOVERY_DISABLED");
		const discoveryOnly = localDiscoveryConfigFromEnv({ LOCAL_AI_DISCOVERY_ENABLED: "true" });
		expect(() => assertManualPilotAllowed(discoveryOnly)).toThrow("ASK_MAPS_MANUAL_PILOT_DISABLED");
		const both = localDiscoveryConfigFromEnv({
			LOCAL_AI_DISCOVERY_ENABLED: "true",
			ASK_MAPS_MANUAL_PILOT_ENABLED: "true",
		});
		expect(() => assertManualPilotAllowed(both)).not.toThrow();
	});

	it("gates client-facing results behind all three flags", () => {
		const pilot = localDiscoveryConfigFromEnv({
			LOCAL_AI_DISCOVERY_ENABLED: "true",
			ASK_MAPS_MANUAL_PILOT_ENABLED: "true",
		});
		expect(() => assertClientResultsAllowed(pilot)).toThrow("LOCAL_AI_DISCOVERY_CLIENT_RESULTS_DISABLED");
		const full = localDiscoveryConfigFromEnv({
			LOCAL_AI_DISCOVERY_ENABLED: "true",
			ASK_MAPS_MANUAL_PILOT_ENABLED: "true",
			LOCAL_AI_DISCOVERY_CLIENT_RESULTS_ENABLED: "true",
		});
		expect(() => assertClientResultsAllowed(full)).not.toThrow();
		const skipPilot = localDiscoveryConfigFromEnv({
			LOCAL_AI_DISCOVERY_ENABLED: "true",
			LOCAL_AI_DISCOVERY_CLIENT_RESULTS_ENABLED: "true",
		});
		expect(() => assertClientResultsAllowed(skipPilot)).toThrow("ASK_MAPS_MANUAL_PILOT_DISABLED");
	});

	it("blocks every non-manual capture method deterministically", () => {
		for (const method of ["AUTOMATED", "SCRAPING", "API", "", "manual_observation"]) {
			expect(() => assertCaptureMethodAllowed(method)).toThrow("AUTOMATION_BLOCKED");
		}
		expect(() => assertCaptureMethodAllowed("MANUAL_OBSERVATION")).not.toThrow();
	});

	it("keeps the policy entry frozen", () => {
		expect(Object.isFrozen(LOCAL_AI_DISCOVERY_POLICY)).toBe(true);
		expect(() => {
			(LOCAL_AI_DISCOVERY_POLICY as Record<string, unknown>).automatedExecutionAllowed = true;
		}).toThrow(TypeError);
		expect(LOCAL_AI_DISCOVERY_POLICY.automatedExecutionAllowed).toBe(false);
		expect(LOCAL_AI_DISCOVERY_POLICY.captureMethod).toBe("MANUAL_OBSERVATION");
		expect(LOCAL_AI_DISCOVERY_POLICY.policyVersion).toBe("local-ai-discovery-v1");
	});
});

// RC7 reference fixture: KORA Food Hall master brand with the Two Moons Spa
// concept inside it (fixture lives only in tests, never in product code).
const koraId = "11111111-1111-4111-8111-111111111111";
const twoMoonsId = "22222222-2222-4222-8222-222222222222";
const scenarioSpaId = "33333333-3333-4333-8333-333333333333";
const scenarioFoodId = "44444444-4444-4444-8444-444444444444";

const moscowContext: ObserverContext = {
	observerCountryCode: "RU",
	observerLocality: "Moscow",
	observerGeoMode: "DECLARED_AREA",
	appLocale: "ru-RU",
	queryLanguage: "ru",
	deviceClass: "MOBILE_ANDROID",
	accountState: "SIGNED_OUT",
	personalizationState: "OFF",
	timezone: "Europe/Moscow",
	capturedAt: "2026-08-17T10:00:00.000Z",
};

const lockBlock: LocalAiDiscoveryLockBlock = localAiDiscoveryLockBlockSchema.parse({
	schemaVersion: 1,
	surface: "GOOGLE_ASK_MAPS",
	captureMethod: "MANUAL_OBSERVATION",
	externalCallsAllowed: false,
	placesApiAllowed: false,
	policyVersion: "local-ai-discovery-v1",
	captureProtocolVersion: "capture-protocol-v1",
	entities: [
		{ entityId: koraId, name: "KORA Food Hall", aliases: ["KORA"], entityKind: "MASTER_BRAND" },
		{ entityId: twoMoonsId, name: "Two Moons Spa", aliases: [], entityKind: "CONCEPT" },
	],
	entityRelationships: [{ parentEntityId: koraId, childEntityId: twoMoonsId, relation: "CONCEPT_WITHIN" }],
	businessLocations: [
		{
			locationId: "55555555-5555-4555-8555-555555555555",
			entityId: koraId,
			displayName: "KORA Food Hall Moscow",
			countryCode: "RU",
			locality: "Moscow",
		},
	],
	scenarios: [
		{ scenarioId: scenarioSpaId, queryText: "лучший спа рядом", language: "ru", targetEntityIds: [twoMoonsId] },
		{ scenarioId: scenarioFoodId, queryText: "куда сходить поесть", language: "ru", targetEntityIds: [koraId] },
	],
	observerContexts: [moscowContext],
	repeats: 2,
	expectedObservations: 4,
	evidencePolicy: {
		queryRequired: true,
		contextRequired: true,
		timestampRequired: true,
		transcriptRequired: true,
		screenshotRequired: true,
		visibleSourcesOptional: true,
	},
});

const hash = contextHash(moscowContext);
const observation = (overrides: Partial<PilotObservation>): PilotObservation => ({
	scenarioId: scenarioSpaId,
	contextHash: hash,
	repeatIndex: 0,
	reviewStatus: "ACCEPTED",
	orderingState: "UNORDERED",
	mentions: [],
	...overrides,
});
const koraMention = { matchedEntityId: koraId, matchStatus: "EXACT_ALIAS" as const };
const twoMoonsMention = { matchedEntityId: twoMoonsId, matchStatus: "REVIEWED_MATCH" as const };

describe("RC7 observer context and context hash", () => {
	it("rejects any Google account, email or device identifier field", () => {
		for (const forbidden of [
			{ googleAccountEmail: "user@example.com" },
			{ googleAccountId: "g-123" },
			{ deviceIdentifier: "device-42" },
		]) {
			expect(observerContextSchema.safeParse({ ...moscowContext, ...forbidden }).success).toBe(false);
		}
		expect(observerContextSchema.safeParse(moscowContext).success).toBe(true);
	});

	it("hashes conditions, not the capture moment", () => {
		expect(contextHash({ ...moscowContext, capturedAt: "2026-08-18T22:15:00.000Z" })).toBe(hash);
		expect(contextHash(moscowContext)).toMatch(/^[0-9a-f]{64}$/);
		expect(contextHash({ ...moscowContext, observerLocality: "Kazan" })).not.toBe(hash);
	});
});

describe("RC7 lock block and observation cardinality", () => {
	it("accepts the KORA lock block and computes cardinality without entities", () => {
		expect(lockBlock.expectedObservations).toBe(4);
		expect(expectedObservations(lockBlock.scenarios, lockBlock.observerContexts, lockBlock.repeats)).toBe(4);
		expect(expectedObservations(2, 3, 2)).toBe(12);
	});

	it("rejects a block that relaxes the manual-only literals", () => {
		expect(localAiDiscoveryLockBlockSchema.safeParse({ ...lockBlock, externalCallsAllowed: true }).success).toBe(false);
		expect(localAiDiscoveryLockBlockSchema.safeParse({ ...lockBlock, placesApiAllowed: true }).success).toBe(false);
		expect(localAiDiscoveryLockBlockSchema.safeParse({ ...lockBlock, surface: "GOOGLE_PLACES" }).success).toBe(false);
		expect(localAiDiscoveryLockBlockSchema.safeParse({ ...lockBlock, captureMethod: "API" }).success).toBe(false);
	});

	it("rejects a block whose expectedObservations disagrees with the matrix", () => {
		const result = localAiDiscoveryLockBlockSchema.safeParse({ ...lockBlock, expectedObservations: 5 });
		expect(result.success).toBe(false);
		expect(JSON.stringify(result.error?.issues)).toContain("OBSERVATION_CARDINALITY_MISMATCH");
	});

	it("rejects references to entities missing from the lock", () => {
		const ghost = "99999999-9999-4999-8999-999999999999";
		expect(
			localAiDiscoveryLockBlockSchema.safeParse({
				...lockBlock,
				entityRelationships: [{ parentEntityId: koraId, childEntityId: ghost, relation: "CONCEPT_WITHIN" }],
			}).success,
		).toBe(false);
	});

	it("blocks observation expected+1", () => {
		expect(() => assertObservationCardinality(3, 4)).not.toThrow();
		expect(() => assertObservationCardinality(4, 4)).toThrow("OBSERVATION_CARDINALITY_BLOCKED");
		expect(() => assertObservationCardinality(5, 4)).toThrow("OBSERVATION_CARDINALITY_BLOCKED");
		expect(() => assertObservationCardinality(-1, 4)).toThrow("OBSERVATION_CARDINALITY_INVALID");
		expect(() => expectedObservations(2, 1, -1)).toThrow("OBSERVATION_CARDINALITY_INVALID");
	});
});

describe("RC7 observation submission evidence policy", () => {
	const submission = {
		queryText: "лучший спа рядом",
		context: moscowContext,
		capturedAt: "2026-08-17T10:05:00.000Z",
		transcript: "Ответ Ask Maps…",
		screenshotReference: "evidence/obs-1/screen-1.png",
	};

	it("accepts a complete submission", () => {
		expect(() => assertObservationSubmission(submission, lockBlock.evidencePolicy)).not.toThrow();
	});

	it("reports each missing evidence field with its own code", () => {
		expect(observationSubmissionViolations({ ...submission, queryText: " " }, lockBlock.evidencePolicy)).toEqual([
			"OBSERVATION_MISSING_QUERY_TEXT",
		]);
		expect(
			observationSubmissionViolations({ ...submission, context: { junk: true } }, lockBlock.evidencePolicy),
		).toEqual(["OBSERVATION_MISSING_CONTEXT"]);
		expect(
			observationSubmissionViolations({ ...submission, capturedAt: "not-a-date" }, lockBlock.evidencePolicy),
		).toEqual(["OBSERVATION_MISSING_CAPTURED_AT"]);
		expect(() => assertObservationSubmission({ ...submission, transcript: null }, lockBlock.evidencePolicy)).toThrow(
			"OBSERVATION_MISSING_TRANSCRIPT",
		);
		expect(() =>
			assertObservationSubmission({ ...submission, screenshotReference: undefined }, lockBlock.evidencePolicy),
		).toThrow("OBSERVATION_MISSING_SCREENSHOT");
	});
});

describe("RC7 mention rules", () => {
	it("allows an explicit position only for explicitly ordered answers", () => {
		expect(resolveExplicitPosition("EXPLICIT_ORDER", 2)).toBe(2);
		expect(resolveExplicitPosition("UNORDERED", null)).toBeNull();
		expect(() => resolveExplicitPosition("UNORDERED", 1)).toThrow("MENTION_POSITION_WITHOUT_EXPLICIT_ORDER");
		expect(() => resolveExplicitPosition("UNKNOWN", 1)).toThrow("MENTION_POSITION_WITHOUT_EXPLICIT_ORDER");
		expect(() => resolveExplicitPosition("EXPLICIT_ORDER", 0)).toThrow("MENTION_POSITION_INVALID");
	});

	it("never counts an ambiguous UNRESOLVED name as a mention", () => {
		expect(isCountableMention({ matchStatus: "UNRESOLVED", matchedEntityId: null })).toBe(false);
		expect(isCountableMention(koraMention)).toBe(true);
		expect(() => assertMentionMatch({ matchStatus: "UNRESOLVED", matchedEntityId: koraId })).toThrow(
			"MENTION_UNRESOLVED_WITH_ENTITY",
		);
		expect(() => assertMentionMatch({ matchStatus: "EXACT_ALIAS", matchedEntityId: null })).toThrow(
			"MENTION_MATCH_WITHOUT_ENTITY",
		);
	});
});

describe("RC7 §10 metrics", () => {
	it("keeps KORA Food Hall mentions out of the Two Moons Spa inclusion rate and vice versa", () => {
		const koraOnly = [observation({ mentions: [koraMention] })];
		expect(entityInclusionRate(koraOnly, twoMoonsId)).toBe(0);
		expect(entityInclusionRate(koraOnly, koraId)).toBe(1);
		expect(familyPresenceRate(koraOnly, koraId, lockBlock)).toBe(1);
		const twoMoonsOnly = [observation({ mentions: [twoMoonsMention] })];
		expect(entityInclusionRate(twoMoonsOnly, koraId)).toBe(0);
		expect(entityInclusionRate(twoMoonsOnly, twoMoonsId)).toBe(1);
		expect(familyPresenceRate(twoMoonsOnly, koraId, lockBlock)).toBe(1);
	});

	it("computes the family subtree over confirmed lock entities only", () => {
		expect(familyEntityIds(lockBlock, koraId)).toEqual(new Set([koraId, twoMoonsId]));
		const ghost = "99999999-9999-4999-8999-999999999999";
		const blockWithGhostRelation = {
			entities: lockBlock.entities,
			entityRelationships: [
				...lockBlock.entityRelationships,
				{ parentEntityId: koraId, childEntityId: ghost, relation: "CONCEPT_WITHIN" as const },
			],
		};
		expect(familyEntityIds(blockWithGhostRelation, koraId).has(ghost)).toBe(false);
	});

	it("excludes UNRESOLVED mentions from every rate", () => {
		const ambiguous = [observation({ mentions: [{ matchStatus: "UNRESOLVED", matchedEntityId: null }] })];
		expect(entityInclusionRate(ambiguous, twoMoonsId)).toBe(0);
		expect(familyPresenceRate(ambiguous, koraId, lockBlock)).toBe(0);
		expect(factualErrorRate(ambiguous)).toBeNull();
	});

	it("treats SURFACE_UNAVAILABLE as ineligible, not as brand absence", () => {
		const unavailable = [observation({ reviewStatus: "SURFACE_UNAVAILABLE" })];
		expect(entityInclusionRate(unavailable, twoMoonsId)).toBeNull();
		expect(entityInclusionRate([...unavailable, observation({ mentions: [twoMoonsMention] })], twoMoonsId)).toBe(1);
	});

	it("averages explicit positions only for explicitly ordered answers", () => {
		const ordered = observation({
			orderingState: "EXPLICIT_ORDER",
			mentions: [{ ...twoMoonsMention, explicitPosition: 2 }],
		});
		const unordered = observation({ repeatIndex: 1, mentions: [twoMoonsMention] });
		expect(explicitAveragePosition([ordered, unordered], twoMoonsId)).toBe(2);
		expect(explicitAveragePosition([unordered], twoMoonsId)).toBeNull();
	});

	it("measures repeat stability per scenario and context", () => {
		const stable = [
			observation({ mentions: [twoMoonsMention] }),
			observation({ repeatIndex: 1, mentions: [twoMoonsMention] }),
		];
		const unstable = [
			observation({ scenarioId: scenarioFoodId, mentions: [twoMoonsMention] }),
			observation({ scenarioId: scenarioFoodId, repeatIndex: 1, mentions: [] }),
		];
		expect(repeatStability(stable, twoMoonsId)).toBe(1);
		expect(repeatStability([...stable, ...unstable], twoMoonsId)).toBe(0.5);
		expect(repeatStability([observation({ mentions: [twoMoonsMention] })], twoMoonsId)).toBeNull();
	});

	it("keeps unexposed sources out of the citation denominator", () => {
		const shown = observation({ sourcesExposure: "EXPOSED", targetSourceVisible: true });
		const hidden = observation({ repeatIndex: 1, sourcesExposure: "SOURCE_NOT_EXPOSED" });
		const unknown = observation({ repeatIndex: 2, sourcesExposure: "UNKNOWN" });
		expect(visibleSourceRate([shown, hidden, unknown])).toBe(1);
		expect(visibleSourceRate([hidden, unknown])).toBeNull();
	});

	it("computes factual error rate over countable mentions", () => {
		const flagged = observation({ mentions: [{ ...twoMoonsMention, factualError: true }, koraMention] });
		expect(factualErrorRate([flagged])).toBe(0.5);
		expect(factualErrorRate([flagged], twoMoonsId)).toBe(1);
		expect(factualErrorRate([flagged], koraId)).toBe(0);
	});
});

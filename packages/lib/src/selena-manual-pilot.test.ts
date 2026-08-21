import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type LocalAiDiscoveryLockBlock,
	assertObservationCardinality,
	contextHash,
	localAiDiscoveryLockBlockSchema,
} from "@workspace/selena-visibility-contracts";
import { describe, expect, it } from "vitest";
import { observationContentSha256, planCaptureTasks } from "./selena-manual-pilot";

const koraId = "11111111-1111-4111-8111-111111111111";
const twoMoonsId = "22222222-2222-4222-8222-222222222222";
const scenarioSpaId = "33333333-3333-4333-8333-333333333333";
const scenarioFoodId = "44444444-4444-4444-8444-444444444444";

const context = (locality: string) => ({
	observerCountryCode: "RU",
	observerLocality: locality,
	observerGeoMode: "DECLARED_AREA" as const,
	appLocale: "ru-RU",
	queryLanguage: "ru",
	deviceClass: "MOBILE_ANDROID" as const,
	accountState: "SIGNED_OUT" as const,
	personalizationState: "OFF" as const,
	timezone: "Europe/Moscow",
	capturedAt: "2026-08-17T10:00:00.000Z",
});

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
	businessLocations: [],
	scenarios: [
		{ scenarioId: scenarioSpaId, queryText: "лучший спа рядом", language: "ru", targetEntityIds: [twoMoonsId] },
		{ scenarioId: scenarioFoodId, queryText: "куда сходить поесть", language: "ru", targetEntityIds: [koraId] },
	],
	observerContexts: [context("Moscow"), context("Kazan")],
	repeats: 3,
	expectedObservations: 12,
	evidencePolicy: {
		queryRequired: true,
		contextRequired: true,
		timestampRequired: true,
		transcriptRequired: true,
		screenshotRequired: true,
		visibleSourcesOptional: true,
	},
});

describe("Selena manual pilot capture-task planning", () => {
	it("plans exactly expectedObservations tasks: scenarios × contexts × repeats", () => {
		const tasks = planCaptureTasks(lockBlock);
		expect(tasks).toHaveLength(12);
		expect(tasks).toHaveLength(lockBlock.expectedObservations);
		// Entities never multiply cardinality: two entities, still 12 tasks.
		expect(lockBlock.entities).toHaveLength(2);
	});

	it("keys every task uniquely so a duplicate cannot be planned", () => {
		const tasks = planCaptureTasks(lockBlock);
		expect(new Set(tasks.map((task) => task.dedupeKey)).size).toBe(tasks.length);
		expect(
			new Set(tasks.map((task) => `${task.scenarioId}:${task.contextHash}:${task.repeatIndex}`)).size,
		).toBe(tasks.length);
	});

	it("snapshots the scenario query and the context behind its hash", () => {
		const tasks = planCaptureTasks(lockBlock);
		for (const task of tasks) {
			expect(task.contextHash).toBe(contextHash(task.contextSnapshot));
			const scenario = lockBlock.scenarios.find((candidate) => candidate.scenarioId === task.scenarioId);
			expect(task.queryTextSnapshot).toBe(scenario?.queryText);
			expect(task.targetEntityIdsSnapshot).toEqual(scenario?.targetEntityIds);
		}
	});

	it("cannot exceed the lock cardinality: observation expected+1 is blocked", () => {
		expect(() => assertObservationCardinality(11, 12)).not.toThrow();
		expect(() => assertObservationCardinality(12, 12)).toThrow("OBSERVATION_CARDINALITY_BLOCKED");
		// A tampered block whose expectedObservations undercuts the matrix is
		// rejected before any task is planned.
		expect(() => planCaptureTasks({ ...lockBlock, expectedObservations: 11 })).toThrow();
	});

	it("hashes transcripts deterministically", () => {
		expect(observationContentSha256("Ответ Ask Maps")).toBe(observationContentSha256("Ответ Ask Maps"));
		expect(observationContentSha256("a")).not.toBe(observationContentSha256("b"));
		expect(observationContentSha256("a")).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("RC7 zero provider surface invariant", () => {
	const here = dirname(fileURLToPath(import.meta.url));
	const sources = [
		resolve(here, "selena-manual-pilot.ts"),
		resolve(here, "selena-visibility-repositories.ts"),
		resolve(here, "../../selena-visibility-contracts/src/local-discovery.ts"),
	];
	// The manual pilot must be incapable of provider execution: no queue
	// client, no scheduler, no usage/cost accounting, no HTTP call.
	const forbidden = ["boss", "job-scheduler", "usage_events", "usageEvents", "fetch(", "cost.ts", "http://", "https://"];

	it("keeps the manual pilot modules free of provider-execution code", () => {
		for (const source of sources) {
			const text = readFileSync(source, "utf8");
			for (const marker of forbidden) {
				expect(text.includes(marker), `${source} must not contain "${marker}"`).toBe(false);
			}
		}
	});
});

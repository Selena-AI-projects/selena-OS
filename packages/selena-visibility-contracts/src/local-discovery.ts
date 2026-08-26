import { createHash } from "node:crypto";
import { z } from "zod";

// RC7 boundary: Google Ask Maps is a manual-observation-only surface. This
// module is the single policy gate for local AI discovery — the backend must
// never execute, scrape, or resolve an Ask Maps / Places request, so no
// function here (or anywhere else) is allowed to perform an external call.
export const LOCAL_AI_DISCOVERY_POLICY = Object.freeze({
	surface: "GOOGLE_ASK_MAPS",
	surfaceFamily: "LOCAL_AI_DISCOVERY",
	status: "MANUAL_ONLY",
	captureMethod: "MANUAL_OBSERVATION",
	backendExternalCallsAllowed: false,
	automatedExecutionAllowed: false,
	scrapingAllowed: false,
	placesApiAllowed: false,
	policyVersion: "local-ai-discovery-v1",
} as const);

export type LocalDiscoveryConfig = {
	enabled: boolean;
	manualPilotEnabled: boolean;
	clientResultsEnabled: boolean;
};

export function localDiscoveryConfigFromEnv(env: Record<string, string | undefined>): LocalDiscoveryConfig {
	return {
		enabled: env.LOCAL_AI_DISCOVERY_ENABLED === "true",
		manualPilotEnabled: env.ASK_MAPS_MANUAL_PILOT_ENABLED === "true",
		clientResultsEnabled: env.LOCAL_AI_DISCOVERY_CLIENT_RESULTS_ENABLED === "true",
	};
}

export function assertLocalDiscoveryEnabled(config: LocalDiscoveryConfig): void {
	if (!config.enabled) throw new Error("LOCAL_AI_DISCOVERY_DISABLED");
}

export function assertManualPilotAllowed(config: LocalDiscoveryConfig): void {
	assertLocalDiscoveryEnabled(config);
	if (!config.manualPilotEnabled) throw new Error("ASK_MAPS_MANUAL_PILOT_DISABLED");
}

export function assertClientResultsAllowed(config: LocalDiscoveryConfig): void {
	assertManualPilotAllowed(config);
	if (!config.clientResultsEnabled) throw new Error("LOCAL_AI_DISCOVERY_CLIENT_RESULTS_DISABLED");
}

export function assertCaptureMethodAllowed(method: string): void {
	if (method !== LOCAL_AI_DISCOVERY_POLICY.captureMethod) throw new Error("AUTOMATION_BLOCKED");
}

// ---------------------------------------------------------------------------
// RC7 §7.3 — observer context. strictObject is load-bearing: the schema is the
// ban on Google account / email / device identifiers — any key outside this
// list is rejected, so such a field cannot be added without changing the
// contract here.
// ---------------------------------------------------------------------------
export const observerGeoModes = ["DECLARED_AREA", "DECLARED_COORDINATE", "UNKNOWN"] as const;
export const observerDeviceClasses = ["MOBILE_IOS", "MOBILE_ANDROID", "DESKTOP", "UNKNOWN"] as const;
export const observerAccountStates = ["SIGNED_OUT", "SIGNED_IN", "UNKNOWN"] as const;
export const observerPersonalizationStates = ["ON", "OFF", "UNKNOWN"] as const;

export const observerContextSchema = z.strictObject({
	observerCountryCode: z.string().trim().min(2).max(2),
	observerAdminArea: z.string().trim().min(1).max(160).optional(),
	observerLocality: z.string().trim().min(1).max(160).optional(),
	observerGeoMode: z.enum(observerGeoModes),
	observerLatitude: z.number().min(-90).max(90).optional(),
	observerLongitude: z.number().min(-180).max(180).optional(),
	appLocale: z.string().trim().min(2).max(35),
	queryLanguage: z.string().trim().min(2).max(35),
	deviceClass: z.enum(observerDeviceClasses),
	accountState: z.enum(observerAccountStates),
	personalizationState: z.enum(observerPersonalizationStates),
	timezone: z.string().trim().min(1).max(64),
	capturedAt: z.iso.datetime(),
});
export type ObserverContext = z.infer<typeof observerContextSchema>;

// The hash identifies the observation *conditions*, not the moment — two
// captures under identical conditions at different times must collide, so
// capturedAt is excluded from the canonical form.
export function contextHash(context: ObserverContext): string {
	const { capturedAt: _capturedAt, ...conditions } = observerContextSchema.parse(context);
	const canonical: Record<string, unknown> = {};
	for (const key of Object.keys(conditions).sort()) {
		const value = (conditions as Record<string, unknown>)[key];
		if (value !== undefined) canonical[key] = value;
	}
	return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

// ---------------------------------------------------------------------------
// RC7 §7.4 — the localAiDiscovery lock block.
// ---------------------------------------------------------------------------
export const lockEntitySchema = z.strictObject({
	entityId: z.string().uuid(),
	name: z.string().trim().min(1),
	aliases: z.array(z.string().trim().min(1)).default([]),
	entityKind: z.enum(["MASTER_BRAND", "SUBBRAND", "CONCEPT", "LOCATION_BRAND"]),
	prelaunch: z.boolean().default(false),
});
export const lockEntityRelationshipSchema = z.strictObject({
	parentEntityId: z.string().uuid(),
	childEntityId: z.string().uuid(),
	relation: z.enum(["SUBBRAND_OF", "CONCEPT_WITHIN", "LOCATION_OF", "UNSPECIFIED"]),
});
export const lockBusinessLocationSchema = z.strictObject({
	locationId: z.string().uuid(),
	entityId: z.string().uuid(),
	displayName: z.string().trim().min(1),
	countryCode: z.string().trim().min(2).max(2),
	adminArea: z.string().trim().min(1).optional(),
	locality: z.string().trim().min(1).optional(),
});
export const lockScenarioSchema = z.strictObject({
	scenarioId: z.string().uuid(),
	queryText: z.string().trim().min(1),
	language: z.string().trim().min(2).max(35),
	targetEntityIds: z.array(z.string().uuid()).min(1),
});
export const evidencePolicySchema = z.strictObject({
	queryRequired: z.literal(true),
	contextRequired: z.literal(true),
	timestampRequired: z.literal(true),
	transcriptRequired: z.literal(true),
	screenshotRequired: z.literal(true),
	visibleSourcesOptional: z.boolean(),
});
export type EvidencePolicy = z.infer<typeof evidencePolicySchema>;

export const localAiDiscoveryLockBlockSchema = z
	.strictObject({
		schemaVersion: z.literal(1),
		surface: z.literal("GOOGLE_ASK_MAPS"),
		captureMethod: z.literal("MANUAL_OBSERVATION"),
		externalCallsAllowed: z.literal(false),
		placesApiAllowed: z.literal(false),
		policyVersion: z.string().min(1),
		captureProtocolVersion: z.string().min(1),
		entities: z.array(lockEntitySchema),
		entityRelationships: z.array(lockEntityRelationshipSchema),
		businessLocations: z.array(lockBusinessLocationSchema),
		scenarios: z.array(lockScenarioSchema),
		observerContexts: z.array(observerContextSchema),
		repeats: z.number().int().min(0),
		expectedObservations: z.number().int().min(0),
		evidencePolicy: evidencePolicySchema,
	})
	.superRefine((block, issues) => {
		const known = new Set(block.entities.map((entity) => entity.entityId));
		for (const relationship of block.entityRelationships) {
			if (!known.has(relationship.parentEntityId) || !known.has(relationship.childEntityId))
				issues.addIssue({ code: "custom", message: "LOCK_RELATIONSHIP_UNKNOWN_ENTITY" });
		}
		for (const location of block.businessLocations) {
			if (!known.has(location.entityId)) issues.addIssue({ code: "custom", message: "LOCK_LOCATION_UNKNOWN_ENTITY" });
		}
		for (const scenario of block.scenarios) {
			if (scenario.targetEntityIds.some((id) => !known.has(id)))
				issues.addIssue({ code: "custom", message: "LOCK_SCENARIO_UNKNOWN_TARGET" });
		}
		if (block.expectedObservations !== expectedObservations(block.scenarios, block.observerContexts, block.repeats))
			issues.addIssue({ code: "custom", message: "OBSERVATION_CARDINALITY_MISMATCH" });
	});
export type LocalAiDiscoveryLockBlock = z.infer<typeof localAiDiscoveryLockBlockSchema>;

// Cardinality is scenarios × contexts × repeats. Entities are description, not
// execution axes — they never multiply the number of observations.
type Countable = number | readonly unknown[];
const toCount = (value: Countable): number => (typeof value === "number" ? value : value.length);
export function expectedObservations(scenarios: Countable, observerContexts: Countable, repeats: number): number {
	const counts = [toCount(scenarios), toCount(observerContexts), repeats];
	if (counts.some((value) => !Number.isInteger(value) || value < 0)) throw new Error("OBSERVATION_CARDINALITY_INVALID");
	return counts[0] * counts[1] * counts[2];
}

// Call before persisting the next observation: once created reaches expected,
// creating observation expected+1 is impossible.
export function assertObservationCardinality(created: number, expected: number): void {
	if (!Number.isInteger(created) || !Number.isInteger(expected) || created < 0 || expected < 0)
		throw new Error("OBSERVATION_CARDINALITY_INVALID");
	if (created >= expected) throw new Error("OBSERVATION_CARDINALITY_BLOCKED");
}

// ---------------------------------------------------------------------------
// Manual pilot statuses and mention vocabulary.
// ---------------------------------------------------------------------------
export const captureTaskStatuses = [
	"PENDING_CAPTURE",
	"AWAITING_MANUAL_CAPTURE",
	"SUBMITTED_FOR_REVIEW",
	"ACCEPTED",
	"REJECTED",
	"NEEDS_CORRECTION",
	"INSUFFICIENT_EVIDENCE",
	"SURFACE_UNAVAILABLE",
] as const;
export type CaptureTaskStatus = (typeof captureTaskStatuses)[number];
export const observationReviewDecisions = [
	"ACCEPTED",
	"REJECTED",
	"NEEDS_CORRECTION",
	"INSUFFICIENT_EVIDENCE",
	"SURFACE_UNAVAILABLE",
] as const;
export type ObservationReviewDecision = (typeof observationReviewDecisions)[number];
export const orderingStates = ["EXPLICIT_ORDER", "UNORDERED", "UNKNOWN"] as const;
export type OrderingState = (typeof orderingStates)[number];
export const mentionRoles = ["TARGET", "PARENT", "CHILD", "COMPETITOR", "OTHER"] as const;
export type MentionRole = (typeof mentionRoles)[number];
export const matchStatuses = ["EXACT_ALIAS", "REVIEWED_MATCH", "UNRESOLVED"] as const;
export type MatchStatus = (typeof matchStatuses)[number];

// ---------------------------------------------------------------------------
// Observation submission — the evidence policy is enforced here, not in UI.
// ---------------------------------------------------------------------------
export type ObservationSubmissionInput = {
	queryText?: string | null;
	context?: unknown;
	capturedAt?: string | Date | null;
	transcript?: string | null;
	screenshotReference?: string | null;
};

const hasValidTimestamp = (value: string | Date | null | undefined): boolean =>
	value != null && Number.isFinite(new Date(value).getTime());

export function observationSubmissionViolations(
	submission: ObservationSubmissionInput,
	policy: EvidencePolicy,
): string[] {
	const violations: string[] = [];
	if (policy.queryRequired && !submission.queryText?.trim()) violations.push("OBSERVATION_MISSING_QUERY_TEXT");
	if (policy.contextRequired && !observerContextSchema.safeParse(submission.context).success)
		violations.push("OBSERVATION_MISSING_CONTEXT");
	if (policy.timestampRequired && !hasValidTimestamp(submission.capturedAt))
		violations.push("OBSERVATION_MISSING_CAPTURED_AT");
	if (policy.transcriptRequired && !submission.transcript?.trim()) violations.push("OBSERVATION_MISSING_TRANSCRIPT");
	if (policy.screenshotRequired && !submission.screenshotReference?.trim())
		violations.push("OBSERVATION_MISSING_SCREENSHOT");
	return violations;
}

export function assertObservationSubmission(submission: ObservationSubmissionInput, policy: EvidencePolicy): void {
	const violations = observationSubmissionViolations(submission, policy);
	if (violations.length > 0) throw new Error(violations.join(", "));
}

// ---------------------------------------------------------------------------
// Mention rules. An explicit position only exists when the answer itself was
// explicitly ordered; an UNRESOLVED (ambiguous-name) match is never a mention.
// ---------------------------------------------------------------------------
export function resolveExplicitPosition(orderingState: OrderingState, explicitPosition?: number | null): number | null {
	if (explicitPosition == null) return null;
	if (!Number.isInteger(explicitPosition) || explicitPosition < 1) throw new Error("MENTION_POSITION_INVALID");
	if (orderingState !== "EXPLICIT_ORDER") throw new Error("MENTION_POSITION_WITHOUT_EXPLICIT_ORDER");
	return explicitPosition;
}

export type MentionMatchInput = { matchStatus: MatchStatus; matchedEntityId?: string | null };

export function assertMentionMatch(mention: MentionMatchInput): void {
	if (mention.matchStatus === "UNRESOLVED" && mention.matchedEntityId)
		throw new Error("MENTION_UNRESOLVED_WITH_ENTITY");
	if (mention.matchStatus !== "UNRESOLVED" && !mention.matchedEntityId) throw new Error("MENTION_MATCH_WITHOUT_ENTITY");
}

export function isCountableMention(mention: MentionMatchInput): boolean {
	return mention.matchStatus !== "UNRESOLVED" && !!mention.matchedEntityId;
}

// ---------------------------------------------------------------------------
// RC7 §10 — metrics as pure functions over reviewed observations.
// Denominator rules: only valid + ACCEPTED observations are eligible;
// SURFACE_UNAVAILABLE is not absence of the brand and UNKNOWN facts never
// enter a denominator, so every rate returns null instead of a fake zero
// when no eligible data exists.
// ---------------------------------------------------------------------------
export type PilotObservationMention = MentionMatchInput & {
	mentionRole?: MentionRole;
	explicitPosition?: number | null;
	factualError?: boolean;
};
export type PilotObservation = {
	scenarioId: string;
	contextHash: string;
	repeatIndex: number;
	reviewStatus: string;
	orderingState: OrderingState;
	// SOURCE_NOT_EXPOSED means the surface showed no source panel at all —
	// that observation is excluded from citation denominators rather than
	// counted as "no citation".
	sourcesExposure?: "EXPOSED" | "SOURCE_NOT_EXPOSED" | "UNKNOWN";
	targetSourceVisible?: boolean;
	mentions: readonly PilotObservationMention[];
};

const eligiblePilotObservations = (observations: readonly PilotObservation[]): PilotObservation[] =>
	observations.filter((observation) => observation.reviewStatus === "ACCEPTED");

// Direct-id match only: a parent mention is not a child mention and vice versa.
const mentionsEntity = (observation: PilotObservation, entityId: string): boolean =>
	observation.mentions.some((mention) => isCountableMention(mention) && mention.matchedEntityId === entityId);

const rate = (numerator: number, denominator: number): number | null =>
	denominator === 0 ? null : numerator / denominator;

export function entityInclusionRate(observations: readonly PilotObservation[], entityId: string): number | null {
	const eligible = eligiblePilotObservations(observations);
	return rate(eligible.filter((observation) => mentionsEntity(observation, entityId)).length, eligible.length);
}

// Subtree over the lock's confirmed entities: relationships pointing at an
// entity absent from the lock never extend the family.
export function familyEntityIds(
	block: Pick<LocalAiDiscoveryLockBlock, "entities" | "entityRelationships">,
	rootEntityId: string,
): Set<string> {
	const confirmed = new Set(block.entities.map((entity) => entity.entityId));
	const children = new Map<string, string[]>();
	for (const relationship of block.entityRelationships) {
		if (!confirmed.has(relationship.parentEntityId) || !confirmed.has(relationship.childEntityId)) continue;
		const siblings = children.get(relationship.parentEntityId) ?? [];
		siblings.push(relationship.childEntityId);
		children.set(relationship.parentEntityId, siblings);
	}
	const family = new Set<string>(confirmed.has(rootEntityId) ? [rootEntityId] : []);
	const queue = [...family];
	while (queue.length > 0) {
		const current = queue.shift() as string;
		for (const child of children.get(current) ?? []) {
			if (family.has(child)) continue;
			family.add(child);
			queue.push(child);
		}
	}
	return family;
}

export function familyPresenceRate(
	observations: readonly PilotObservation[],
	rootEntityId: string,
	block: Pick<LocalAiDiscoveryLockBlock, "entities" | "entityRelationships">,
): number | null {
	const family = familyEntityIds(block, rootEntityId);
	const eligible = eligiblePilotObservations(observations);
	return rate(
		eligible.filter((observation) => [...family].some((entityId) => mentionsEntity(observation, entityId))).length,
		eligible.length,
	);
}

export function explicitAveragePosition(observations: readonly PilotObservation[], entityId: string): number | null {
	const positions = eligiblePilotObservations(observations)
		.filter((observation) => observation.orderingState === "EXPLICIT_ORDER")
		.flatMap((observation) =>
			observation.mentions
				.filter(
					(mention) =>
						isCountableMention(mention) && mention.matchedEntityId === entityId && mention.explicitPosition != null,
				)
				.map((mention) => mention.explicitPosition as number),
		);
	return positions.length === 0 ? null : positions.reduce((sum, position) => sum + position, 0) / positions.length;
}

// Share of (scenario, context) groups whose repeats all agree on whether the
// entity was included; groups with a single eligible repeat carry no
// stability signal and stay out of the denominator.
export function repeatStability(observations: readonly PilotObservation[], entityId: string): number | null {
	const groups = new Map<string, boolean[]>();
	for (const observation of eligiblePilotObservations(observations)) {
		const key = `${observation.scenarioId}:${observation.contextHash}`;
		const inclusions = groups.get(key) ?? [];
		inclusions.push(mentionsEntity(observation, entityId));
		groups.set(key, inclusions);
	}
	const measurable = [...groups.values()].filter((inclusions) => inclusions.length >= 2);
	return rate(
		measurable.filter((inclusions) => inclusions.every((included) => included === inclusions[0])).length,
		measurable.length,
	);
}

export function visibleSourceRate(observations: readonly PilotObservation[]): number | null {
	const exposed = eligiblePilotObservations(observations).filter(
		(observation) => observation.sourcesExposure === "EXPOSED",
	);
	return rate(exposed.filter((observation) => observation.targetSourceVisible === true).length, exposed.length);
}

export function factualErrorRate(observations: readonly PilotObservation[], entityId?: string): number | null {
	const countable = eligiblePilotObservations(observations).flatMap((observation) =>
		observation.mentions.filter(
			(mention) => isCountableMention(mention) && (entityId === undefined || mention.matchedEntityId === entityId),
		),
	);
	return rate(countable.filter((mention) => mention.factualError === true).length, countable.length);
}

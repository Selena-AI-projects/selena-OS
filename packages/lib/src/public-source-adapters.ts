import { createHash } from "node:crypto";
import type { ActionPlan, InputManifest } from "@workspace/selena-visibility-contracts";
import { type EvidenceItem, stableId } from "@workspace/selena-visibility-contracts";
import { buildManifest, mergeActionPlans, validateGrounding } from "./recommendation-engine";

export type PublicSourceKind = "SEARCH" | "MAPS" | "REVIEWS" | "SOCIAL";
export type PublicSourceStatus = "ALLOWED" | "MANUAL_ONLY" | "BLOCKED";
export type PublicSourceSnapshot = {
	id: string;
	tenantId: string;
	kind: PublicSourceKind;
	status: PublicSourceStatus;
	sourceUrl: string;
	collectorVersion: string;
	collectedAt: string;
	contentHash: string;
	provenance: { sourceUrl: string; accessClass: "PUBLIC"; limitations: string[] };
	payload: unknown;
	immutable: true;
};

export type PublicSourceCollection = { snapshot: PublicSourceSnapshot; evidence: EvidenceItem[] };

export type PublicEvidenceAdapter = {
	provider: string;
	status: PublicSourceStatus;
	collectFixture(input: Parameters<typeof collectPublicSourceFixture>[0]): PublicSourceCollection;
};

function stablePayload(payload: unknown): string {
	if (payload === null || typeof payload !== "object") return JSON.stringify(payload) ?? "null";
	if (Array.isArray(payload)) return `[${payload.map(stablePayload).join(",")}]`;
	return `{${Object.entries(payload as Record<string, unknown>)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, value]) => `${JSON.stringify(key)}:${stablePayload(value)}`)
		.join(",")}}`;
}

export function collectPublicSourceFixture(input: {
	tenantId: string;
	kind: PublicSourceKind;
	sourceUrl: string;
	payload: unknown;
	collectedAt?: string;
	limitations?: string[];
}): PublicSourceCollection {
	const collectedAt = input.collectedAt ?? new Date().toISOString();
	const contentHash = createHash("sha256").update(stablePayload(input.payload)).digest("hex");
	const snapshotId = stableId("public_snapshot", `${input.tenantId}:${input.kind}:${input.sourceUrl}:${contentHash}`);
	const snapshot: PublicSourceSnapshot = {
		id: snapshotId,
		tenantId: input.tenantId,
		kind: input.kind,
		status: "ALLOWED",
		sourceUrl: input.sourceUrl,
		collectorVersion: "public-fixture-1",
		collectedAt,
		contentHash,
		provenance: {
			sourceUrl: input.sourceUrl,
			accessClass: "PUBLIC",
			limitations: input.limitations ?? ["fixture data; no reach or conversion inference"],
		},
		payload: input.payload,
		immutable: true,
	};
	const evidence: EvidenceItem = {
		id: stableId("public_evidence", snapshotId),
		tenantId: input.tenantId,
		snapshotId,
		kind: input.kind === "REVIEWS" ? "REVIEW" : input.kind,
		accessClass: "PUBLIC",
		sourceRef: input.sourceUrl,
		capturedAt: collectedAt,
		subject: input.kind,
		text: JSON.stringify(input.payload),
		metadata: {
			collectorVersion: "public-fixture-1",
			channel: input.kind,
			limitations: snapshot.provenance.limitations,
		},
	};
	return { snapshot, evidence: [evidence] };
}

/**
 * Converts public evidence into a small, deterministic rulepack result. Live
 * providers must implement this same boundary; they are deliberately absent
 * here so tests cannot accidentally make network or paid calls.
 */
export function buildPublicActionPlan(tenantId: string, manifest: InputManifest, evidence: EvidenceItem[]): ActionPlan {
	if (evidence.some((item) => item.tenantId !== tenantId)) throw new Error("TENANT_ISOLATION_BLOCKED");
	const selected = evidence.filter((item) => manifest.evidenceIds.includes(item.id));
	const findings = selected.flatMap((item) => {
		const payload = item.text.toLowerCase();
		const missingSignal =
			(item.kind === "SEARCH" && !payload.includes("brand")) ||
			(item.kind === "MAPS" && !payload.includes("rating")) ||
			(item.kind === "REVIEW" && !payload.includes("review")) ||
			(item.kind === "SOCIAL" && !payload.includes("profile"));
		if (!missingSignal) return [];
		return [
			{
				id: stableId("finding", `${manifest.id}:public:${item.id}`),
				tenantId,
				manifestId: manifest.id,
				category: `PUBLIC_${item.kind}`,
				statement: `Public ${item.kind.toLowerCase()} evidence is incomplete for the selected snapshot.`,
				evidenceIds: [item.id],
				confidence: "MEDIUM" as const,
				confidenceScore: 0.6,
				severity: "MEDIUM" as const,
				unknown: false,
				ruleId: `PUBLIC-${item.kind}-COMPLETENESS`,
			},
		];
	});
	const recommendations = findings.map((finding) => ({
		id: stableId("recommendation", finding.id),
		tenantId,
		findingId: finding.id,
		manifestId: manifest.id,
		title: `Improve ${finding.category.toLowerCase()} evidence`,
		action: "Review the cited public source and improve the factual, attributable presence of the brand.",
		rationale: finding.statement,
		evidenceIds: finding.evidenceIds,
		priority: "NEXT" as const,
		effort: "M" as const,
		confidence: finding.confidence,
		blocked: false,
	}));
	const tasks = recommendations.map((recommendation) => ({
		id: stableId("task", recommendation.id),
		recommendationId: recommendation.id,
		title: recommendation.title,
		horizon: "0_30_DAYS" as const,
		owner: "Client marketing owner",
		steps: [recommendation.action],
		evidenceIds: recommendation.evidenceIds,
		verificationPlan: [
			"Re-run the same public-source fixture or approved provider snapshot and compare the cited fields.",
		],
	}));
	return { tenantId, manifestId: manifest.id, findings, recommendations, tasks };
}

export function buildPublicEvidenceActionPlan(input: {
	tenantId: string;
	datasetId: string;
	collections: PublicSourceCollection[];
	rulepackVersion?: string;
}): { manifest: InputManifest; evidence: EvidenceItem[]; actionPlan: ActionPlan; groundingErrors: string[] } {
	const evidence = input.collections.flatMap((collection) => collection.evidence);
	const manifest = buildManifest(input.tenantId, input.datasetId, evidence, input.rulepackVersion ?? "public-v1");
	const actionPlan = buildPublicActionPlan(input.tenantId, manifest, evidence);
	const groundingErrors = validateGrounding(actionPlan, evidence);
	return {
		manifest,
		evidence,
		actionPlan: mergeActionPlans(input.tenantId, manifest.id, [actionPlan]),
		groundingErrors,
	};
}

export type ConnectorContract = {
	provider: "GSC" | "GA4" | "GBP" | "META_INSIGHTS";
	status: "NOT_ACTIVATED" | "CONNECTED" | "REVOKED";
	scopes: string[];
	dataMinimization: string[];
};

export const connectorContracts: ConnectorContract[] = [
	{
		provider: "GSC",
		status: "NOT_ACTIVATED",
		scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
		dataMinimization: ["query metrics only", "no tokens in logs"],
	},
	{
		provider: "GA4",
		status: "NOT_ACTIVATED",
		scopes: ["analytics.readonly"],
		dataMinimization: ["aggregate metrics only", "no user-level data"],
	},
	{
		provider: "GBP",
		status: "NOT_ACTIVATED",
		scopes: ["business.manage.readonly"],
		dataMinimization: ["public performance aggregates only", "disconnect/revoke supported"],
	},
	{
		provider: "META_INSIGHTS",
		status: "NOT_ACTIVATED",
		scopes: ["instagram_basic", "instagram_manage_insights"],
		dataMinimization: ["aggregate insights only", "no private profile data"],
	},
];

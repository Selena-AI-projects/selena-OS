import {
	type ActionPlan,
	actionPlanSchema,
	containsForbiddenClaim,
	type EvidenceItem,
	type InputManifest,
	type Recommendation,
	type RecommendationFinding,
	stableId,
} from "@workspace/selena-visibility-contracts";

export type CanonicalRow = Record<string, string>;

export function parseEvidenceCsv(csv: string, tenantId: string, snapshotId: string): EvidenceItem[] {
	const lines = csv.trim().split(/\r?\n/);
	if (lines.length < 2) return [];
	const parse = (line: string) => {
		const cells: string[] = [];
		let cell = "";
		let quoted = false;
		for (let i = 0; i < line.length; i++) {
			const ch = line[i];
			if (ch === '"' && line[i + 1] === '"') {
				cell += '"';
				i++;
			} else if (ch === '"') quoted = !quoted;
			else if (ch === "," && !quoted) {
				cells.push(cell);
				cell = "";
			} else cell += ch;
		}
		cells.push(cell);
		return cells;
	};
	const headers = parse(lines[0]);
	return lines
		.slice(1)
		.filter(Boolean)
		.map((line, index) => {
			const values = parse(line);
			const row = Object.fromEntries(headers.map((header, i) => [header, values[i] ?? ""]));
			const id = row.run_id || `row-${index + 1}`;
			return {
				id,
				tenantId,
				snapshotId,
				kind: "AI_RESPONSE",
				accessClass: "PUBLIC",
				sourceRef: `evidence/usha-evidence-ledger-240.csv#${id}`,
				capturedAt: row.timestamp || "UNKNOWN",
				subject: row.scenario || "UNKNOWN",
				text: row.response_reference || "",
				metadata: row,
			} as EvidenceItem;
		});
}

export function buildManifest(
	tenantId: string,
	datasetId: string,
	evidence: EvidenceItem[],
	rulepackVersion = "ai-website-v1",
): InputManifest {
	return {
		id: stableId(
			"manifest",
			`${tenantId}:${datasetId}:${evidence.map((item) => item.id).join("|")}:${rulepackVersion}`,
		),
		tenantId,
		datasetId,
		evidenceIds: evidence.map((item) => item.id),
		snapshotIds: [...new Set(evidence.map((item) => item.snapshotId))],
		rulepackVersion,
		createdAt: "2026-08-15T00:00:00.000Z",
		immutable: true,
	};
}

export function buildActionPlan(tenantId: string, manifest: InputManifest, evidence: EvidenceItem[]): ActionPlan {
	if (evidence.some((item) => item.tenantId !== tenantId)) throw new Error("TENANT_ISOLATION_BLOCKED");
	const selected = evidence.filter((item) => manifest.evidenceIds.includes(item.id));
	const mentionRows = selected.filter((item) => item.metadata.mention === "true");
	const apiRows = selected.filter((item) => item.metadata.channel === "API View");
	const apiMentionRate = apiRows.length
		? apiRows.filter((item) => item.metadata.mention === "true").length / apiRows.length
		: 0;
	const findings: RecommendationFinding[] = [];
	if (apiRows.length > 0 && apiMentionRate < 0.5)
		findings.push({
			id: stableId("finding", `${manifest.id}:ai-api-mention`),
			tenantId,
			manifestId: manifest.id,
			category: "AI_VISIBILITY",
			statement: `API View mentioned the brand in ${Math.round(apiMentionRate * 100)}% of selected responses.`,
			evidenceIds: apiRows.slice(0, 5).map((item) => item.id),
			confidence: apiRows.length >= 30 ? "HIGH" : "MEDIUM",
			confidenceScore: Math.min(1, apiRows.length / 30),
			severity: apiMentionRate < 0.35 ? "HIGH" : "MEDIUM",
			unknown: false,
			ruleId: "AI-API-MENTION-RATE",
		});
	const owned = selected.filter((item) => item.metadata.owned_citation === "true");
	if (mentionRows.length > 0 && owned.length / mentionRows.length < 0.7)
		findings.push({
			id: stableId("finding", `${manifest.id}:owned-citation`),
			tenantId,
			manifestId: manifest.id,
			category: "AI_CITATIONS",
			statement: "Mentioned responses do not consistently contain an owned-domain citation.",
			evidenceIds: selected
				.filter((item) => item.metadata.mention === "true")
				.slice(0, 5)
				.map((item) => item.id),
			confidence: "MEDIUM",
			confidenceScore: Math.min(1, selected.length / 100),
			severity: "MEDIUM",
			unknown: false,
			ruleId: "AI-OWNED-CITATION-COVERAGE",
		});
	const recommendations: Recommendation[] = findings.map((finding) => {
		const action =
			finding.ruleId === "AI-API-MENTION-RATE"
				? "Create or improve crawlable authoritative pages that answer the approved discovery questions."
				: "Strengthen owned-domain pages and internal linking for topics where the brand is mentioned.";
		const blocked = containsForbiddenClaim(action);
		return {
			id: stableId("recommendation", finding.id),
			tenantId,
			findingId: finding.id,
			manifestId: manifest.id,
			title:
				finding.category === "AI_VISIBILITY" ? "Improve API View discoverability" : "Improve owned citation coverage",
			action,
			rationale: finding.statement,
			evidenceIds: finding.evidenceIds,
			priority: finding.severity === "HIGH" ? "NOW" : "NEXT",
			effort: "M",
			confidence: finding.confidence,
			blocked,
			...(blocked ? { blockReason: "FORBIDDEN_CLAIM" } : {}),
		};
	});
	const tasks = recommendations
		.filter((item) => !item.blocked)
		.map((item) => ({
			id: stableId("task", item.id),
			recommendationId: item.id,
			title: item.title,
			horizon: "0_30_DAYS" as const,
			owner: "Client marketing/website owner",
			steps: [item.action, "Review the linked evidence before publishing changes."],
			evidenceIds: item.evidenceIds,
			verificationPlan: [
				"Run the same approved scenarios in a future measurement cycle.",
				"Compare mention and owned-citation rates using a new immutable snapshot.",
			],
		}));
	return actionPlanSchema.parse({ tenantId, manifestId: manifest.id, findings, recommendations, tasks });
}

export function validateGrounding(plan: ActionPlan, evidence: EvidenceItem[]): string[] {
	const tenantEvidence = evidence.filter((item) => item.tenantId === plan.tenantId);
	const ids = new Set(tenantEvidence.map((item) => item.id));
	const manifest = new Set(plan.findings.flatMap((finding) => finding.evidenceIds));
	// Addendum §8: nothing actionable exists without the evidence it rests on.
	// An empty list would pass every id check by having no ids to fail, so it
	// is refused by name rather than by omission.
	const grounded = (item: { id: string; evidenceIds: string[] }) =>
		item.evidenceIds.length === 0
			? [`${item.id}:NO_EVIDENCE`]
			: [
					...item.evidenceIds.filter((id) => !ids.has(id)).map((id) => `${item.id}:UNKNOWN_EVIDENCE:${id}`),
					...item.evidenceIds
						.filter((id) => !manifest.has(id))
						.map((id) => `${item.id}:EVIDENCE_NOT_IN_FINDING_MANIFEST:${id}`),
				];
	const errors = [
		// A finding defines the manifest, so it is only checked against evidence
		// that was actually supplied.
		...plan.findings.flatMap((finding) =>
			finding.evidenceIds.length === 0
				? [`${finding.id}:NO_EVIDENCE`]
				: finding.evidenceIds.filter((id) => !ids.has(id)).map((id) => `${finding.id}:UNKNOWN_EVIDENCE:${id}`),
		),
		...plan.recommendations.flatMap(grounded),
		// A task is what somebody actually does, so it needs the same footing as
		// the recommendation it came from.
		...plan.tasks.flatMap(grounded),
	];
	if (evidence.some((item) => item.tenantId !== plan.tenantId)) errors.push("TENANT_ISOLATION_BLOCKED");
	return errors;
}

export function mergeActionPlans(tenantId: string, manifestId: string, plans: ActionPlan[]): ActionPlan {
	if (plans.some((plan) => plan.tenantId !== tenantId)) throw new Error("TENANT_ISOLATION_BLOCKED");
	const findings = plans.flatMap((plan) => plan.findings);
	const recommendations = plans.flatMap((plan) => plan.recommendations);
	const tasks = plans.flatMap((plan) => plan.tasks);
	return actionPlanSchema.parse({ tenantId, manifestId, findings, recommendations, tasks });
}

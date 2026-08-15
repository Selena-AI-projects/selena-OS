import { createHash } from "node:crypto";
import { calculateQuote, type QuoteCreate, type QuotePricing } from "@workspace/selena-visibility-contracts";
import { buildActionPlan, type CanonicalRow } from "./recommendation-engine";
import { planMonitoringCycle } from "./selena-monitoring";

export const selenaFlowStates = [
	"DRAFT",
	"AWAITING_APPROVAL",
	"BUDGET_BLOCKED",
	"READY",
	"RUNNING",
	"PARTIAL",
	"COMPLETE",
	"FAILED",
] as const;
export type SelenaFlowState = (typeof selenaFlowStates)[number];

export type SelenaFlowAuditEvent = { event: string; at: string; details: Record<string, unknown> };

export type SelenaFlowResult = {
	state: SelenaFlowState;
	project: { name: string; website: string; brandConfirmed: boolean };
	quote: { expectedRuns: number; amount: number; currency: string };
	runs: { dispatchKey: string; status: "SUCCEEDED" | "INVALID" }[];
	actionPlan: ReturnType<typeof buildActionPlan>;
	csv: string;
	audit: SelenaFlowAuditEvent[];
};

export function runSelenaFixtureFlow(input: {
	tenantId: string;
	projectName: string;
	website: string;
	brandConfirmed?: boolean;
	quote: QuoteCreate;
	pricing: QuotePricing;
	budgetCap: number;
	rows: CanonicalRow[];
	collectedAt?: string;
}): SelenaFlowResult {
	const at = input.collectedAt ?? "2026-08-15T00:00:00Z";
	const audit: SelenaFlowAuditEvent[] = [];
	const record = (event: string, details: Record<string, unknown>) => audit.push({ event, at, details });
	const brandConfirmed = input.brandConfirmed ?? false;
	record("PROJECT_DRAFTED", { tenantId: input.tenantId });
	if (!brandConfirmed) {
		record("BRAND_CONFIRMATION_REQUIRED", { website: input.website });
		throw new Error("BRAND_CONFIRMATION_REQUIRED");
	}
	record("BRAND_DOMAIN_CONFIRMED", { website: input.website });
	const quote = calculateQuote(input.quote, input.pricing);
	record("QUOTE_ISSUED", { expectedRuns: quote.expectedRuns, amount: quote.amount, currency: quote.currency });
	if (quote.amount > input.budgetCap) {
		record("BUDGET_BLOCKED", { amount: quote.amount, budgetCap: input.budgetCap });
		return {
			state: "BUDGET_BLOCKED",
			project: { name: input.projectName, website: input.website, brandConfirmed },
			quote,
			runs: [],
			actionPlan: buildActionPlan(
				input.tenantId,
				{
					id: "blocked",
					tenantId: input.tenantId,
					datasetId: "fixture",
					snapshotIds: [],
					rulepackVersion: "AI-v1",
					evidenceIds: [],
					createdAt: at,
					immutable: true,
				},
				[],
			),
			csv: "",
			audit,
		};
	}
	record("ORDER_APPROVED_TEST_MODE", { paymentProvider: "test" });
	const cycle = planMonitoringCycle({
		cycleId: "fixture-cycle",
		projectId: "fixture-project",
		expectedRuns: quote.expectedRuns,
		estimatedCost: quote.amount,
		budgetCap: input.budgetCap,
	});
	if (cycle.state !== "READY") throw new Error(`CYCLE_${cycle.state}`);
	record("CYCLE_READY", { dispatchKey: cycle.dispatchKey });
	record("FIXTURE_RUNTIME_STARTED", { providerCalls: 0 });
	const runs = input.rows.map((row, index) => ({
		dispatchKey: createHash("sha256").update(`${cycle.dispatchKey}:${index}`).digest("hex"),
		status: row.validity === "valid" ? ("SUCCEEDED" as const) : ("INVALID" as const),
	}));
	const validRows = input.rows.filter((row) => row.validity === "valid");
	const state: SelenaFlowState =
		validRows.length === 0 ? "FAILED" : validRows.length < input.rows.length ? "PARTIAL" : "COMPLETE";
	record("FIXTURE_RUNTIME_FINISHED", { state, createdRuns: runs.length, providerCalls: 0 });
	const manifest = {
		id: "fixture-manifest",
		tenantId: input.tenantId,
		datasetId: "fixture",
		snapshotIds: [],
		rulepackVersion: "AI-v1",
		evidenceIds: validRows.map((row) => row.runId),
		createdAt: at,
		immutable: true as const,
	};
	const evidence = validRows.map((row) => ({
		...row,
		id: row.runId,
		tenantId: input.tenantId,
		snapshotId: "fixture-snapshot",
		kind: "AI_RESPONSE" as const,
		accessClass: "UPLOADED" as const,
		sourceRef: row.rawResponseReference ?? "fixture://runtime",
		capturedAt: row.timestamp,
		subject: row.scenarioText,
		text: row.scenarioText,
		metadata: { channel: row.channel, mention: row.mention, ownedCitation: row.ownedCitation },
	}));
	const actionPlan = buildActionPlan(input.tenantId, manifest, evidence);
	const csv = validRows
		.map((row) =>
			Object.values(row)
				.map((value) => JSON.stringify(value ?? ""))
				.join(","),
		)
		.join("\n");
	record("ACTION_PLAN_EXPORTED", {
		findings: actionPlan.findings.length,
		recommendations: actionPlan.recommendations.length,
		secretsIncluded: false,
	});
	return {
		state,
		project: { name: input.projectName, website: input.website, brandConfirmed },
		quote,
		runs,
		actionPlan,
		csv,
		audit,
	};
}

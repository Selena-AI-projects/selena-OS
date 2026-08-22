import {
	expectedRunsFromScope,
	type MeasurementScope,
	type PreflightResult,
} from "@workspace/selena-visibility-contracts";

// Preflight is the read-only gate an operator must clear before an order may be
// approved. It is a pure function of facts the caller has already gathered:
// no database, no queue, no provider, no clock. Every rule that can stop an
// approval is a named check, so a blocked order always explains itself.

export type PreflightCheckCode =
	| "ORDER_STATUS_PAID_REVIEW_REQUIRED"
	| "LOCK_PRESENT"
	| "LOCK_SCOPE_PRESENT"
	| "EXPECTED_RUNS_MATCH"
	| "NO_ACTIVE_PERMITS"
	| "NO_ACTIVE_JOBS"
	| "MAINTENANCE_IDLE"
	| "WITHIN_ORDER_CAP"
	| "WITHIN_PROVIDER_BUDGET"
	| "PAYMENT_RECORDED";

export type PreflightFacts = {
	orderId: string;
	orderStatus: string;
	lockPresent: boolean;
	scope: MeasurementScope | null;
	lockExpectedRuns: number;
	activePermits: number;
	activeJobs: number;
	maintenanceActive: boolean;
	providerBudgetRemaining: number;
	orderCap: number;
	worstCaseCost: number;
	paymentRecorded: boolean;
	currency?: string;
};

// Details stay primitive so the evaluation survives the wire to an operator
// screen unchanged.
export type PreflightCheck = {
	code: PreflightCheckCode;
	ok: boolean;
	details: Record<string, string | number | boolean | null>;
};

export type PreflightEvaluation = Omit<PreflightResult, "checks"> & {
	checks: PreflightCheck[];
	blockers: PreflightCheckCode[];
};

/** The only order status an approval may start from. */
export const PREFLIGHT_REQUIRED_ORDER_STATUS = "PAID_REVIEW_REQUIRED";

function normalizeCurrency(value: string | undefined): string {
	const currency = (value ?? "").trim().toUpperCase();
	return currency.length === 3 ? currency : "USD";
}

/** A cost we cannot read as a non-negative finite number is not a cost we may clear. */
function readableCost(value: number): number {
	return Number.isFinite(value) && value >= 0 ? value : Number.NaN;
}

export function evaluatePreflight(facts: PreflightFacts): PreflightEvaluation {
	const scopedRuns = facts.scope ? expectedRunsFromScope(facts.scope) : 0;
	const worstCase = readableCost(facts.worstCaseCost);
	const withinCap = (cap: number) => Number.isFinite(worstCase) && Number.isFinite(cap) && worstCase <= cap;
	const checks: PreflightCheck[] = [
		{
			code: "ORDER_STATUS_PAID_REVIEW_REQUIRED",
			ok: facts.orderStatus === PREFLIGHT_REQUIRED_ORDER_STATUS,
			details: { status: facts.orderStatus, required: PREFLIGHT_REQUIRED_ORDER_STATUS },
		},
		{ code: "LOCK_PRESENT", ok: facts.lockPresent, details: {} },
		{ code: "LOCK_SCOPE_PRESENT", ok: facts.scope !== null, details: {} },
		{
			code: "EXPECTED_RUNS_MATCH",
			ok: facts.scope !== null && scopedRuns === facts.lockExpectedRuns,
			details: { scopeExpectedRuns: scopedRuns, lockExpectedRuns: facts.lockExpectedRuns },
		},
		{ code: "NO_ACTIVE_PERMITS", ok: facts.activePermits === 0, details: { activePermits: facts.activePermits } },
		{ code: "NO_ACTIVE_JOBS", ok: facts.activeJobs === 0, details: { activeJobs: facts.activeJobs } },
		{ code: "MAINTENANCE_IDLE", ok: !facts.maintenanceActive, details: { maintenanceActive: facts.maintenanceActive } },
		{
			code: "WITHIN_ORDER_CAP",
			ok: withinCap(facts.orderCap),
			details: { worstCaseCost: facts.worstCaseCost, orderCap: facts.orderCap },
		},
		{
			code: "WITHIN_PROVIDER_BUDGET",
			ok: withinCap(facts.providerBudgetRemaining),
			details: { worstCaseCost: facts.worstCaseCost, providerBudgetRemaining: facts.providerBudgetRemaining },
		},
		{ code: "PAYMENT_RECORDED", ok: facts.paymentRecorded, details: {} },
	];
	return {
		orderId: facts.orderId,
		ok: checks.every((check) => check.ok),
		checks,
		expectedRuns: scopedRuns,
		worstCaseCost: {
			amount: Number.isFinite(worstCase) ? worstCase : 0,
			currency: normalizeCurrency(facts.currency),
			basis: "estimated",
		},
		blockers: checks.filter((check) => !check.ok).map((check) => check.code),
	};
}

export function preflightBlockers(result: PreflightResult | PreflightEvaluation): PreflightCheckCode[] {
	return result.checks.filter((check) => !check.ok).map((check) => check.code as PreflightCheckCode);
}

/**
 * The approval decision itself, so no caller can approve an order past a
 * blocker by forgetting to read `ok`.
 */
export function assertApprovable(result: PreflightResult | PreflightEvaluation): void {
	if (result.ok) return;
	throw new Error(`SELENA_PREFLIGHT_BLOCKED: ${preflightBlockers(result).join(", ")}`);
}

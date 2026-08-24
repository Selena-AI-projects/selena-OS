import { sql } from "drizzle-orm";
import type { db as defaultDb } from "./db/db";

type Executor = Pick<typeof defaultDb, "execute">;

export const SUGGEST_BUDGET_USD_ENV = "SELENA_SUGGEST_BUDGET_USD";

/**
 * Deliberately coarse, like usage/cost.ts: what one profile suggestion is
 * booked at until real invoices retune it. The ledger row says estimated.
 */
export const SUGGEST_ESTIMATED_COST_USD = 0.05;

/** Unset or unparsable means no ceiling — the class gate alone, as before. */
export function suggestBudgetUsdFromEnv(env: Record<string, string | undefined> = process.env): number | null {
	const raw = env[SUGGEST_BUDGET_USD_ENV]?.trim();
	if (!raw) return null;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : null;
}

/** Pure rule shared by both refusal frontiers (web enqueue and worker). */
export function isSuggestBudgetExceeded(
	spentThisMonthUsd: number,
	budgetUsd: number | null,
	nextCallUsd: number = SUGGEST_ESTIMATED_COST_USD,
): boolean {
	if (budgetUsd === null) return false;
	return spentThisMonthUsd + nextCallUsd > budgetUsd;
}

async function suggestSpendThisMonthUsd(dbc: Executor, now: Date): Promise<number> {
	const result = await dbc.execute(sql`
		SELECT coalesce(sum(amount_usd), 0)::float8 AS spent
		FROM sv_cost_events
		WHERE kind = 'suggest'
			AND created_at >= date_trunc('month', ${now.toISOString()}::timestamptz)
	`);
	const row = result.rows?.[0] as { spent?: number } | undefined;
	return Number(row?.spent ?? 0);
}

/**
 * The monthly ceiling for suggestion spending, deployment-wide: it protects
 * the owner's provider key, so it does not slice by tenant. Asserted before
 * enqueueing and again in the worker, because a job already queued when the
 * ceiling was reached must not spend either.
 */
export async function assertSuggestBudget(
	dbc: Executor,
	env: Record<string, string | undefined> = process.env,
	now: Date = new Date(),
): Promise<void> {
	const budget = suggestBudgetUsdFromEnv(env);
	if (budget === null) return;
	const spent = await suggestSpendThisMonthUsd(dbc, now);
	if (isSuggestBudgetExceeded(spent, budget)) throw new Error("SUGGEST_BUDGET_EXHAUSTED");
}

/** One ledger row per suggestion call, booked where the call is made. */
export async function recordSuggestCost(
	dbc: Executor,
	value: { organizationId: string; provider: string },
): Promise<void> {
	await dbc.execute(sql`
		INSERT INTO sv_cost_events (organization_id, provider, amount_usd, basis, kind)
		VALUES (${value.organizationId}, ${value.provider}, ${SUGGEST_ESTIMATED_COST_USD}, 'estimated', 'suggest')
	`);
}

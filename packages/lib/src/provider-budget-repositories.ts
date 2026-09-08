import { and, desc, eq, sql } from "drizzle-orm";
import {
	type ContentAuthContext,
	type ContentTransaction,
	withBrandRequestContext,
} from "./content-workflow-repositories";
import { selenaWebDb as db } from "./db/db";
import { scrProviderBudgets, scrProviderCallLedger } from "./db/schema";

// Provider budget and call-ledger repository (Slice 3.1).
//
// The only doors to the durable ledger are the two SECURITY DEFINER functions
// from migration 0044: `reserve_provider_call` writes a RESERVED row under an
// advisory lock against a budget an interactive owner set, and
// `settle_provider_call` advances that row's status. This module never writes
// the ledger directly — the web runtime holds no INSERT or UPDATE policy on it
// at all. Budgets are a plain append-only INSERT the database itself limits to
// an interactive owner.

export const PROVIDER_BUDGET_ERROR_CODES = [
	"PROVIDER_BUDGET_MISSING",
	"PROVIDER_QUOTA_EXCEEDED",
	"UNKNOWN_COST_BLOCKED",
] as const;

export type ProviderBudgetErrorCode = (typeof PROVIDER_BUDGET_ERROR_CODES)[number];

export class ProviderBudgetError extends Error {
	readonly code: ProviderBudgetErrorCode;

	constructor(code: ProviderBudgetErrorCode, message: string) {
		super(message);
		this.name = "ProviderBudgetError";
		this.code = code;
	}
}

/**
 * Fixed cost estimates in micros per external provider call, until real
 * pricing lands. Zero is never a legal estimate: the definer function refuses
 * an unknown cost outright (`UNKNOWN_COST_BLOCKED`), so a provider missing
 * from this map cannot quietly reserve for free.
 */
export const PROVIDER_COST_ESTIMATES: Record<string, number> = {
	gemini: 20_000,
	"video-radar": 5_000,
};

/**
 * The definer functions speak through SQLERRM prefixes. Anything else — an RLS
 * refusal, an aborted connection — is not a budget verdict and stays untyped.
 */
export function providerErrorMessages(error: unknown): string[] {
	const messages: string[] = [];
	let current: unknown = error;
	for (let depth = 0; depth < 6 && current instanceof Error; depth += 1) {
		messages.push(current.message);
		current = current.cause;
	}
	return messages;
}

export function toProviderBudgetError(error: unknown): ProviderBudgetError | null {
	// The driver may wrap the definer function's RAISE ("Failed query: ...")
	// with the real Postgres error in `cause`, so the verdict is searched for
	// along the whole cause chain, not only on the surface message.
	for (const message of providerErrorMessages(error)) {
		for (const code of PROVIDER_BUDGET_ERROR_CODES) {
			if (message.includes(`${code}:`)) return new ProviderBudgetError(code, message);
		}
	}
	return null;
}

export interface ReserveProviderCallInput {
	brandId: string;
	providerId: string;
	purpose: string;
	idempotencyKey: string;
	estimatedCalls: number;
	estimatedCostMicros: number;
	correlationId?: string | null;
}

export interface SettleProviderCallInput {
	ledgerId: string;
	status: "DISPATCHED" | "SETTLED" | "FAILED" | "EXPIRED";
	actualCalls?: number | null;
	actualCostMicros?: number | null;
	errorCode?: string | null;
}

/**
 * Reserve inside an already-open brand transaction.
 *
 * The definer call runs in a savepoint: a refused reservation raises inside
 * Postgres, and without the savepoint that abort would take the caller's whole
 * transaction with it — including the FAILED run row that is the only record
 * of the refusal.
 */
export async function reserveProviderCall(tx: ContentTransaction, input: ReserveProviderCallInput): Promise<string> {
	try {
		return await tx.transaction(async (inner) => {
			const result = await inner.execute(
				sql`
					SELECT selena_registry.reserve_provider_call(
						${input.brandId}, ${input.providerId}, ${input.purpose}, ${input.idempotencyKey},
						${input.estimatedCalls}, ${input.estimatedCostMicros}, ${input.correlationId ?? null}
					) AS id
				`,
			);
			const id = (result.rows[0] as { id?: string } | undefined)?.id;
			if (!id) throw new Error("reserve_provider_call returned no reservation id");
			return id;
		});
	} catch (error) {
		throw toProviderBudgetError(error) ?? error;
	}
}

/** Settle inside an already-open brand transaction, with the same savepoint rule. */
export async function settleProviderCall(tx: ContentTransaction, input: SettleProviderCallInput): Promise<void> {
	try {
		await tx.transaction(async (inner) => {
			await inner.execute(
				sql`
					SELECT selena_registry.settle_provider_call(
						${input.ledgerId}, ${input.status}, ${input.actualCalls ?? null},
						${input.actualCostMicros ?? null}, ${input.errorCode ?? null}
					)
				`,
			);
		});
	} catch (error) {
		throw toProviderBudgetError(error) ?? error;
	}
}

export function createProviderBudgetRepositories(database: typeof db = db) {
	/**
	 * Append one budget row. The database enforces the actual rule — RLS admits
	 * the INSERT only from an interactive owner whose `set_by` is the session
	 * actor — so nothing is pre-checked here that would let the two answers
	 * drift apart.
	 */
	async function setBudget(
		context: ContentAuthContext,
		input: {
			brandId: string;
			providerId: string;
			windowKind: "DAY" | "MONTH";
			ceilingCalls: number;
			ceilingCostMicros: number;
		},
	): Promise<{ id: string }> {
		return withBrandRequestContext(
			database,
			context,
			input.brandId,
			async (tx) => {
				const [created] = await tx
					.insert(scrProviderBudgets)
					.values({
						organizationId: context.tenantId,
						brandId: input.brandId,
						providerId: input.providerId,
						windowKind: input.windowKind,
						ceilingCalls: input.ceilingCalls,
						ceilingCostMicros: input.ceilingCostMicros,
						setBy: context.actorId,
					})
					.returning({ id: scrProviderBudgets.id });
				if (!created) throw new Error("Provider budget could not be recorded");
				return created;
			},
			true,
		);
	}

	/**
	 * The newest budget per provider, with what the current window has already
	 * committed — summed the same way `reserve_provider_call` sums it, so what
	 * the UI shows is what the gate will decide with.
	 */
	async function getBudgets(context: ContentAuthContext, brandId: string) {
		return withBrandRequestContext(database, context, brandId, async (tx) => {
			const rows = await tx
				.select()
				.from(scrProviderBudgets)
				.where(and(eq(scrProviderBudgets.organizationId, context.tenantId), eq(scrProviderBudgets.brandId, brandId)))
				.orderBy(desc(scrProviderBudgets.createdAt), desc(scrProviderBudgets.id));

			const newestByProvider = new Map<string, (typeof rows)[number]>();
			for (const row of rows) {
				if (!newestByProvider.has(row.providerId)) newestByProvider.set(row.providerId, row);
			}

			const budgets = [];
			for (const budget of newestByProvider.values()) {
				const usage = await tx.execute(
					sql`
						SELECT
							COALESCE(SUM(COALESCE(actual_calls, estimated_calls)), 0)::bigint AS spent_calls,
							COALESCE(SUM(COALESCE(actual_cost_micros, estimated_cost_micros)), 0)::bigint AS spent_cost_micros
						FROM ${scrProviderCallLedger}
						WHERE organization_id = ${context.tenantId}
							AND brand_id = ${brandId}
							AND provider_id = ${budget.providerId}
							AND reserved_at >= date_trunc(${budget.windowKind === "DAY" ? "day" : "month"}, now())
							AND status <> 'EXPIRED'
					`,
				);
				const spent = usage.rows[0] as { spent_calls?: string; spent_cost_micros?: string } | undefined;
				budgets.push({
					id: budget.id,
					providerId: budget.providerId,
					windowKind: budget.windowKind,
					ceilingCalls: budget.ceilingCalls,
					ceilingCostMicros: budget.ceilingCostMicros,
					spentCalls: Number(spent?.spent_calls ?? 0),
					spentCostMicros: Number(spent?.spent_cost_micros ?? 0),
					setBy: budget.setBy,
					createdAt: budget.createdAt.toISOString(),
				});
			}
			return budgets;
		});
	}

	async function reserve(
		context: ContentAuthContext,
		input: ReserveProviderCallInput,
	): Promise<{ id: string }> {
		return withBrandRequestContext(
			database,
			context,
			input.brandId,
			async (tx) => ({ id: await reserveProviderCall(tx, input) }),
			true,
		);
	}

	async function settle(
		context: ContentAuthContext,
		input: SettleProviderCallInput & { brandId: string },
	): Promise<void> {
		return withBrandRequestContext(
			database,
			context,
			input.brandId,
			async (tx) => settleProviderCall(tx, input),
			true,
		);
	}

	return { setBudget, getBudgets, reserve, settle };
}

export const providerBudgetRepositories = createProviderBudgetRepositories();

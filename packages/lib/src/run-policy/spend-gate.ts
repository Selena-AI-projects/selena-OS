/**
 * One boundary in front of every provider call that costs money.
 *
 * Three paths can reach a paid vendor: the Selena measurement runner, the
 * legacy Elmo onboarding analysis, and the Selena onboarding suggestion. The
 * first is protected by permits and an emergency stop; the other two were
 * protected by nothing at all, and the suggestion is a button a signed-in
 * customer presses that spends real money on a live API key.
 *
 * Pure and env-driven so the same rule can be asserted in the web app, in the
 * worker, and inside the provider call itself, and unit-tested without any of
 * them.
 */

export const PROVIDER_STOP_ENV = "SELENA_EMERGENCY_STOP";
export const SUGGEST_BUDGET_ENV = "SELENA_SUGGEST_LLM";

/** The only value that turns the onboarding suggestion's spending on. */
export const SUGGEST_FREE_BUDGET_CLASS = "free_budget";

type Env = Record<string, string | undefined>;

export function isGlobalProviderStopEngaged(env: Env = process.env): boolean {
	return env[PROVIDER_STOP_ENV] === "true";
}

/**
 * The stop has to hold for every provider path, not only for measurement:
 * a stop that halts paid runs while an onboarding button keeps calling a
 * vendor is not a stop.
 */
export function assertGlobalProviderStop(env: Env = process.env): void {
	if (isGlobalProviderStopEngaged(env)) throw new Error("PROVIDER_CALLS_STOPPED");
}

/**
 * Whether the onboarding suggestion may call a paid model.
 *
 * Refused unless the owner has named the budget class explicitly: unset is
 * off, and so is any other value. The suggestion is worth having, but it is a
 * free feature with a real invoice behind it, and the customer pressing the
 * button has no idea of that — so switching it on is a deliberate act with a
 * name attached, the same shape as the measurement adapter allowlist.
 *
 * The class is a gate, not a meter. Nothing here counts calls or dollars; the
 * spend limit that actually holds is the cap on the provider account itself.
 */
export function assertSuggestSpendAllowed(env: Env = process.env): void {
	assertGlobalProviderStop(env);
	if (env[SUGGEST_BUDGET_ENV] !== SUGGEST_FREE_BUDGET_CLASS) throw new Error("SUGGEST_LLM_NOT_BUDGETED");
}

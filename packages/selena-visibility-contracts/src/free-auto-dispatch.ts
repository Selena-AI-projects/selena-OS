/**
 * When a promo code makes a measurement free, the human approval step in the
 * order desk is no longer protecting a payment — the customer's own questions
 * about the customer's own project cost them nothing. This decides whether such
 * a request may start on its own, and it is deliberately hard to say yes:
 *
 *   - the flag is default-off, so a deploy alone never starts a run;
 *   - only a free request qualifies — a paid one still goes through the desk;
 *   - two daily caps bound the worst case if a code leaks.
 *
 * Everything here is a pure decision. The caller supplies today's counts and
 * performs the dispatch; nothing in this module reaches a database or provider.
 */

export type FreeAutoDispatchConfig = {
	enabled: boolean;
	maxPerDay: number;
	maxPerProjectPerDay: number;
};

/** Small enough that a leaked code costs a few dollars, not a budget. */
export const FREE_AUTO_DISPATCH_DEFAULT_PER_DAY = 3;
export const FREE_AUTO_DISPATCH_DEFAULT_PER_PROJECT_PER_DAY = 1;

function readCap(raw: string | undefined, fallback: number): number {
	if (raw === undefined || raw.trim() === "") return fallback;
	const parsed = Number(raw);
	// A malformed cap must not read as "unlimited": an unparseable value falls
	// back to the conservative default rather than to no limit at all.
	if (!Number.isInteger(parsed) || parsed < 0) return fallback;
	return parsed;
}

export function freeAutoDispatchConfigFromEnv(env: Record<string, string | undefined>): FreeAutoDispatchConfig {
	return {
		enabled: env.SELENA_FREE_AUTO_DISPATCH_ENABLED === "true",
		maxPerDay: readCap(env.SELENA_FREE_AUTO_DISPATCH_MAX_PER_DAY, FREE_AUTO_DISPATCH_DEFAULT_PER_DAY),
		maxPerProjectPerDay: readCap(
			env.SELENA_FREE_AUTO_DISPATCH_MAX_PER_PROJECT_PER_DAY,
			FREE_AUTO_DISPATCH_DEFAULT_PER_PROJECT_PER_DAY,
		),
	};
}

export const freeAutoDispatchRefusals = ["DISABLED", "NOT_FREE", "DAILY_CAP", "PROJECT_CAP"] as const;
export type FreeAutoDispatchRefusal = (typeof freeAutoDispatchRefusals)[number];

export type FreeAutoDispatchDecision = { dispatch: true } | { dispatch: false; reason: FreeAutoDispatchRefusal };

export function decideFreeAutoDispatch(input: {
	config: FreeAutoDispatchConfig;
	promoApplied: boolean;
	dispatchedToday: number;
	dispatchedTodayForProject: number;
}): FreeAutoDispatchDecision {
	if (!input.config.enabled) return { dispatch: false, reason: "DISABLED" };
	if (!input.promoApplied) return { dispatch: false, reason: "NOT_FREE" };
	if (input.dispatchedToday >= input.config.maxPerDay) return { dispatch: false, reason: "DAILY_CAP" };
	if (input.dispatchedTodayForProject >= input.config.maxPerProjectPerDay)
		return { dispatch: false, reason: "PROJECT_CAP" };
	return { dispatch: true };
}

/**
 * Statuses an auto-dispatched request carries on the operator's inbox. A
 * refusal or a failure stays visible as ordinary work to pick up by hand, which
 * is why neither of them closes the request.
 */
export const freeAutoDispatchStatuses = ["AUTO_QUEUED", "AUTO_FAILED"] as const;
export type FreeAutoDispatchStatus = (typeof freeAutoDispatchStatuses)[number];

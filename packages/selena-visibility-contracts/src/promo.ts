/**
 * Promo codes stand in for payment while there is no online checkout: a valid
 * code marks an order request as free of charge, nothing more. The codes live
 * in SELENA_PROMO_CODES (comma separated) so handing one out — and revoking
 * it — is an env change, never a deploy. Unset means no code works.
 */

export function promoCodesFromEnv(env: Record<string, string | undefined>): string[] {
	return (env.SELENA_PROMO_CODES ?? "")
		.split(",")
		.map((code) => code.trim().toUpperCase())
		.filter(Boolean);
}

export function promoCodeApplies(code: string | undefined, env: Record<string, string | undefined>): boolean {
	const entered = (code ?? "").trim().toUpperCase();
	if (!entered) return false;
	return promoCodesFromEnv(env).includes(entered);
}

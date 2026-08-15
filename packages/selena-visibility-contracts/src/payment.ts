export type SelenaPaymentState = "payment_pending" | "paid" | "failed" | "cancelled" | "refunded";
export type SelenaPaymentMode = "test" | "live";

export type SelenaPaymentConfig = {
	mode: SelenaPaymentMode;
	enabled: boolean;
};

export function paymentConfigFromEnv(env: Record<string, string | undefined>): SelenaPaymentConfig {
	return {
		mode: env.SELENA_PAYMENT_MODE === "live" ? "live" : "test",
		enabled: env.SELENA_PAYMENTS_ENABLED === "true",
	};
}

export function assertPaymentAllowed(config: SelenaPaymentConfig, requestedMode: SelenaPaymentMode): void {
	if (!config.enabled) throw new Error("SELENA_PAYMENTS_DISABLED");
	if (config.mode !== requestedMode) throw new Error("SELENA_PAYMENT_MODE_MISMATCH");
	if (requestedMode === "live") throw new Error("SELENA_LIVE_PAYMENTS_REQUIRE_OWNER_GO");
}

export function paymentIdempotencyKey(provider: string, providerEventId: string): string {
	return `${provider}:${providerEventId}`;
}

export async function verifyWebhookSignature(payload: string, signature: string, secret: string): Promise<boolean> {
	if (!payload || !signature || !secret) return false;
	const actual = signature.startsWith("sha256=") ? signature.slice("sha256=".length) : signature;
	const key = await globalThis.crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const digest = new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
	const expected = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return expected.length === actual.length && expected === actual;
}

export function assertPaymentTransition(from: SelenaPaymentState, to: SelenaPaymentState): void {
	const allowed: Record<SelenaPaymentState, SelenaPaymentState[]> = {
		payment_pending: ["paid", "failed", "cancelled"],
		paid: ["refunded"],
		failed: [],
		cancelled: [],
		refunded: [],
	};
	if (!allowed[from].includes(to)) throw new Error(`SELENA_PAYMENT_TRANSITION_BLOCKED:${from}:${to}`);
}

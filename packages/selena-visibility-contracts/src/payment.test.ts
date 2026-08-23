import { describe, expect, it } from "vitest";
import {
	assertPaymentAllowed,
	assertPaymentTransition,
	paymentConfigFromEnv,
	paymentIdempotencyKey,
	verifyWebhookSignature,
} from "./payment";

describe("Selena payment boundary", () => {
	it("defaults to disabled test mode", () => {
		expect(paymentConfigFromEnv({})).toEqual({ enabled: false, mode: "test" });
		expect(() => assertPaymentAllowed(paymentConfigFromEnv({}), "test")).toThrow("SELENA_PAYMENTS_DISABLED");
	});

	it("allows only explicitly enabled test mode", () => {
		const config = paymentConfigFromEnv({ SELENA_PAYMENTS_ENABLED: "true", SELENA_PAYMENT_MODE: "test" });
		expect(() => assertPaymentAllowed(config, "test")).not.toThrow();
		expect(() => assertPaymentAllowed(config, "live")).toThrow("SELENA_PAYMENT_MODE_MISMATCH");
	});

	it("uses stable provider event idempotency and verifies signatures", async () => {
		const payload = JSON.stringify({ event: "payment_succeeded" });
		const key = await globalThis.crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode("test-secret"),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const digest = new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
		const signature = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
		expect(paymentIdempotencyKey("test", "evt-1")).toBe("test:evt-1");
		expect(await verifyWebhookSignature(payload, `sha256=${signature}`, "test-secret")).toBe(true);
		expect(await verifyWebhookSignature(payload, signature.slice(1), "test-secret")).toBe(false);
	});

	it("blocks invalid payment state transitions", () => {
		expect(() => assertPaymentTransition("payment_pending", "paid")).not.toThrow();
		expect(() => assertPaymentTransition("paid", "payment_pending")).toThrow("TRANSITION_BLOCKED");
	});
});

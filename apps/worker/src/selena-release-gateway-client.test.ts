import { createOpaqueWorkflowPayload } from "@workspace/lib/selena-control-room";
import { describe, expect, it, vi } from "vitest";
import type { ReleaseDispatchReport } from "./selena-release-dispatch";
import { createReleaseGatewayClient, requiredGatewayConfig } from "./selena-release-gateway-client";
import { createGatewayReleaseCarrier } from "./selena-trigger-dispatcher";

const MANIFEST_ID = "99999999-9999-9999-9999-999999999999";
const RELEASE_INTENT_ID = "33333333-3333-3333-3333-333333333333";

function carryInput() {
	return {
		concurrencyKey: "brand:selena",
		idempotencyKey: "release-idempotency-key",
		payload: createOpaqueWorkflowPayload({
			correlationId: "44444444-4444-4444-4444-444444444444",
			releaseIntentId: RELEASE_INTENT_ID,
		}),
	};
}

function gateway(report: ReleaseDispatchReport) {
	const posts: { body: unknown; path: string }[] = [];
	const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const path = String(input).replace("https://gateway.test.invalid", "");
		posts.push({ body: JSON.parse(String(init?.body)), path });
		if (path === "/v1/release-manifests") {
			return new Response(
				JSON.stringify({
					expiresAt: "2030-01-01T01:00:00.000Z",
					manifestHash: "b".repeat(64),
					manifestId: MANIFEST_ID,
				}),
				{ status: 200 },
			);
		}
		return new Response(JSON.stringify(report), { status: 200 });
	});
	const client = createReleaseGatewayClient(
		{ baseUrl: "https://gateway.test.invalid", token: "gateway-test-token" },
		fetchFn as unknown as typeof fetch,
	);
	return { client, fetchFn, posts };
}

describe("requiredGatewayConfig", () => {
	it("is absent only when neither half is set", () => {
		expect(requiredGatewayConfig({})).toBeNull();
		expect(() => requiredGatewayConfig({ SELENA_GATEWAY_BASE_URL: "https://gateway.test.invalid" })).toThrow(
			/together/,
		);
		expect(() => requiredGatewayConfig({ SELENA_GATEWAY_INTERNAL_TOKEN: "t" })).toThrow(/together/);
	});

	it("allows plain HTTP only where the address cannot leave the contour", () => {
		expect(
			requiredGatewayConfig({
				SELENA_GATEWAY_BASE_URL: "http://gateway.railway.internal:8082/",
				SELENA_GATEWAY_INTERNAL_TOKEN: "t",
			}),
		).toEqual({ baseUrl: "http://gateway.railway.internal:8082", token: "t" });
		expect(() =>
			requiredGatewayConfig({
				SELENA_GATEWAY_BASE_URL: "http://gateway.example.com",
				SELENA_GATEWAY_INTERNAL_TOKEN: "t",
			}),
		).toThrow(/HTTPS/);
	});
});

describe("the gateway client", () => {
	it("signs a manifest with the internal token and refuses an answer without an id", async () => {
		const { client, posts, fetchFn } = gateway({ outcome: "SKIPPED", reservationId: "reservation-1" });
		await expect(client.signManifest(RELEASE_INTENT_ID)).resolves.toMatchObject({ manifestId: MANIFEST_ID });
		expect(posts[0]).toEqual({ body: { releaseIntentId: RELEASE_INTENT_ID }, path: "/v1/release-manifests" });
		const headers = (fetchFn.mock.calls[0]?.[1] as RequestInit | undefined)?.headers as Record<string, string>;
		expect(headers.authorization).toBe("Bearer gateway-test-token");

		const empty = createReleaseGatewayClient(
			{ baseUrl: "https://gateway.test.invalid", token: "t" },
			(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
		);
		await expect(empty.signManifest(RELEASE_INTENT_ID)).rejects.toThrow(/no manifest id/);
	});

	it("does not hide an unhappy gateway behind a parsed body", async () => {
		const client = createReleaseGatewayClient(
			{ baseUrl: "https://gateway.test.invalid", token: "t" },
			(async () => new Response("nope", { status: 503 })) as unknown as typeof fetch,
		);
		await expect(client.signManifest(RELEASE_INTENT_ID)).rejects.toThrow(/503/);
	});
});

describe("the gateway release carrier", () => {
	it("closes the queue entry on an accepted release, naming what the provider answered", async () => {
		const { client, posts } = gateway({
			outcome: "ACCEPTED",
			providerReferenceId: "blotato-post-1",
			reservationId: "reservation-1",
		});
		await expect(createGatewayReleaseCarrier(client).carry(carryInput())).resolves.toEqual({
			reference: "blotato-post-1",
			state: "COMPLETED",
		});
		expect(posts.map((post) => post.path)).toEqual(["/v1/release-manifests", "/v1/release-dispatches"]);
		expect(posts[1]?.body).toEqual({ idempotencyKey: "release-idempotency-key", manifestId: MANIFEST_ID });
	});

	it("treats a reservation that was already made as carried, without publishing again", async () => {
		const { client } = gateway({ outcome: "SKIPPED", reservationId: "reservation-1" });
		await expect(createGatewayReleaseCarrier(client).carry(carryInput())).resolves.toEqual({
			reference: "reservation-1",
			state: "COMPLETED",
		});
	});

	it.each([
		["a refusal that never left", { outcome: "NOT_SENT", reason: "refused", reservationId: "r" }, "FAILED"],
		["a provider rejection", { outcome: "DEFINITIVE_FAILURE", reason: "rejected", reservationId: "r" }, "FAILED"],
		[
			"an answer nobody can read",
			{ outcome: "AMBIGUOUS", reason: "no answer", reservationId: "r" },
			"RECONCILIATION_REQUIRED",
		],
	] satisfies Array<[string, ReleaseDispatchReport, string]>)(
		"records %s as a conclusion rather than retrying it",
		async (_name, report, state) => {
			const { client } = gateway(report);
			await expect(createGatewayReleaseCarrier(client).carry(carryInput())).resolves.toMatchObject({ state });
		},
	);

	it("leaves the release queued when the contour has no provider configured", async () => {
		const { client } = gateway({ missing: ["BLOTATO_API_KEY"], outcome: "NOT_CONFIGURED" });
		await expect(createGatewayReleaseCarrier(client).carry(carryInput())).rejects.toThrow(/BLOTATO_API_KEY/);
	});
});

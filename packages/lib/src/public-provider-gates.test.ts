import { describe, expect, it, vi } from "vitest";
import {
	createBrightDataSerpClient,
	createGoogleGbpReviewsClient,
	createGooglePlacesClient,
	createMetaInstagramClient,
	GBP_RAW_RETENTION_DAYS,
	getPublicProviderCredentialStatus,
	isGbpRawDataExpired,
	PublicProviderCostLedger,
} from "./public-provider-gates";

const response = (body: unknown): Response =>
	new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("public provider gates", () => {
	it("hard-stops disabled providers before fetch and records no cost", async () => {
		const fetcher = vi.fn();
		const credentialResolver = vi.fn(() => "fixture");
		const ledger = new PublicProviderCostLedger();
		const client = createBrightDataSerpClient({ ledger, credentialResolver, fetcher });
		await expect(client.search("audit-a", "brand")).rejects.toThrow("PROVIDER_FEATURE_DISABLED");
		expect(fetcher).not.toHaveBeenCalled();
		expect(credentialResolver).not.toHaveBeenCalled();
		expect(ledger.entries()).toHaveLength(0);
	});

	it("enforces the per-audit and staging budget before an HTTP call", async () => {
		const fetcher = vi.fn().mockImplementation(() => Promise.resolve(response({ organic: [] })));
		const ledger = new PublicProviderCostLedger({ totalUsd: 5, auditUsd: 0.25 });
		const client = createBrightDataSerpClient({
			flags: { BRIGHT_DATA_SERP: true },
			ledger,
			credentialResolver: () => "fixture",
			fetcher,
		});
		for (let index = 0; index < 166; index++) await client.search("audit-a", `brand ${index}`);
		await expect(client.search("audit-a", "last")).rejects.toThrow("AUDIT_COST_LIMIT_EXCEEDED");
		expect(fetcher).toHaveBeenCalledTimes(166);
	});

	it("requires an explicit Google Places unit price and preserves field masks", async () => {
		const fetcher = vi.fn().mockImplementation(() => Promise.resolve(response({ id: "place-1" })));
		const ledger = new PublicProviderCostLedger();
		const client = createGooglePlacesClient({
			flags: { GOOGLE_PLACES: true },
			ledger,
			credentialResolver: () => "fixture",
			fetcher,
			googlePlacesUnitCostUsd: 0.01,
		});
		await client.placeDetails("audit-a", "place-1");
		expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
			headers: expect.objectContaining({ "x-goog-fieldmask": "id,displayName,rating,userRatingCount" }),
		});
	});

	it("allows GBP and Meta only through OAuth-shaped clients", async () => {
		const fetcher = vi.fn().mockImplementation(() => Promise.resolve(response({ data: [] })));
		const ledger = new PublicProviderCostLedger();
		const options = {
			ledger,
			fetcher,
			oauthTokenResolver: () => "fixture-token",
			flags: { GOOGLE_GBP_REVIEWS: true, META_INSTAGRAM: true },
		};
		await createGoogleGbpReviewsClient(options).listReviews("audit-a", "account", "location");
		await createMetaInstagramClient(options).businessDiscovery("audit-a", "user", "business");
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it("never falls back to a system credential for OAuth providers", async () => {
		const fetcher = vi.fn();
		const ledger = new PublicProviderCostLedger();
		const client = createGoogleGbpReviewsClient({
			flags: { GOOGLE_GBP_REVIEWS: true },
			ledger,
			credentialResolver: () => "must-not-be-used",
			fetcher,
		});

		await expect(client.listReviews("audit-a", "account", "location")).rejects.toThrow("PROVIDER_CREDENTIAL_REQUIRED");
		expect(fetcher).not.toHaveBeenCalled();
		expect(ledger.entries()).toHaveLength(0);
	});

	it("checks the budget before resolving credentials", async () => {
		const fetcher = vi.fn();
		const credentialResolver = vi.fn(() => "fixture");
		const client = createBrightDataSerpClient({
			flags: { BRIGHT_DATA_SERP: true },
			ledger: new PublicProviderCostLedger({ totalUsd: 0, auditUsd: 0 }),
			credentialResolver,
			fetcher,
		});

		await expect(client.search("audit-a", "brand")).rejects.toThrow("AUDIT_COST_LIMIT_EXCEEDED");
		expect(credentialResolver).not.toHaveBeenCalled();
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("reports credential presence without returning credential values", () => {
		const resolver = vi.fn((name: string) => (name === "BRIGHTDATA_API_TOKEN" ? "never-return-this" : undefined));

		expect(getPublicProviderCredentialStatus("BRIGHT_DATA_SERP", resolver)).toBe("PRESENT");
		expect(getPublicProviderCredentialStatus("GOOGLE_PLACES", resolver)).toBe("MISSING");
		expect(getPublicProviderCredentialStatus("META_INSTAGRAM", resolver)).toBe("OAUTH_REQUIRED");
	});

	it("redacts transport failures instead of propagating secret-bearing errors", async () => {
		const client = createBrightDataSerpClient({
			flags: { BRIGHT_DATA_SERP: true },
			ledger: new PublicProviderCostLedger(),
			credentialResolver: () => "sensitive-fixture",
			fetcher: vi.fn().mockRejectedValue(new Error("request contained sensitive-fixture")),
		});

		await expect(client.search("audit-a", "brand")).rejects.toThrow("PROVIDER_HTTP_TRANSPORT_FAILED");
		await expect(client.search("audit-b", "brand")).rejects.not.toThrow("sensitive-fixture");
	});

	it("expires raw GBP data after the configured 30-day window", () => {
		const now = new Date("2026-08-15T00:00:00Z");
		expect(GBP_RAW_RETENTION_DAYS).toBe(30);
		expect(isGbpRawDataExpired("2026-07-15T00:00:00Z", now)).toBe(true);
		expect(isGbpRawDataExpired("2026-08-01T00:00:00Z", now)).toBe(false);
	});
});

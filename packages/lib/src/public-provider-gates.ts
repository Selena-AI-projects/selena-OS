import { createHash } from "node:crypto";
import { getCredential } from "./secrets";

export type PublicProvider = "BRIGHT_DATA_SERP" | "GOOGLE_PLACES" | "GOOGLE_GBP_REVIEWS" | "META_INSTAGRAM";
export type PublicProviderFlags = Record<PublicProvider, boolean>;

export const PUBLIC_PROVIDER_FLAGS_DISABLED: PublicProviderFlags = {
	BRIGHT_DATA_SERP: false,
	GOOGLE_PLACES: false,
	GOOGLE_GBP_REVIEWS: false,
	META_INSTAGRAM: false,
};

export type CostLedgerEntry = {
	provider: PublicProvider;
	auditId: string;
	requestCount: number;
	costUsd: number;
	createdAt: string;
};

export class PublicProviderCostLedger {
	private readonly rows: CostLedgerEntry[] = [];

	constructor(private readonly limits = { totalUsd: 5, auditUsd: 0.25 }) {}

	assertCanReserve(input: Omit<CostLedgerEntry, "createdAt">): void {
		if (!Number.isFinite(input.costUsd) || input.costUsd < 0) throw new Error("PROVIDER_COST_UNKNOWN");
		const auditTotal = this.rows
			.filter((entry) => entry.auditId === input.auditId)
			.reduce((sum, entry) => sum + entry.costUsd, 0);
		const total = this.rows.reduce((sum, entry) => sum + entry.costUsd, 0);
		if (auditTotal + input.costUsd > this.limits.auditUsd) throw new Error("AUDIT_COST_LIMIT_EXCEEDED");
		if (total + input.costUsd > this.limits.totalUsd) throw new Error("STAGING_COST_LIMIT_EXCEEDED");
	}

	reserve(input: Omit<CostLedgerEntry, "createdAt">): CostLedgerEntry {
		this.assertCanReserve(input);
		const entry = { ...input, createdAt: new Date().toISOString() };
		this.rows.push(entry);
		return entry;
	}

	entries(): readonly CostLedgerEntry[] {
		return this.rows;
	}
}

export type PublicProviderSystemCredential = "BRIGHTDATA_API_TOKEN" | "GOOGLE_PLACES_API_KEY";
export type PublicProviderCredentialStatus = "PRESENT" | "MISSING" | "OAUTH_REQUIRED";
export type PublicProviderCredentialResolver = (name: PublicProviderSystemCredential) => string | undefined;
export type PublicProviderOAuthTokenResolver = (
	provider: "GOOGLE_GBP_REVIEWS" | "META_INSTAGRAM",
	auditId: string,
) => string | undefined | Promise<string | undefined>;

const SYSTEM_CREDENTIALS: Partial<Record<PublicProvider, PublicProviderSystemCredential>> = {
	BRIGHT_DATA_SERP: "BRIGHTDATA_API_TOKEN",
	GOOGLE_PLACES: "GOOGLE_PLACES_API_KEY",
};

export function getPublicProviderCredentialStatus(
	provider: PublicProvider,
	resolveCredential: PublicProviderCredentialResolver = getCredential,
): PublicProviderCredentialStatus {
	const name = SYSTEM_CREDENTIALS[provider];
	if (!name) return "OAUTH_REQUIRED";
	return resolveCredential(name) ? "PRESENT" : "MISSING";
}

export type ProviderHttpClientOptions = {
	flags?: Partial<PublicProviderFlags>;
	ledger: PublicProviderCostLedger;
	fetcher?: typeof fetch;
	credentialResolver?: PublicProviderCredentialResolver;
	oauthTokenResolver?: PublicProviderOAuthTokenResolver;
	googlePlacesUnitCostUsd?: number;
};

type CredentialRequirement =
	| { kind: "system"; name: PublicProviderSystemCredential }
	| { kind: "oauth"; provider: "GOOGLE_GBP_REVIEWS" | "META_INSTAGRAM" };

async function guardedFetch(
	provider: PublicProvider,
	url: string,
	buildInit: (credential: string) => RequestInit,
	credentialRequirement: CredentialRequirement,
	options: ProviderHttpClientOptions,
	charge: Omit<CostLedgerEntry, "createdAt">,
): Promise<unknown> {
	const flags = { ...PUBLIC_PROVIDER_FLAGS_DISABLED, ...options.flags };
	if (!flags[provider]) throw new Error("PROVIDER_FEATURE_DISABLED");
	if (!options.fetcher) throw new Error("PROVIDER_HTTP_CLIENT_NOT_CONFIGURED");
	options.ledger.assertCanReserve(charge);
	const credential =
		credentialRequirement.kind === "system"
			? (options.credentialResolver ?? getCredential)(credentialRequirement.name)
			: await options.oauthTokenResolver?.(credentialRequirement.provider, charge.auditId);
	if (!credential) throw new Error("PROVIDER_CREDENTIAL_REQUIRED");
	options.ledger.reserve(charge);
	let response: Response;
	try {
		response = await options.fetcher(url, buildInit(credential));
	} catch {
		throw new Error("PROVIDER_HTTP_TRANSPORT_FAILED");
	}
	if (!response.ok) throw new Error(`PROVIDER_HTTP_${response.status}`);
	try {
		return await response.json();
	} catch {
		throw new Error("PROVIDER_RESPONSE_INVALID_JSON");
	}
}

export function createBrightDataSerpClient(options: ProviderHttpClientOptions) {
	return {
		search: (auditId: string, query: string) =>
			guardedFetch(
				"BRIGHT_DATA_SERP",
				"https://api.brightdata.com/request",
				(apiKey) => ({
					method: "POST",
					headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
					body: JSON.stringify({
						zone: "serp_api1",
						url: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
						format: "json",
					}),
				}),
				{ kind: "system", name: "BRIGHTDATA_API_TOKEN" },
				options,
				{ provider: "BRIGHT_DATA_SERP", auditId, requestCount: 1, costUsd: 0.0015 },
			),
	};
}

export function createGooglePlacesClient(options: ProviderHttpClientOptions) {
	return {
		placeDetails: (auditId: string, placeId: string, fields = ["id", "displayName", "rating", "userRatingCount"]) =>
			guardedFetch(
				"GOOGLE_PLACES",
				`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
				(apiKey) => ({ headers: { "x-goog-api-key": apiKey, "x-goog-fieldmask": fields.join(",") } }),
				{ kind: "system", name: "GOOGLE_PLACES_API_KEY" },
				options,
				{ provider: "GOOGLE_PLACES", auditId, requestCount: 1, costUsd: options.googlePlacesUnitCostUsd ?? NaN },
			),
	};
}

export function createGoogleGbpReviewsClient(options: ProviderHttpClientOptions) {
	return {
		listReviews: (auditId: string, accountId: string, locationId: string) =>
			guardedFetch(
				"GOOGLE_GBP_REVIEWS",
				`https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/reviews`,
				(oauthAccessToken) => ({ headers: { authorization: `Bearer ${oauthAccessToken}` } }),
				{ kind: "oauth", provider: "GOOGLE_GBP_REVIEWS" },
				options,
				{ provider: "GOOGLE_GBP_REVIEWS", auditId, requestCount: 1, costUsd: 0 },
			),
	};
}

export function createMetaInstagramClient(options: ProviderHttpClientOptions) {
	return {
		businessDiscovery: (auditId: string, userId: string, username: string) =>
			guardedFetch(
				"META_INSTAGRAM",
				`https://graph.facebook.com/v23.0/${userId}?fields=business_discovery.username(${encodeURIComponent(username)})`,
				(oauthAccessToken) => ({ headers: { authorization: `Bearer ${oauthAccessToken}` } }),
				{ kind: "oauth", provider: "META_INSTAGRAM" },
				options,
				{ provider: "META_INSTAGRAM", auditId, requestCount: 1, costUsd: 0 },
			),
	};
}

export function hashProviderPayload(payload: unknown): string {
	return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export const GBP_RAW_RETENTION_DAYS = 30;

export function isGbpRawDataExpired(capturedAt: string, now = new Date()): boolean {
	return now.getTime() - new Date(capturedAt).getTime() > GBP_RAW_RETENTION_DAYS * 24 * 60 * 60 * 1000;
}

import { describe, expect, it, vi } from "vitest";
import type { NormalizedRelease, ReleaseDispatchAuthorization } from "./selena-release-provider";
import { BLOTATO_PROVIDER_ID } from "./selena-release-provider-blotato";
import { configureReleaseProviders, releaseEnvironmentFrom } from "./selena-release-providers";
import { PublishRefusedError } from "./selena-release-publish-policy";

const ACCOUNT_ID = "acct-1";
const NOT_BEFORE = "2030-01-02T12:00:00.000Z";
const NOW = new Date("2030-01-01T00:00:00.000Z");
const CONFIGURED = { BLOTATO_ALLOWED_ACCOUNT_ID: ACCOUNT_ID, BLOTATO_API_KEY: "test-key" };

function transport(): { calls: string[]; fetchFn: typeof fetch } {
	const calls: string[] = [];
	const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		calls.push(url);
		const json = (body: unknown) =>
			new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status: 200 });
		if (url.endsWith("/accounts")) {
			return json({ items: [{ id: ACCOUNT_ID, fullname: "Page", platform: "linkedin" }] });
		}
		if (url.endsWith("/posts")) return json({ postSubmissionId: "sub-1", scheduledTime: NOT_BEFORE });
		throw new Error(`Unexpected request: ${url}`);
	});
	return { calls, fetchFn: fetchFn as unknown as typeof fetch };
}

function release(): NormalizedRelease {
	return {
		assets: [],
		body: "A reviewed release body",
		brandId: "selena",
		contentHash: "a".repeat(64),
		contentVersionId: "11111111-1111-1111-1111-111111111111",
		ctaUrl: "https://selena.test.invalid/offer",
		destination: {
			accountRef: "Page",
			channelAccountId: "22222222-2222-2222-2222-222222222222",
			externalAccountId: ACCOUNT_ID,
			platform: "linkedin_page",
		},
		notBefore: NOT_BEFORE,
		organizationId: "default",
		releaseIntentId: "33333333-3333-3333-3333-333333333333",
		timezone: "UTC",
	};
}

function authorization(environment: ReleaseDispatchAuthorization["environment"]): ReleaseDispatchAuthorization {
	return {
		auditEventId: "44444444-4444-4444-4444-444444444444",
		contentHash: "a".repeat(64),
		environment,
		expiresAt: "2030-01-01T01:00:00.000Z",
		idempotencyKey: "release-idempotency-key",
		killSwitchActive: false,
		manifestHash: "b".repeat(64),
		providerId: BLOTATO_PROVIDER_ID,
		signature: "signed-manifest",
		signatureAlgorithm: "Ed25519",
		signingKeyVersion: "v1",
	};
}

describe("releaseEnvironmentFrom", () => {
	it("reads the contour name the projection worker already uses", () => {
		expect(releaseEnvironmentFrom({ SELENA_GROWTH_SOURCE_ENVIRONMENT: "production" })).toBe("PRODUCTION");
		expect(releaseEnvironmentFrom({ SELENA_GROWTH_SOURCE_ENVIRONMENT: "staging" })).toBe("STAGING");
	});

	it("guards as DRY_RUN when the contour has not said where it is", () => {
		expect(releaseEnvironmentFrom({})).toBe("DRY_RUN");
		expect(releaseEnvironmentFrom({ SELENA_GROWTH_SOURCE_ENVIRONMENT: "local" })).toBe("DRY_RUN");
		expect(releaseEnvironmentFrom({ SELENA_GROWTH_SOURCE_ENVIRONMENT: "PRODUCTION" })).toBe("DRY_RUN");
	});
});

describe("configureReleaseProviders", () => {
	it("names what is missing instead of building a provider that fails on first use", () => {
		expect(configureReleaseProviders({}, transport().fetchFn)).toEqual({
			missing: ["BLOTATO_API_KEY", "BLOTATO_ALLOWED_ACCOUNT_ID"],
			state: "NOT_CONFIGURED",
		});
		expect(configureReleaseProviders({ BLOTATO_API_KEY: "k" }, transport().fetchFn)).toMatchObject({
			missing: ["BLOTATO_ALLOWED_ACCOUNT_ID"],
		});
	});

	it("lets a staging runtime look at its account without being able to publish", async () => {
		const { calls, fetchFn } = transport();
		const configured = configureReleaseProviders(
			{ ...CONFIGURED, SELENA_GROWTH_SOURCE_ENVIRONMENT: "staging", SELENA_RELEASE_PUBLISH_ENABLED: "true" },
			fetchFn,
		);
		if (configured.state !== "CONFIGURED") throw new Error("expected a configured registry");
		expect(configured.environment).toBe("STAGING");

		const provider = configured.registry.resolve(BLOTATO_PROVIDER_ID);
		await expect(provider.validateConnection()).resolves.toMatchObject({ state: "CONNECTED" });
		await expect(provider.listAccounts()).resolves.toHaveLength(1);

		expect(() =>
			provider.prepareManifest({ authorization: authorization("STAGING"), now: NOW, release: release() }),
		).toThrow(PublishRefusedError);
		expect(calls.filter((url) => url.endsWith("/posts"))).toHaveLength(0);
	});

	it("keeps a production runtime shut until the publish flag is set", () => {
		const configured = configureReleaseProviders(
			{ ...CONFIGURED, SELENA_GROWTH_SOURCE_ENVIRONMENT: "production" },
			transport().fetchFn,
		);
		if (configured.state !== "CONFIGURED") throw new Error("expected a configured registry");
		const provider = configured.registry.resolve(BLOTATO_PROVIDER_ID);
		let refusal: string | undefined;
		try {
			provider.prepareManifest({ authorization: authorization("PRODUCTION"), now: NOW, release: release() });
		} catch (error) {
			refusal = error instanceof PublishRefusedError ? error.refusal : "UNEXPECTED";
		}
		expect(refusal).toBe("PUBLISH_FLAG_NOT_SET");
	});

	it("reaches the provider only where production and the flag agree", async () => {
		const { calls, fetchFn } = transport();
		const configured = configureReleaseProviders(
			{ ...CONFIGURED, SELENA_GROWTH_SOURCE_ENVIRONMENT: "production", SELENA_RELEASE_PUBLISH_ENABLED: "true" },
			fetchFn,
		);
		if (configured.state !== "CONFIGURED") throw new Error("expected a configured registry");
		const provider = configured.registry.resolve(BLOTATO_PROVIDER_ID);
		const prepared = provider.prepareManifest({
			authorization: authorization("PRODUCTION"),
			now: NOW,
			release: release(),
		});
		await expect(provider.dispatch(prepared)).resolves.toMatchObject({ outcome: "ACCEPTED" });
		expect(calls.filter((url) => url.endsWith("/posts"))).toHaveLength(1);
	});
});

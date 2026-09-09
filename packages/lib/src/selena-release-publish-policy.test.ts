import { describe, expect, it, vi } from "vitest";
import { createBlotatoAdapter } from "./selena-blotato";
import type { NormalizedRelease, ReleaseDispatchAuthorization } from "./selena-release-provider";
import { createReleaseProviderRegistry } from "./selena-release-provider";
import { BLOTATO_PROVIDER_ID, createBlotatoReleaseProvider } from "./selena-release-provider-blotato";
import { createFakeReleaseProvider } from "./selena-release-provider-fake";
import {
	assertPublishAllowed,
	disarmedFetch,
	guardPublishing,
	PUBLISH_FLAG,
	PublishRefusedError,
	resolvePublishDecision,
} from "./selena-release-publish-policy";

const CONTENT_HASH = "a".repeat(64);
const MANIFEST_HASH = "b".repeat(64);
const NOW = new Date("2030-01-01T00:00:00.000Z");
const NOT_BEFORE = "2030-01-02T12:00:00.000Z";
const PUBLISHING_ENV = { [PUBLISH_FLAG]: "true" };
const BLOTATO_ACCOUNT_ID = "blotato-account-1";

// Every Blotato request in this file must resolve against an unreachable host,
// so a stub that ever stops matching fails loudly instead of reaching Blotato.
const BLOTATO_TEST_API_URL = "https://blotato.test.invalid/v2";

function release(overrides: Partial<NormalizedRelease> = {}): NormalizedRelease {
	return {
		assets: [
			{
				assetId: "asset-1",
				mimeType: "image/png",
				sha256: "c".repeat(64),
				sourceUrl: "https://storage.test.invalid/asset-1.png",
			},
		],
		body: "A reviewed release body",
		brandId: "selena",
		contentHash: CONTENT_HASH,
		contentVersionId: "11111111-1111-1111-1111-111111111111",
		ctaUrl: "https://selena.test.invalid/offer",
		destination: {
			accountRef: "Selena LinkedIn Page",
			channelAccountId: "22222222-2222-2222-2222-222222222222",
			externalAccountId: BLOTATO_ACCOUNT_ID,
			platform: "linkedin_page",
		},
		notBefore: NOT_BEFORE,
		organizationId: "default",
		releaseIntentId: "33333333-3333-3333-3333-333333333333",
		timezone: "UTC",
		...overrides,
	};
}

function authorization(overrides: Partial<ReleaseDispatchAuthorization> = {}): ReleaseDispatchAuthorization {
	return {
		auditEventId: "44444444-4444-4444-4444-444444444444",
		contentHash: CONTENT_HASH,
		environment: "PRODUCTION",
		expiresAt: "2030-01-01T01:00:00.000Z",
		idempotencyKey: "release-idempotency-key",
		killSwitchActive: false,
		manifestHash: MANIFEST_HASH,
		providerId: BLOTATO_PROVIDER_ID,
		signature: "signed-manifest",
		signatureAlgorithm: "Ed25519",
		signingKeyVersion: "v1",
		...overrides,
	};
}

function blotatoResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

function blotatoTransport(): { bodies: string[]; calls: string[]; fetchFn: typeof fetch } {
	const calls: string[] = [];
	const bodies: string[] = [];
	const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		calls.push(url);
		if (init?.body) bodies.push(String(init.body));
		if (url.endsWith("/accounts")) {
			return blotatoResponse({
				items: [
					{
						fullname: "Selena LinkedIn Page",
						id: BLOTATO_ACCOUNT_ID,
						platform: "linkedin",
						username: "selena",
					},
				],
			});
		}
		if (url.endsWith("/subaccounts")) return blotatoResponse({ items: [{ id: "page-1", name: "Selena" }] });
		if (url.endsWith("/posts")) return blotatoResponse({ postSubmissionId: "sub-1", scheduledTime: NOT_BEFORE });
		if (url.includes("/analytics")) return blotatoResponse({ lastError: null, metrics: { impressions: "12" } });
		if (url.endsWith("/sub-1")) return blotatoResponse({ status: "scheduled", scheduledTime: NOT_BEFORE });
		throw new Error(`Unexpected Blotato request: ${url}`);
	});
	return { bodies, calls, fetchFn: fetchFn as unknown as typeof fetch };
}

function blotatoProvider(fetchFn: typeof fetch) {
	return createBlotatoReleaseProvider(
		{ allowedAccountId: BLOTATO_ACCOUNT_ID, allowedPageId: "page-1", apiKey: "test-key", apiUrl: BLOTATO_TEST_API_URL },
		fetchFn,
	);
}

describe("publish policy", () => {
	it("refuses publishing outside production whatever the flag says", () => {
		for (const environment of ["STAGING", "DRY_RUN"]) {
			expect(resolvePublishDecision(environment, PUBLISHING_ENV)).toEqual({
				allowed: false,
				refusal: "ENVIRONMENT_DOES_NOT_PUBLISH",
			});
		}
	});

	it("refuses an environment it does not recognize", () => {
		expect(resolvePublishDecision("PROD", PUBLISHING_ENV)).toEqual({ allowed: false, refusal: "UNKNOWN_ENVIRONMENT" });
	});

	it.each(["", "false", "TRUE", "1", "yes", " true "])("refuses production when the flag reads %o", (value) => {
		expect(resolvePublishDecision("PRODUCTION", { [PUBLISH_FLAG]: value })).toEqual({
			allowed: false,
			refusal: "PUBLISH_FLAG_NOT_SET",
		});
	});

	it("refuses production when the flag is absent entirely", () => {
		expect(resolvePublishDecision("PRODUCTION", {})).toEqual({ allowed: false, refusal: "PUBLISH_FLAG_NOT_SET" });
	});

	it("allows only production with the exact flag value", () => {
		expect(resolvePublishDecision("PRODUCTION", PUBLISHING_ENV)).toEqual({ allowed: true });
		expect(() => assertPublishAllowed("PRODUCTION", PUBLISHING_ENV)).not.toThrow();
	});

	it("raises a refusal rather than returning one", () => {
		expect(() => assertPublishAllowed("STAGING", PUBLISHING_ENV)).toThrow(PublishRefusedError);
	});
});

describe("disarmed transport", () => {
	it("refuses every call", () => {
		expect(() => disarmedFetch()("https://blotato.test.invalid/v2/posts")).toThrow(PublishRefusedError);
	});

	it("is what a Blotato provider gets when no transport is supplied", async () => {
		const provider = createBlotatoReleaseProvider({ allowedAccountId: BLOTATO_ACCOUNT_ID, apiKey: "test-key" });
		const prepared = provider.prepareManifest({ authorization: authorization(), now: NOW, release: release() });
		await expect(provider.dispatch(prepared)).rejects.toThrow(PublishRefusedError);
	});

	it("does not let a refusal masquerade as an ambiguous provider outcome", async () => {
		const provider = blotatoProvider(disarmedFetch());
		const prepared = provider.prepareManifest({ authorization: authorization(), now: NOW, release: release() });
		// An AMBIGUOUS outcome would put a "we may have published" row in the
		// attempt log for a request that never left the process.
		await expect(provider.dispatch(prepared)).rejects.toThrow(PublishRefusedError);
	});
});

describe("guarded provider", () => {
	it("refuses to shape or dispatch a release in a non-publishing environment", async () => {
		const fake = createFakeReleaseProvider();
		const guarded = guardPublishing(fake, { env: PUBLISHING_ENV, environment: "STAGING" });
		expect(() =>
			guarded.prepareManifest({
				authorization: authorization({ environment: "STAGING", providerId: fake.providerId }),
				now: NOW,
				release: release(),
			}),
		).toThrow(PublishRefusedError);
		expect(fake.dispatched).toHaveLength(0);
	});

	it("still allows reads, because a blocked runtime must remain able to look", async () => {
		const fake = createFakeReleaseProvider();
		const guarded = guardPublishing(fake, { env: {}, environment: "DRY_RUN" });
		await expect(guarded.validateConnection()).resolves.toBeDefined();
		await expect(guarded.listAccounts()).resolves.toHaveLength(1);
		expect(guarded.capabilities().providerId).toBe(fake.providerId);
		expect(fake.dispatched).toHaveLength(0);
	});

	it("passes dispatch through once production and the flag agree", async () => {
		const fake = createFakeReleaseProvider();
		const guarded = guardPublishing(fake, { env: PUBLISHING_ENV, environment: "PRODUCTION" });
		const prepared = guarded.prepareManifest({
			authorization: authorization({ providerId: fake.providerId }),
			now: NOW,
			release: release(),
		});
		await expect(guarded.dispatch(prepared)).resolves.toMatchObject({ outcome: "ACCEPTED" });
		expect(fake.dispatched).toHaveLength(1);
	});
});

describe("staging acceptance: repeated queueing never reaches a provider", () => {
	it("dispatches nothing after ten identical attempts", async () => {
		const fake = createFakeReleaseProvider();
		const { calls, fetchFn } = blotatoTransport();
		const registry = createReleaseProviderRegistry([
			guardPublishing(fake, { env: PUBLISHING_ENV, environment: "STAGING" }),
			guardPublishing(blotatoProvider(fetchFn), { env: PUBLISHING_ENV, environment: "STAGING" }),
		]);
		const refusals: string[] = [];
		for (let attempt = 0; attempt < 10; attempt += 1) {
			const provider = registry.resolve(BLOTATO_PROVIDER_ID);
			try {
				const prepared = provider.prepareManifest({
					authorization: authorization({ environment: "STAGING" }),
					now: NOW,
					release: release(),
				});
				await provider.dispatch(prepared);
			} catch (error) {
				refusals.push(error instanceof PublishRefusedError ? error.refusal : "UNEXPECTED");
			}
		}
		expect(refusals).toHaveLength(10);
		expect(new Set(refusals)).toEqual(new Set(["ENVIRONMENT_DOES_NOT_PUBLISH"]));
		expect(fake.dispatched).toHaveLength(0);
		expect(calls).toHaveLength(0);
	});
});

describe("blotato adapter", () => {
	it("reports the connection only for the configured account and page", async () => {
		const { calls, fetchFn } = blotatoTransport();
		await expect(blotatoProvider(fetchFn).validateConnection()).resolves.toMatchObject({
			account: { externalAccountId: BLOTATO_ACCOUNT_ID, platform: "linkedin_page" },
			state: "CONNECTED",
		});
		expect(calls).toEqual([
			`${BLOTATO_TEST_API_URL}/users/me/accounts`,
			`${BLOTATO_TEST_API_URL}/users/me/accounts/${BLOTATO_ACCOUNT_ID}/subaccounts`,
		]);
	});

	it("treats a page the account does not hold as misconfiguration, not as connected", async () => {
		const { fetchFn } = blotatoTransport();
		const provider = createBlotatoReleaseProvider(
			{ allowedAccountId: BLOTATO_ACCOUNT_ID, allowedPageId: "page-absent", apiKey: "k", apiUrl: BLOTATO_TEST_API_URL },
			fetchFn,
		);
		await expect(provider.validateConnection()).resolves.toMatchObject({ state: "MISCONFIGURED" });
	});

	it("refuses to post to an account other than the configured one", async () => {
		const { fetchFn } = blotatoTransport();
		const client = createBlotatoAdapter(
			{ allowedAccountId: BLOTATO_ACCOUNT_ID, apiKey: "k", apiUrl: BLOTATO_TEST_API_URL },
			fetchFn,
		);
		await expect(
			client.createPost({
				accountId: "someone-elses-account",
				mediaUrls: [],
				platform: "linkedin",
				scheduledTime: NOT_BEFORE,
				text: "hello",
			}),
		).rejects.toThrow("configured account");
	});

	it("refuses an API URL that is not HTTPS", () => {
		expect(() =>
			createBlotatoAdapter(
				{ allowedAccountId: BLOTATO_ACCOUNT_ID, apiKey: "k", apiUrl: "http://blotato.test.invalid/v2" },
				disarmedFetch(),
			),
		).toThrow("HTTPS");
	});

	it("shapes a release into the Blotato request without leaking its shape outward", () => {
		const { fetchFn } = blotatoTransport();
		const prepared = blotatoProvider(fetchFn).prepareManifest({
			authorization: authorization(),
			now: NOW,
			release: release(),
		});
		expect(prepared).toMatchObject({ providerId: BLOTATO_PROVIDER_ID, notBefore: NOT_BEFORE });
		expect(prepared.payload).toMatchObject({
			accountId: BLOTATO_ACCOUNT_ID,
			mediaUrls: ["https://storage.test.invalid/asset-1.png"],
			pageId: "page-1",
			platform: "linkedin",
			text: "A reviewed release body\n\nhttps://selena.test.invalid/offer",
		});
	});

	it("refuses media the provider does not accept", () => {
		const { fetchFn } = blotatoTransport();
		expect(() =>
			blotatoProvider(fetchFn).prepareManifest({
				authorization: authorization(),
				now: NOW,
				release: release({
					assets: [{ assetId: "a", mimeType: "video/mp4", sha256: "d".repeat(64), sourceUrl: "https://x.test/a.mp4" }],
				}),
			}),
		).toThrow("approved image media");
	});

	it("refuses media that is not reachable over HTTPS", () => {
		const { fetchFn } = blotatoTransport();
		expect(() =>
			blotatoProvider(fetchFn).prepareManifest({
				authorization: authorization(),
				now: NOW,
				release: release({
					assets: [{ assetId: "a", mimeType: "image/png", sha256: "d".repeat(64), sourceUrl: "http://x.test/a.png" }],
				}),
			}),
		).toThrow("HTTPS");
	});

	it("accepts a dispatch and returns the submission id as the provider reference", async () => {
		const { bodies, fetchFn } = blotatoTransport();
		const provider = blotatoProvider(fetchFn);
		const prepared = provider.prepareManifest({ authorization: authorization(), now: NOW, release: release() });
		await expect(provider.dispatch(prepared)).resolves.toEqual({ outcome: "ACCEPTED", providerReferenceId: "sub-1" });
		expect(JSON.parse(bodies[0] ?? "")).toEqual({
			post: {
				accountId: BLOTATO_ACCOUNT_ID,
				content: {
					mediaUrls: ["https://storage.test.invalid/asset-1.png"],
					platform: "linkedin",
					text: "A reviewed release body\n\nhttps://selena.test.invalid/offer",
				},
				target: { pageId: "page-1", targetType: "linkedin" },
			},
			scheduledTime: NOT_BEFORE,
		});
	});

	it("calls a provider rejection definitive and a transport failure ambiguous", async () => {
		const provider = blotatoProvider(
			vi.fn(async (input: RequestInfo | URL) =>
				String(input).endsWith("/posts") ? blotatoResponse({ message: "bad" }, 422) : blotatoResponse([]),
			) as unknown as typeof fetch,
		);
		const prepared = provider.prepareManifest({ authorization: authorization(), now: NOW, release: release() });
		await expect(provider.dispatch(prepared)).resolves.toMatchObject({ outcome: "DEFINITIVE_FAILURE" });

		const unreachable = blotatoProvider(
			vi.fn(async () => {
				throw new Error("network down");
			}) as unknown as typeof fetch,
		);
		await expect(unreachable.dispatch(prepared)).resolves.toMatchObject({ outcome: "AMBIGUOUS" });
	});

	it("treats a rate-limited create as ambiguous, because the post may still land", async () => {
		const provider = blotatoProvider(
			vi.fn(async (input: RequestInfo | URL) =>
				String(input).endsWith("/posts") ? blotatoResponse({}, 429) : blotatoResponse([]),
			) as unknown as typeof fetch,
		);
		const prepared = provider.prepareManifest({ authorization: authorization(), now: NOW, release: release() });
		await expect(provider.dispatch(prepared)).resolves.toMatchObject({ outcome: "AMBIGUOUS" });
	});

	it("marks metrics partial while the workspace has not synced the post", async () => {
		const provider = blotatoProvider(
			vi.fn(async () => blotatoResponse({ lastError: "not synced", metrics: null })) as unknown as typeof fetch,
		);
		await expect(
			provider.ingestMetrics({
				capturedAt: "2030-01-03T00:00:00.000Z",
				providerReferenceId: "sub-1",
				publicationAttemptId: "55555555-5555-5555-5555-555555555555",
				window: { end: "2030-01-03T00:00:00.000Z", start: "2030-01-02T00:00:00.000Z" },
			}),
		).resolves.toMatchObject({ providerId: BLOTATO_PROVIDER_ID, quality: "PARTIAL" });
	});

	it("reads a scheduled submission back as scheduled", async () => {
		const { fetchFn } = blotatoTransport();
		await expect(
			blotatoProvider(fetchFn).getStatus({
				providerReferenceId: "sub-1",
				window: { end: "2030-01-03T00:00:00.000Z", start: "2030-01-02T00:00:00.000Z" },
			}),
		).resolves.toEqual({ providerReferenceId: "sub-1", state: "SCHEDULED" });
	});

	it("registers alongside Postiz without either replacing the other", () => {
		const { fetchFn } = blotatoTransport();
		const registry = createReleaseProviderRegistry([createFakeReleaseProvider(), blotatoProvider(fetchFn)]);
		expect(registry.providers()).toContain(BLOTATO_PROVIDER_ID);
		expect(registry.resolve(BLOTATO_PROVIDER_ID).providerId).toBe(BLOTATO_PROVIDER_ID);
	});
});

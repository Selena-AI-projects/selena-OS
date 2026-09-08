import { describe, expect, it, vi } from "vitest";
import { SELENA_PUBLICATION_PACKAGE_VERSION } from "./selena-release-gateway";
import {
	assertReleaseDispatchInvariants,
	createReleaseProviderRegistry,
	type NormalizedRelease,
	type ReleaseDispatchAuthorization,
	ReleaseDispatchInvariantError,
	type ReleaseProviderAdapter,
	toNormalizedRelease,
} from "./selena-release-provider";
import { createBlotatoReleaseProvider } from "./selena-release-provider-blotato";
import { createFakeReleaseProvider } from "./selena-release-provider-fake";
import { createPostizReleaseProvider } from "./selena-release-provider-postiz";

// Every provider request in this file must resolve against an unreachable host,
// so a stub that ever stops matching fails loudly instead of reaching a provider.
const POSTIZ_TEST_API_URL = "https://postiz.test.invalid/public/v1";
const POSTIZ_INTEGRATION_ID = "linkedin-page-only";
const BLOTATO_TEST_API_URL = "https://blotato.test.invalid/v2";
const BLOTATO_ACCOUNT_ID = "blotato-linkedin-page";
const NOW = new Date("2030-01-01T00:00:00.000Z");
const NOT_BEFORE = "2030-01-02T12:00:00.000Z";
const CONTENT_HASH = "a".repeat(64);
const MANIFEST_HASH = "b".repeat(64);
const ANALYTICS = [{ data: [{ date: "2030-01-01", total: 12 }], label: "Impressions", percentageChange: 3 }];

type Scenario = "healthy" | "provider-rejects" | "provider-unreachable" | "unknown-reference";

type Subject = {
	create(scenario: Scenario): ReleaseProviderAdapter;
	externalAccountId: string;
	name: string;
	referenceId: string;
};

function releaseFor(externalAccountId: string, overrides: Partial<NormalizedRelease> = {}): NormalizedRelease {
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
			externalAccountId,
			platform: "linkedin_page",
		},
		notBefore: NOT_BEFORE,
		organizationId: "default",
		releaseIntentId: "33333333-3333-3333-3333-333333333333",
		timezone: "UTC",
		...overrides,
	};
}

function authorization(
	providerId: string,
	overrides: Partial<ReleaseDispatchAuthorization> = {},
): ReleaseDispatchAuthorization {
	return {
		auditEventId: "44444444-4444-4444-4444-444444444444",
		contentHash: CONTENT_HASH,
		environment: "STAGING",
		expiresAt: "2030-01-01T01:00:00.000Z",
		idempotencyKey: "release-idempotency-key",
		killSwitchActive: false,
		manifestHash: MANIFEST_HASH,
		providerId,
		signature: "signed-manifest",
		signatureAlgorithm: "Ed25519",
		signingKeyVersion: "v1",
		...overrides,
	};
}

function createPostizTransport(scenario: Scenario): ReturnType<typeof vi.fn<typeof fetch>> {
	return vi.fn<typeof fetch>(async (input, init) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		if (!url.startsWith(POSTIZ_TEST_API_URL)) throw new Error(`Postiz adapter escaped the test transport: ${url}`);
		if (url.endsWith("/integrations")) {
			return new Response(
				JSON.stringify([
					{
						id: POSTIZ_INTEGRATION_ID,
						identifier: "linkedin-page",
						name: "Selena LinkedIn Page",
						organizationId: "selena-systems",
						status: "ACTIVE",
					},
				]),
				{ status: 200 },
			);
		}
		if (method === "POST" && url.endsWith("/posts")) {
			if (scenario === "provider-rejects") return new Response("rejected", { status: 400 });
			if (scenario === "provider-unreachable") return new Response("unavailable", { status: 503 });
			return new Response(JSON.stringify([{ integration: POSTIZ_INTEGRATION_ID, postId: "postiz-post-1" }]), {
				status: 200,
			});
		}
		if (method === "GET" && url.includes("/posts?")) {
			const posts = scenario === "unknown-reference" ? [] : [{ id: "postiz-post-1" }];
			return new Response(JSON.stringify(posts), { status: 200 });
		}
		if (url.includes("/analytics/post/")) return new Response(JSON.stringify(ANALYTICS), { status: 200 });
		throw new Error(`Unexpected Postiz request: ${method} ${url}`);
	});
}

function createBlotatoTransport(scenario: Scenario): ReturnType<typeof vi.fn<typeof fetch>> {
	return vi.fn<typeof fetch>(async (input, init) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		if (!url.startsWith(BLOTATO_TEST_API_URL)) throw new Error(`Blotato adapter escaped the test transport: ${url}`);
		if (url.endsWith("/accounts")) {
			return new Response(
				JSON.stringify([
					{
						displayName: "Selena LinkedIn Page",
						id: BLOTATO_ACCOUNT_ID,
						platform: "linkedin",
						status: "active",
						subaccounts: [],
					},
				]),
				{ status: 200 },
			);
		}
		if (method === "POST" && url.endsWith("/posts")) {
			if (scenario === "provider-rejects") return new Response("rejected", { status: 400 });
			if (scenario === "provider-unreachable") return new Response("unavailable", { status: 503 });
			return new Response(JSON.stringify({ postSubmissionId: "blotato-post-1", scheduledTime: NOT_BEFORE }), {
				status: 200,
			});
		}
		if (method === "GET" && url.includes("/posts/submissions/")) {
			if (scenario === "unknown-reference") return new Response("no such submission", { status: 404 });
			return new Response(JSON.stringify({ scheduledTime: NOT_BEFORE, status: "scheduled" }), { status: 200 });
		}
		if (method === "GET" && url.endsWith("/analytics")) {
			return new Response(JSON.stringify({ lastError: null, metrics: { impressions: "12" } }), { status: 200 });
		}
		throw new Error(`Unexpected Blotato request: ${method} ${url}`);
	});
}

const subjects: Subject[] = [
	{
		name: "in-memory",
		externalAccountId: "in-memory-account",
		referenceId: "in-memory-post-1",
		create(scenario) {
			return createFakeReleaseProvider({
				dispatchOutcome:
					scenario === "provider-rejects"
						? { outcome: "DEFINITIVE_FAILURE", reason: "provider rejected the release" }
						: scenario === "provider-unreachable"
							? { outcome: "AMBIGUOUS", reason: "provider did not answer" }
							: { outcome: "ACCEPTED", providerReferenceId: "in-memory-post-1" },
				knownReferences: scenario === "unknown-reference" ? [] : ["in-memory-post-1"],
			});
		},
	},
	{
		name: "postiz",
		externalAccountId: POSTIZ_INTEGRATION_ID,
		referenceId: "postiz-post-1",
		create(scenario) {
			return createPostizReleaseProvider(
				{
					allowedIntegrationId: POSTIZ_INTEGRATION_ID,
					apiUrl: POSTIZ_TEST_API_URL,
					expectedOrganizationId: "selena-systems",
					token: "postiz-test-token",
				},
				createPostizTransport(scenario),
			);
		},
	},
	{
		name: "blotato",
		externalAccountId: BLOTATO_ACCOUNT_ID,
		referenceId: "blotato-post-1",
		create(scenario) {
			return createBlotatoReleaseProvider(
				{ allowedAccountId: BLOTATO_ACCOUNT_ID, apiKey: "blotato-test-key", apiUrl: BLOTATO_TEST_API_URL },
				createBlotatoTransport(scenario),
			);
		},
	},
];

describe.each(subjects)("release provider contract: $name", (subject) => {
	const adapter = () => subject.create("healthy");
	const release = () => releaseFor(subject.externalAccountId);
	const prepare = (provider: ReleaseProviderAdapter, overrides: Partial<ReleaseDispatchAuthorization> = {}) =>
		provider.prepareManifest({
			authorization: authorization(provider.providerId, overrides),
			now: NOW,
			release: release(),
		});

	it("declares the platforms it can serve under its own provider ID", () => {
		const provider = adapter();
		const capabilities = provider.capabilities();
		expect(capabilities.providerId).toBe(provider.providerId);
		expect(capabilities.platforms).toContain("linkedin_page");
	});

	it("prepares a release bound to the authorized manifest, account and idempotency key", () => {
		const provider = adapter();
		const prepared = prepare(provider);
		expect(prepared).toMatchObject({
			environment: "STAGING",
			externalAccountId: subject.externalAccountId,
			idempotencyKey: "release-idempotency-key",
			manifestHash: MANIFEST_HASH,
			notBefore: NOT_BEFORE,
			providerId: provider.providerId,
		});
		expect(prepared.payloadHash).toMatch(/^[a-f0-9]{64}$/);
		expect(prepare(provider).payloadHash).toBe(prepared.payloadHash);
	});

	it.each([
		["IDEMPOTENCY_KEY_MISSING", { idempotencyKey: "  " }],
		["AUDIT_TRAIL_MISSING", { auditEventId: "" }],
		["KILL_SWITCH_ACTIVE", { killSwitchActive: true }],
		["CONTENT_HASH_MISMATCH", { contentHash: "d".repeat(64) }],
		["MANIFEST_SIGNATURE_INVALID", { signature: "" }],
		["MANIFEST_SIGNATURE_INVALID", { signatureAlgorithm: "RS256" }],
		["MANIFEST_SIGNATURE_INVALID", { signingKeyVersion: " " }],
		["MANIFEST_EXPIRED", { expiresAt: "2029-12-31T23:00:00.000Z" }],
		["ENVIRONMENT_INVALID", { environment: "SANDBOX" as never }],
	] satisfies Array<[string, Partial<ReleaseDispatchAuthorization>]>)(
		"refuses to prepare a release when %s",
		(invariant, overrides) => {
			const provider = adapter();
			expect(() => prepare(provider, overrides)).toThrow(
				expect.objectContaining({ invariant, name: "ReleaseDispatchInvariantError" }),
			);
		},
	);

	it("refuses a provider binding that names a different provider", () => {
		const provider = adapter();
		expect(() =>
			provider.prepareManifest({
				authorization: authorization("some-other-provider"),
				now: NOW,
				release: release(),
			}),
		).toThrow(expect.objectContaining({ invariant: "PROVIDER_NOT_BOUND" }));
	});

	it("refuses a schedule that has already passed", () => {
		const provider = adapter();
		expect(() =>
			provider.prepareManifest({
				authorization: authorization(provider.providerId),
				now: NOW,
				release: releaseFor(subject.externalAccountId, { notBefore: "2029-06-01T00:00:00.000Z" }),
			}),
		).toThrow(expect.objectContaining({ invariant: "SCHEDULE_NOT_IN_FUTURE" }));
	});

	it("refuses a platform it does not serve", () => {
		const provider = adapter();
		const release = releaseFor(subject.externalAccountId);
		expect(() =>
			provider.prepareManifest({
				authorization: authorization(provider.providerId),
				now: NOW,
				release: { ...release, destination: { ...release.destination, platform: "x_timeline" } },
			}),
		).toThrow(expect.objectContaining({ invariant: "PLATFORM_UNSUPPORTED" }));
	});

	it("validates its connection and lists accounts in the normalized shape", async () => {
		const provider = adapter();
		await expect(provider.validateConnection()).resolves.toMatchObject({
			account: { externalAccountId: subject.externalAccountId, platform: "linkedin_page", status: "ACTIVE" },
			state: "CONNECTED",
		});
		const accounts = await provider.listAccounts();
		expect(accounts).toEqual([
			expect.objectContaining({ externalAccountId: subject.externalAccountId, platform: "linkedin_page" }),
		]);
	});

	it("returns the provider reference for an accepted dispatch", async () => {
		const provider = adapter();
		await expect(provider.dispatch(prepare(provider))).resolves.toEqual({
			outcome: "ACCEPTED",
			providerReferenceId: subject.referenceId,
		});
	});

	it("maps a provider rejection to a definitive failure", async () => {
		const provider = subject.create("provider-rejects");
		await expect(provider.dispatch(prepare(provider))).resolves.toMatchObject({ outcome: "DEFINITIVE_FAILURE" });
	});

	it("maps an unreachable provider to an ambiguous outcome", async () => {
		const provider = subject.create("provider-unreachable");
		await expect(provider.dispatch(prepare(provider))).resolves.toMatchObject({ outcome: "AMBIGUOUS" });
	});

	it("reports a scheduled release and an unknown reference", async () => {
		const window = { end: "2030-01-03T00:00:00.000Z", start: "2030-01-01T00:00:00.000Z" };
		const scheduled = subject.create("healthy");
		await scheduled.dispatch(prepare(scheduled));
		await expect(scheduled.getStatus({ providerReferenceId: subject.referenceId, window })).resolves.toMatchObject({
			state: "SCHEDULED",
		});
		const unknown = subject.create("unknown-reference");
		await expect(unknown.getStatus({ providerReferenceId: subject.referenceId, window })).resolves.toMatchObject({
			state: "NOT_FOUND",
		});
	});

	it("returns provider-attributed metrics for one publication attempt", async () => {
		const provider = adapter();
		const reading = await provider.ingestMetrics({
			capturedAt: "2030-01-03T01:00:00.000Z",
			providerReferenceId: subject.referenceId,
			publicationAttemptId: "55555555-5555-5555-5555-555555555555",
			window: { end: "2030-01-03T00:00:00.000Z", start: "2030-01-01T00:00:00.000Z" },
		});
		expect(reading.values.provider).toBe(provider.providerId);
		expect(reading.providerId).toBe(provider.providerId);
		expect(reading.requestKey).toMatch(/^[a-f0-9]{64}$/);
		expect(reading.payloadSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(reading).toMatchObject({
			quality: "COMPLETE",
			windowEndedAt: "2030-01-03T00:00:00.000Z",
			windowStartedAt: "2030-01-01T00:00:00.000Z",
		});
	});
});

describe("release provider registry", () => {
	it("refuses to map one provider ID onto two adapters", () => {
		expect(() =>
			createReleaseProviderRegistry([
				createFakeReleaseProvider({ providerId: "duplicate" }),
				createFakeReleaseProvider({ providerId: "duplicate" }),
			]),
		).toThrow("only one adapter");
	});

	it("resolves the bound provider and refuses an unbound one", () => {
		const registry = createReleaseProviderRegistry([
			createFakeReleaseProvider(),
			createPostizReleaseProvider({ allowedIntegrationId: POSTIZ_INTEGRATION_ID, token: "unused" }, vi.fn()),
		]);
		expect(registry.providers()).toEqual(["in-memory", "postiz"]);
		expect(registry.resolve("postiz").providerId).toBe("postiz");
		expect(() => registry.resolve("nowhere")).toThrow(ReleaseDispatchInvariantError);
	});
});

describe("normalized release model", () => {
	const publicationPackage = {
		approval: { approvalId: "66666666-6666-6666-6666-666666666666" },
		assets: [{ assetId: "asset-1", mimeType: "image/png", sha256: "c".repeat(64), storageKey: "private/asset-1" }],
		brandId: "selena",
		content: {
			body: "A reviewed release body",
			contentHash: CONTENT_HASH,
			contentVersionId: "11111111-1111-1111-1111-111111111111",
			ctaUrl: "https://selena.test.invalid/offer",
			policyVersion: "selena-v1",
		},
		destination: {
			accountRef: "Selena LinkedIn Page",
			channelAccountId: "22222222-2222-2222-2222-222222222222",
			integrationId: POSTIZ_INTEGRATION_ID,
			platform: "linkedin_page",
		},
		organizationId: "default",
		releaseIntentId: "33333333-3333-3333-3333-333333333333",
		schedule: { notBefore: NOT_BEFORE, timezone: "UTC" },
		schemaVersion: SELENA_PUBLICATION_PACKAGE_VERSION,
	};

	it("projects a signed publication package onto provider-neutral fields", () => {
		const normalized = toNormalizedRelease(publicationPackage, {
			"asset-1": "https://storage.test.invalid/asset-1.png",
		});
		expect(normalized).toMatchObject({
			contentHash: CONTENT_HASH,
			destination: { externalAccountId: POSTIZ_INTEGRATION_ID, platform: "linkedin_page" },
			notBefore: NOT_BEFORE,
		});
		expect(normalized.assets).toEqual([
			expect.objectContaining({ assetId: "asset-1", sourceUrl: "https://storage.test.invalid/asset-1.png" }),
		]);
	});

	it("refuses an asset whose private-storage URL was never resolved", () => {
		expect(() => toNormalizedRelease(publicationPackage)).toThrow("no resolved source URL");
	});

	it("refuses anything that is not an immutable publication package", () => {
		expect(() => toNormalizedRelease({ ...publicationPackage, schemaVersion: "other/v1" })).toThrow(
			"Publication package version is invalid",
		);
	});
});

describe("dispatch invariants", () => {
	it("accepts an authorization that carries every mandatory binding", () => {
		expect(() =>
			assertReleaseDispatchInvariants({
				authorization: authorization("in-memory"),
				now: NOW,
				providerId: "in-memory",
				release: releaseFor("in-memory-account"),
			}),
		).not.toThrow();
	});
});

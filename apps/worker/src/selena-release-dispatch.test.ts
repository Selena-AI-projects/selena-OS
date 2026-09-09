import { SELENA_PUBLICATION_PACKAGE_VERSION } from "@workspace/lib/selena-release-gateway";
import { configureReleaseProviders } from "@workspace/lib/selena-release-providers";
import { describe, expect, it, vi } from "vitest";
import { dispatchReleaseManifest, type GatewayQuery } from "./selena-release-dispatch";

const ACCOUNT_ID = "blotato-linkedin-page";
const MANIFEST_ID = "77777777-7777-7777-7777-777777777777";
const RESERVATION_ID = "88888888-8888-8888-8888-888888888888";
const NOW = new Date("2030-01-01T00:00:00.000Z");
const CONFIGURED = { BLOTATO_ALLOWED_ACCOUNT_ID: ACCOUNT_ID, BLOTATO_API_KEY: "test-key" };

function publicationPackage() {
	return {
		approval: { approvalId: "66666666-6666-6666-6666-666666666666" },
		assets: [],
		brandId: "selena",
		content: {
			body: "A reviewed release body",
			contentHash: "a".repeat(64),
			contentVersionId: "11111111-1111-1111-1111-111111111111",
			ctaUrl: "https://selena.test.invalid/offer",
			policyVersion: "selena-v1",
		},
		destination: {
			accountRef: "Selena LinkedIn Page",
			channelAccountId: "22222222-2222-2222-2222-222222222222",
			integrationId: ACCOUNT_ID,
			platform: "linkedin_page",
		},
		organizationId: "default",
		releaseIntentId: "33333333-3333-3333-3333-333333333333",
		schedule: { notBefore: "2030-01-02T12:00:00.000Z", timezone: "UTC" },
		schemaVersion: SELENA_PUBLICATION_PACKAGE_VERSION,
	};
}

/**
 * Stands in for the Gateway's database boundary. It answers the three
 * functions the dispatch uses and records the order they were called in, so a
 * test can tell whether the provider was reached before or after a commit.
 */
function gateway(options: { shouldSubmit?: boolean } = {}) {
	const calls: string[] = [];
	const query: GatewayQuery = async <Row>(sql: string) => {
		if (sql.includes("prepare_postiz_submission")) {
			calls.push("prepare");
			return [
				{
					integration_id: ACCOUNT_ID,
					manifest_hash: "b".repeat(64),
					publication_package: publicationPackage(),
					release_intent_id: "33333333-3333-3333-3333-333333333333",
					reservation_id: RESERVATION_ID,
					should_submit: options.shouldSubmit ?? true,
				},
			] as Row[];
		}
		if (sql.includes("authorize_provider_dispatch")) {
			calls.push("authorize");
			return [
				{
					audit_event_id: "44444444-4444-4444-4444-444444444444",
					content_hash: "a".repeat(64),
					expires_at: new Date("2030-01-01T01:00:00.000Z"),
					manifest_hash: "b".repeat(64),
					provider: "blotato",
					signature: "signed-manifest",
					signature_algorithm: "Ed25519",
					signing_key_version: "v1",
				},
			] as Row[];
		}
		if (sql.includes("record_postiz_submission_outcome")) {
			calls.push("record");
			return [] as Row[];
		}
		throw new Error(`Unexpected gateway query: ${sql}`);
	};
	const recorded: unknown[][] = [];
	const inGatewayContext = async <Result>(task: (query: GatewayQuery) => Promise<Result>) => {
		const result = await task(async <Row>(sql: string, parameters: unknown[]) => {
			if (sql.includes("record_postiz_submission_outcome")) recorded.push(parameters);
			return query<Row>(sql, parameters);
		});
		calls.push("commit");
		return result;
	};
	return { calls, inGatewayContext, recorded };
}

function transport(scenario: "healthy" | "rejects" = "healthy") {
	const posts: string[] = [];
	const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.endsWith("/accounts")) {
			return new Response(
				JSON.stringify({ items: [{ fullname: "Page", id: ACCOUNT_ID, platform: "linkedin" }] }),
				{ status: 200 },
			);
		}
		if (url.endsWith("/posts")) {
			posts.push(url);
			if (scenario === "rejects") return new Response("rejected", { status: 400 });
			return new Response(JSON.stringify({ postSubmissionId: "blotato-post-1" }), { status: 200 });
		}
		throw new Error(`Unexpected request: ${url}`);
	});
	return { fetchFn: fetchFn as unknown as typeof fetch, posts };
}

const production = (fetchFn: typeof fetch) =>
	configureReleaseProviders(
		{ ...CONFIGURED, SELENA_GROWTH_SOURCE_ENVIRONMENT: "production", SELENA_RELEASE_PUBLISH_ENABLED: "true" },
		fetchFn,
	);

describe("dispatchReleaseManifest", () => {
	it("says what is missing instead of reserving a dispatch it cannot send", async () => {
		const boundary = gateway();
		await expect(
			dispatchReleaseManifest({
				configuration: configureReleaseProviders({}, transport().fetchFn),
				idempotencyKey: "release-idempotency-key",
				inGatewayContext: boundary.inGatewayContext,
				manifestId: MANIFEST_ID,
			}),
		).resolves.toMatchObject({ outcome: "NOT_CONFIGURED" });
		expect(boundary.calls).toEqual([]);
	});

	it("does not reach the provider for a reservation that was already made", async () => {
		const boundary = gateway({ shouldSubmit: false });
		const { fetchFn, posts } = transport();
		await expect(
			dispatchReleaseManifest({
				configuration: production(fetchFn),
				idempotencyKey: "release-idempotency-key",
				inGatewayContext: boundary.inGatewayContext,
				manifestId: MANIFEST_ID,
				now: NOW,
			}),
		).resolves.toEqual({ outcome: "SKIPPED", reservationId: RESERVATION_ID });
		expect(boundary.calls).toEqual(["prepare", "commit"]);
		expect(posts).toHaveLength(0);
	});

	it("commits the reservation before the provider is reached and records what it answered", async () => {
		const boundary = gateway();
		const { fetchFn, posts } = transport();
		await expect(
			dispatchReleaseManifest({
				configuration: production(fetchFn),
				idempotencyKey: "release-idempotency-key",
				inGatewayContext: boundary.inGatewayContext,
				manifestId: MANIFEST_ID,
				now: NOW,
			}),
		).resolves.toEqual({
			outcome: "ACCEPTED",
			providerReferenceId: "blotato-post-1",
			reservationId: RESERVATION_ID,
		});
		expect(boundary.calls).toEqual(["prepare", "authorize", "commit", "record", "commit"]);
		expect(posts).toHaveLength(1);
		expect(boundary.recorded).toEqual([[RESERVATION_ID, "ACCEPTED", "blotato-post-1", null]]);
	});

	it("records a rejection as a definitive failure", async () => {
		const boundary = gateway();
		const { fetchFn } = transport("rejects");
		await expect(
			dispatchReleaseManifest({
				configuration: production(fetchFn),
				idempotencyKey: "release-idempotency-key",
				inGatewayContext: boundary.inGatewayContext,
				manifestId: MANIFEST_ID,
				now: NOW,
			}),
		).resolves.toMatchObject({ outcome: "DEFINITIVE_FAILURE" });
		expect(boundary.recorded[0]?.[1]).toBe("DEFINITIVE_FAILURE");
	});

	it("records a refusal as an attempt that never left, on a contour that may not publish", async () => {
		const boundary = gateway();
		const { fetchFn, posts } = transport();
		const report = await dispatchReleaseManifest({
			configuration: configureReleaseProviders(
				{ ...CONFIGURED, SELENA_GROWTH_SOURCE_ENVIRONMENT: "staging", SELENA_RELEASE_PUBLISH_ENABLED: "true" },
				fetchFn,
			),
			idempotencyKey: "release-idempotency-key",
			inGatewayContext: boundary.inGatewayContext,
			manifestId: MANIFEST_ID,
			now: NOW,
		});
		expect(report).toMatchObject({ outcome: "NOT_SENT" });
		expect(posts).toHaveLength(0);
		expect(boundary.recorded[0]?.[1]).toBe("NOT_SENT");
	});
});

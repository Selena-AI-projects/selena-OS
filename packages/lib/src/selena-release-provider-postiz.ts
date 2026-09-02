import { createPostizAdapter, type PostizAdapterConfig, PostizApiError, type PostizIntegration } from "./selena-postiz";
import { createPostizPerformanceSnapshot, type PostizAnalyticsPayload } from "./selena-postiz-ingestion";
import {
	assertFutureSchedule,
	assertReleaseDispatchInvariants,
	assertSupportedPlatform,
	type NormalizedRelease,
	type PreparedRelease,
	preparedReleaseHash,
	type ReleaseConnectionState,
	type ReleaseDispatchOutcome,
	type ReleaseMetricsReading,
	type ReleaseMetricsRequest,
	type ReleaseProviderAccount,
	type ReleaseProviderAdapter,
	type ReleaseProviderCapabilities,
	type ReleaseStatus,
} from "./selena-release-provider";

export const POSTIZ_PROVIDER_ID = "postiz";

const POSTIZ_PLATFORM = "linkedin_page";
const POSTIZ_IDENTIFIER = "linkedin-page";

const CAPABILITIES: ReleaseProviderCapabilities = {
	cancellation: true,
	mediaMimeTypes: ["image/jpeg", "image/png", "image/webp"],
	metrics: true,
	platforms: [POSTIZ_PLATFORM],
	providerId: POSTIZ_PROVIDER_ID,
	scheduling: "SCHEDULE_ONLY",
};

type PostizReleasePayload = {
	content: string;
	integrationId: string;
	media: { id: string; path: string }[];
	scheduledFor: string;
};

function toAccount(integration: PostizIntegration): ReleaseProviderAccount {
	return {
		accountRef: integration.name ?? integration.id,
		displayName: integration.name,
		externalAccountId: integration.id,
		organizationRef: integration.organizationId,
		platform: integration.identifier === POSTIZ_IDENTIFIER ? POSTIZ_PLATFORM : integration.identifier,
		status: integration.status,
	};
}

function asPostizPayload(payload: unknown): PostizReleasePayload {
	const record = payload as Partial<PostizReleasePayload> | null;
	if (
		!record ||
		typeof record.content !== "string" ||
		typeof record.integrationId !== "string" ||
		typeof record.scheduledFor !== "string" ||
		!Array.isArray(record.media)
	) {
		throw new Error("Prepared release was not shaped by the Postiz adapter");
	}
	return record as PostizReleasePayload;
}

/**
 * A provider rejection is only definitive when Postiz decided; a transport
 * failure or an unrecognized response leaves the submission ambiguous, and the
 * release boundary must reconcile it instead of retrying.
 */
function classifyDispatchError(error: unknown): ReleaseDispatchOutcome {
	const retriedByProvider = error instanceof PostizApiError && (error.status === 408 || error.status === 429);
	if (error instanceof PostizApiError && !retriedByProvider && error.status >= 400 && error.status < 500) {
		return { outcome: "DEFINITIVE_FAILURE", reason: error.message };
	}
	return { outcome: "AMBIGUOUS", reason: error instanceof Error ? error.message : "Postiz dispatch failed" };
}

function findProviderPost(posts: readonly unknown[], providerReferenceId: string): boolean {
	return posts.some((entry) => {
		const record = entry as Record<string, unknown> | null;
		return record?.id === providerReferenceId || record?.postId === providerReferenceId;
	});
}

function asAnalyticsPayload(value: unknown): PostizAnalyticsPayload {
	if (!Array.isArray(value)) throw new Error("Postiz analytics response is invalid");
	return value as PostizAnalyticsPayload;
}

/**
 * Wraps the existing Postiz client so the release lifecycle sees only the
 * provider-neutral contract. Postiz-shaped request bodies exist nowhere else.
 */
export function createPostizReleaseProvider(
	config: PostizAdapterConfig,
	fetchFn: typeof fetch = fetch,
): ReleaseProviderAdapter {
	const postiz = createPostizAdapter(config, fetchFn);
	return {
		providerId: POSTIZ_PROVIDER_ID,

		capabilities() {
			return CAPABILITIES;
		},

		async validateConnection(): Promise<ReleaseConnectionState> {
			const status = await postiz.connectionStatus();
			if (status.state === "CONNECTED") return { account: toAccount(status.destination), state: "CONNECTED" };
			return status;
		},

		async listAccounts() {
			return (await postiz.listDestinations()).map(toAccount);
		},

		prepareManifest(input): PreparedRelease {
			const now = input.now ?? new Date();
			assertReleaseDispatchInvariants({ ...input, now, providerId: POSTIZ_PROVIDER_ID });
			assertSupportedPlatform(CAPABILITIES, input.release.destination.platform);
			assertFutureSchedule(input.release.notBefore, now);
			const payload = shapePostizPayload(input.release);
			return {
				environment: input.authorization.environment,
				externalAccountId: input.release.destination.externalAccountId,
				idempotencyKey: input.authorization.idempotencyKey,
				manifestHash: input.authorization.manifestHash,
				notBefore: input.release.notBefore,
				payload,
				payloadHash: preparedReleaseHash(payload),
				providerId: POSTIZ_PROVIDER_ID,
			};
		},

		async dispatch(prepared) {
			const payload = asPostizPayload(prepared.payload);
			try {
				const created = await postiz.scheduleLinkedInPagePost({
					content: payload.content,
					integrationId: payload.integrationId,
					media: payload.media,
					scheduledFor: payload.scheduledFor,
				});
				return { outcome: "ACCEPTED", providerReferenceId: created.postId };
			} catch (error) {
				return classifyDispatchError(error);
			}
		},

		async getStatus(input): Promise<ReleaseStatus> {
			try {
				const posts = await postiz.listPosts(input.window);
				return findProviderPost(posts, input.providerReferenceId)
					? { providerReferenceId: input.providerReferenceId, state: "SCHEDULED" }
					: { providerReferenceId: input.providerReferenceId, state: "NOT_FOUND" };
			} catch (error) {
				return {
					providerReferenceId: input.providerReferenceId,
					reason: error instanceof Error ? error.message : "Postiz status lookup failed",
					state: "UNKNOWN",
				};
			}
		},

		async ingestMetrics(request: ReleaseMetricsRequest): Promise<ReleaseMetricsReading> {
			const payload = asAnalyticsPayload(await postiz.getPostAnalytics(request.providerReferenceId));
			const snapshot = createPostizPerformanceSnapshot({
				capturedAt: request.capturedAt,
				payload,
				publicationAttemptId: request.publicationAttemptId,
				windowEndedAt: request.window.end,
				windowStartedAt: request.window.start,
			});
			return {
				capturedAt: snapshot.capturedAt,
				definitionVersion: snapshot.definitionVersion,
				payload: snapshot.payload,
				payloadSha256: snapshot.payloadSha256,
				providerId: POSTIZ_PROVIDER_ID,
				quality: snapshot.quality,
				requestKey: snapshot.requestKey,
				values: snapshot.values,
				windowEndedAt: snapshot.windowEndedAt,
				windowStartedAt: snapshot.windowStartedAt,
			};
		},
	};
}

function shapePostizPayload(release: NormalizedRelease): PostizReleasePayload {
	for (const asset of release.assets) {
		if (!CAPABILITIES.mediaMimeTypes.includes(asset.mimeType)) {
			throw new Error("Postiz accepts only approved image media");
		}
		if (!asset.sourceUrl.startsWith("https://")) throw new Error("Postiz media must be reachable over HTTPS");
	}
	return {
		content: release.ctaUrl ? `${release.body}\n\n${release.ctaUrl}` : release.body,
		integrationId: release.destination.externalAccountId,
		media: release.assets.map((asset) => ({ id: asset.assetId, path: asset.sourceUrl })),
		scheduledFor: release.notBefore,
	};
}

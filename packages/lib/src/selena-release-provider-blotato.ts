import {
	type BlotatoAccount,
	type BlotatoAdapter,
	type BlotatoAdapterConfig,
	BlotatoApiError,
	createBlotatoAdapter,
} from "./selena-blotato";
import { sha256 } from "./selena-control-room";
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
import { disarmedFetch, rethrowIfRefused } from "./selena-release-publish-policy";

export const BLOTATO_PROVIDER_ID = "blotato";
export const BLOTATO_ANALYTICS_DEFINITION_VERSION = "blotato.analytics/v1";

const RELEASE_PLATFORM = "linkedin_page";
const BLOTATO_PLATFORM = "linkedin";

const CAPABILITIES: ReleaseProviderCapabilities = {
	cancellation: false,
	mediaMimeTypes: ["image/jpeg", "image/png", "image/webp"],
	metrics: true,
	platforms: [RELEASE_PLATFORM],
	providerId: BLOTATO_PROVIDER_ID,
	scheduling: "SCHEDULE_ONLY",
};

type BlotatoReleasePayload = {
	accountId: string;
	mediaUrls: string[];
	pageId?: string;
	platform: string;
	scheduledTime: string;
	text: string;
};

function toAccount(account: BlotatoAccount): ReleaseProviderAccount {
	return {
		accountRef: account.displayName ?? account.username ?? account.id,
		displayName: account.displayName,
		externalAccountId: account.id,
		organizationRef: account.subaccounts[0]?.id ?? null,
		platform: account.platform === BLOTATO_PLATFORM ? RELEASE_PLATFORM : account.platform,
		status: account.status,
	};
}

function asBlotatoPayload(payload: unknown): BlotatoReleasePayload {
	const record = payload as Partial<BlotatoReleasePayload> | null;
	if (
		!record ||
		typeof record.accountId !== "string" ||
		typeof record.platform !== "string" ||
		typeof record.scheduledTime !== "string" ||
		typeof record.text !== "string" ||
		!Array.isArray(record.mediaUrls)
	) {
		throw new Error("Prepared release was not shaped by the Blotato adapter");
	}
	return record as BlotatoReleasePayload;
}

/**
 * Blotato publishes asynchronously, so a create that returns without a
 * submission id tells us nothing about whether a post exists. Only a decision
 * Blotato actually made is definitive; everything else stays ambiguous for the
 * release boundary to reconcile, because retrying an ambiguous submission is
 * how a post gets published twice.
 */
function classifyDispatchError(error: unknown): ReleaseDispatchOutcome {
	rethrowIfRefused(error);
	const retriedByProvider = error instanceof BlotatoApiError && (error.status === 408 || error.status === 429);
	if (error instanceof BlotatoApiError && !retriedByProvider && error.status >= 400 && error.status < 500) {
		return { outcome: "DEFINITIVE_FAILURE", reason: error.message };
	}
	return { outcome: "AMBIGUOUS", reason: error instanceof Error ? error.message : "Blotato dispatch failed" };
}

function shapeBlotatoPayload(release: NormalizedRelease, allowedPageId?: string): BlotatoReleasePayload {
	for (const asset of release.assets) {
		if (!CAPABILITIES.mediaMimeTypes.includes(asset.mimeType)) {
			throw new Error("Blotato accepts only approved image media");
		}
		if (!asset.sourceUrl.startsWith("https://")) throw new Error("Blotato media must be reachable over HTTPS");
	}
	return {
		accountId: release.destination.externalAccountId,
		mediaUrls: release.assets.map((asset) => asset.sourceUrl),
		platform: BLOTATO_PLATFORM,
		scheduledTime: release.notBefore,
		text: release.ctaUrl ? `${release.body}\n\n${release.ctaUrl}` : release.body,
		...(allowedPageId ? { pageId: allowedPageId } : {}),
	};
}

/**
 * Blotato reports metrics as strings with no history, so a reading is PARTIAL
 * whenever the workspace has not synced the post yet. Calling that COMPLETE
 * would let an empty window look like a measured zero.
 */
function toMetricsReading(
	request: ReleaseMetricsRequest,
	analytics: { lastError: string | null; metrics: Record<string, string> | null },
): ReleaseMetricsReading {
	const metrics = analytics.metrics ?? {};
	const values: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(metrics)) {
		const parsed = Number(value);
		values[key] = Number.isFinite(parsed) && parsed >= 0 ? parsed : value;
	}
	return {
		capturedAt: request.capturedAt,
		definitionVersion: BLOTATO_ANALYTICS_DEFINITION_VERSION,
		payload: analytics,
		payloadSha256: sha256(analytics),
		providerId: BLOTATO_PROVIDER_ID,
		quality: analytics.metrics ? "COMPLETE" : "PARTIAL",
		requestKey: sha256({
			providerReferenceId: request.providerReferenceId,
			publicationAttemptId: request.publicationAttemptId,
			window: request.window,
		}),
		values: { provider: BLOTATO_PROVIDER_ID, ...values },
		windowEndedAt: request.window.end,
		windowStartedAt: request.window.start,
	};
}

/**
 * The second provider behind the release contract.
 *
 * The transport defaults to `disarmedFetch()` rather than to the global fetch:
 * a caller that forgets to hand this adapter a live transport gets one that
 * refuses, instead of one that publishes. Reaching a provider has to be an
 * explicit act.
 */
export function createBlotatoReleaseProvider(
	config: BlotatoAdapterConfig,
	fetchFn: typeof fetch = disarmedFetch(),
	client: BlotatoAdapter = createBlotatoAdapter(config, fetchFn),
): ReleaseProviderAdapter {
	return {
		providerId: BLOTATO_PROVIDER_ID,

		capabilities() {
			return CAPABILITIES;
		},

		async validateConnection(): Promise<ReleaseConnectionState> {
			try {
				const accounts = await client.listAccounts();
				const account = accounts.find((entry) => entry.id === config.allowedAccountId);
				if (!account) return { state: "NOT_CONNECTED" };
				if (account.status !== "ACTIVE") {
					return { reason: `Blotato account is ${account.status.toLowerCase()}`, state: "MISCONFIGURED" };
				}
				if (config.allowedPageId && !account.subaccounts.some((sub) => sub.id === config.allowedPageId)) {
					return { reason: "Configured Blotato page is not on the connected account", state: "MISCONFIGURED" };
				}
				return { account: toAccount(account), state: "CONNECTED" };
			} catch (error) {
				return {
					reason: error instanceof Error ? error.message : "Blotato connection check failed",
					state: "MISCONFIGURED",
				};
			}
		},

		async listAccounts() {
			return (await client.listAccounts()).map(toAccount);
		},

		prepareManifest(input): PreparedRelease {
			const now = input.now ?? new Date();
			assertReleaseDispatchInvariants({ ...input, now, providerId: BLOTATO_PROVIDER_ID });
			assertSupportedPlatform(CAPABILITIES, input.release.destination.platform);
			assertFutureSchedule(input.release.notBefore, now);
			const payload = shapeBlotatoPayload(input.release, config.allowedPageId);
			return {
				environment: input.authorization.environment,
				externalAccountId: input.release.destination.externalAccountId,
				idempotencyKey: input.authorization.idempotencyKey,
				manifestHash: input.authorization.manifestHash,
				notBefore: input.release.notBefore,
				payload,
				payloadHash: preparedReleaseHash(payload),
				providerId: BLOTATO_PROVIDER_ID,
			};
		},

		async dispatch(prepared) {
			const payload = asBlotatoPayload(prepared.payload);
			try {
				const submission = await client.createPost({
					accountId: payload.accountId,
					mediaUrls: payload.mediaUrls,
					platform: payload.platform,
					scheduledTime: payload.scheduledTime,
					text: payload.text,
					...(payload.pageId ? { pageId: payload.pageId } : {}),
				});
				return { outcome: "ACCEPTED", providerReferenceId: submission.postSubmissionId };
			} catch (error) {
				return classifyDispatchError(error);
			}
		},

		async getStatus(input): Promise<ReleaseStatus> {
			try {
				const state = await client.getSubmissionState(input.providerReferenceId);
				if (state.state === "PUBLISHED" || state.state === "SCHEDULED") {
					return { providerReferenceId: input.providerReferenceId, state: "SCHEDULED" };
				}
				if (state.state === "FAILED") {
					return { providerReferenceId: input.providerReferenceId, reason: state.errorMessage, state: "UNKNOWN" };
				}
				return {
					providerReferenceId: input.providerReferenceId,
					reason: "Blotato is still processing",
					state: "UNKNOWN",
				};
			} catch (error) {
				return {
					providerReferenceId: input.providerReferenceId,
					reason: error instanceof Error ? error.message : "Blotato status lookup failed",
					state: "UNKNOWN",
				};
			}
		},

		async ingestMetrics(request: ReleaseMetricsRequest): Promise<ReleaseMetricsReading> {
			return toMetricsReading(request, await client.getPostAnalytics(request.providerReferenceId));
		},
	};
}

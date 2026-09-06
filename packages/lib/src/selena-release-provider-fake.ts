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

export const FAKE_PROVIDER_ID = "in-memory";

export type FakeReleaseProviderOptions = {
	accounts?: readonly ReleaseProviderAccount[];
	connection?: ReleaseConnectionState;
	dispatchOutcome?: ReleaseDispatchOutcome;
	knownReferences?: readonly string[];
	metricsPayload?: unknown;
	platforms?: readonly string[];
	providerId?: string;
};

export type FakeReleaseProvider = ReleaseProviderAdapter & {
	/** Everything the fake was asked to send, so a test can prove nothing left the process. */
	readonly dispatched: readonly PreparedRelease[];
};

type FakeReleasePayload = {
	accountId: string;
	attachments: { checksum: string; href: string }[];
	scheduledAt: string;
	text: string;
};

const DEFAULT_ACCOUNT: ReleaseProviderAccount = {
	accountRef: "In-memory page",
	displayName: "In-memory page",
	externalAccountId: "in-memory-account",
	organizationRef: "in-memory-org",
	platform: "linkedin_page",
	status: "ACTIVE",
};

function shapeFakePayload(release: NormalizedRelease): FakeReleasePayload {
	return {
		accountId: release.destination.externalAccountId,
		attachments: release.assets.map((asset) => ({ checksum: asset.sha256, href: asset.sourceUrl })),
		scheduledAt: release.notBefore,
		text: release.ctaUrl ? `${release.body} ${release.ctaUrl}` : release.body,
	};
}

/**
 * Test double for the release provider contract. It performs no I/O, so the
 * contract suite can run identically against it and against a real adapter
 * whose transport has been stubbed.
 */
export function createFakeReleaseProvider(options: FakeReleaseProviderOptions = {}): FakeReleaseProvider {
	const providerId = options.providerId ?? FAKE_PROVIDER_ID;
	const accounts = options.accounts ?? [DEFAULT_ACCOUNT];
	const capabilities: ReleaseProviderCapabilities = {
		cancellation: true,
		mediaMimeTypes: ["image/jpeg", "image/png", "image/webp"],
		metrics: true,
		platforms: options.platforms ?? ["linkedin_page"],
		providerId,
		scheduling: "SCHEDULE_ONLY",
	};
	const dispatched: PreparedRelease[] = [];
	const knownReferences = new Set(options.knownReferences ?? []);
	const metricsPayload = options.metricsPayload ?? [{ data: [{ date: "2030-01-01", total: 1 }], label: "Impressions" }];

	return {
		providerId,
		dispatched,

		capabilities() {
			return capabilities;
		},

		async validateConnection() {
			return options.connection ?? { account: accounts[0] ?? DEFAULT_ACCOUNT, state: "CONNECTED" };
		},

		async listAccounts() {
			return [...accounts];
		},

		prepareManifest(input): PreparedRelease {
			const now = input.now ?? new Date();
			assertReleaseDispatchInvariants({ ...input, now, providerId });
			assertSupportedPlatform(capabilities, input.release.destination.platform);
			assertFutureSchedule(input.release.notBefore, now);
			const payload = shapeFakePayload(input.release);
			return {
				environment: input.authorization.environment,
				externalAccountId: input.release.destination.externalAccountId,
				idempotencyKey: input.authorization.idempotencyKey,
				manifestHash: input.authorization.manifestHash,
				notBefore: input.release.notBefore,
				payload,
				payloadHash: preparedReleaseHash(payload),
				providerId,
			};
		},

		async dispatch(prepared) {
			dispatched.push(prepared);
			return (
				options.dispatchOutcome ?? {
					outcome: "ACCEPTED",
					providerReferenceId: sha256({ idempotencyKey: prepared.idempotencyKey, providerId }).slice(0, 24),
				}
			);
		},

		async getStatus(input): Promise<ReleaseStatus> {
			const scheduled =
				knownReferences.has(input.providerReferenceId) ||
				dispatched.some((entry) => entry.idempotencyKey === input.providerReferenceId);
			return scheduled
				? { providerReferenceId: input.providerReferenceId, state: "SCHEDULED" }
				: { providerReferenceId: input.providerReferenceId, state: "NOT_FOUND" };
		},

		async ingestMetrics(request: ReleaseMetricsRequest): Promise<ReleaseMetricsReading> {
			return {
				capturedAt: request.capturedAt,
				definitionVersion: `${providerId}.analytics/v1`,
				payload: metricsPayload,
				payloadSha256: sha256(metricsPayload),
				providerId,
				quality: "COMPLETE",
				requestKey: sha256({
					checkpoint: `${providerId}.analytics/v1`,
					publicationAttemptId: request.publicationAttemptId,
					windowEndedAt: request.window.end,
					windowStartedAt: request.window.start,
				}),
				values: { metrics: metricsPayload, provider: providerId },
				windowEndedAt: request.window.end,
				windowStartedAt: request.window.start,
			};
		},
	};
}

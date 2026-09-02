import { sha256 } from "./selena-control-room";
import { assertImmutablePublicationPackage } from "./selena-release-gateway";

export const SELENA_RELEASE_ENVIRONMENTS = ["PRODUCTION", "STAGING", "DRY_RUN"] as const;
export type ReleaseEnvironment = (typeof SELENA_RELEASE_ENVIRONMENTS)[number];

export type ReleaseProviderCapabilities = {
	cancellation: boolean;
	mediaMimeTypes: readonly string[];
	metrics: boolean;
	platforms: readonly string[];
	providerId: string;
	scheduling: "SCHEDULE_ONLY" | "IMMEDIATE_AND_SCHEDULE";
};

export type ReleaseProviderAccount = {
	accountRef: string;
	displayName: string | null;
	externalAccountId: string;
	organizationRef: string | null;
	platform: string;
	status: "ACTIVE" | "DISCONNECTED" | "UNKNOWN";
};

export type ReleaseConnectionState =
	| { account: ReleaseProviderAccount; state: "CONNECTED" }
	| { state: "NOT_CONNECTED" }
	| { reason: string; state: "MISCONFIGURED" };

export type NormalizedReleaseAsset = {
	assetId: string;
	mimeType: string;
	sha256: string;
	/** Short-lived private-storage read URL resolved before the provider is reached. */
	sourceUrl: string;
};

/**
 * The internal release model. Every field here is meaningful to the content
 * lifecycle rather than to one provider, so a second provider can be added by
 * writing an adapter instead of by changing the model.
 */
export type NormalizedRelease = {
	assets: readonly NormalizedReleaseAsset[];
	body: string;
	brandId: string;
	contentHash: string;
	contentVersionId: string;
	ctaUrl: string | null;
	destination: {
		accountRef: string;
		channelAccountId: string;
		externalAccountId: string;
		platform: string;
	};
	notBefore: string;
	organizationId: string;
	releaseIntentId: string;
	timezone: string;
};

/**
 * What the release boundary must have established before an adapter is allowed
 * to shape a provider request: the bound provider, the signed manifest it was
 * bound to, and the audit event that recorded the decision.
 */
export type ReleaseDispatchAuthorization = {
	auditEventId: string;
	contentHash: string;
	environment: ReleaseEnvironment;
	expiresAt: string;
	idempotencyKey: string;
	killSwitchActive: boolean;
	manifestHash: string;
	providerId: string;
	signature: string;
	signatureAlgorithm: string;
	signingKeyVersion: string;
};

export type ReleaseDispatchInvariant =
	| "AUDIT_TRAIL_MISSING"
	| "CONTENT_HASH_MISMATCH"
	| "ENVIRONMENT_INVALID"
	| "IDEMPOTENCY_KEY_MISSING"
	| "KILL_SWITCH_ACTIVE"
	| "MANIFEST_EXPIRED"
	| "MANIFEST_SIGNATURE_INVALID"
	| "PLATFORM_UNSUPPORTED"
	| "PROVIDER_NOT_BOUND"
	| "SCHEDULE_NOT_IN_FUTURE";

export class ReleaseDispatchInvariantError extends Error {
	constructor(readonly invariant: ReleaseDispatchInvariant) {
		super(invariant);
		this.name = "ReleaseDispatchInvariantError";
	}
}

export type PreparedRelease = {
	environment: ReleaseEnvironment;
	externalAccountId: string;
	idempotencyKey: string;
	manifestHash: string;
	notBefore: string;
	/** Provider-shaped request body. Nothing outside its own adapter may read it. */
	payload: unknown;
	payloadHash: string;
	providerId: string;
};

/** Mirrors the terminal states `selena_release.publication_attempts` accepts. */
export type ReleaseDispatchOutcome =
	| { outcome: "ACCEPTED"; providerReferenceId: string }
	| { outcome: "DEFINITIVE_FAILURE"; reason: string }
	| { outcome: "AMBIGUOUS"; reason: string };

export type ReleaseStatus =
	| { providerReferenceId: string; state: "SCHEDULED" }
	| { providerReferenceId: string; state: "NOT_FOUND" }
	| { providerReferenceId: string; reason: string; state: "UNKNOWN" };

export type ReleaseWindow = { end: string; start: string };

export type ReleaseMetricsReading = {
	capturedAt: string;
	definitionVersion: string;
	payload: unknown;
	payloadSha256: string;
	providerId: string;
	quality: "COMPLETE" | "PARTIAL" | "STALE" | "QUARANTINED";
	/** Idempotency key for the raw evidence row this reading will be stored as. */
	requestKey: string;
	values: { provider: string } & Record<string, unknown>;
	windowEndedAt: string;
	windowStartedAt: string;
};

export type ReleaseMetricsRequest = {
	capturedAt: string;
	providerReferenceId: string;
	publicationAttemptId: string;
	window: ReleaseWindow;
};

export type ReleaseProviderAdapter = {
	capabilities(): ReleaseProviderCapabilities;
	dispatch(prepared: PreparedRelease): Promise<ReleaseDispatchOutcome>;
	getStatus(input: { providerReferenceId: string; window: ReleaseWindow }): Promise<ReleaseStatus>;
	ingestMetrics(request: ReleaseMetricsRequest): Promise<ReleaseMetricsReading>;
	listAccounts(): Promise<ReleaseProviderAccount[]>;
	prepareManifest(input: {
		authorization: ReleaseDispatchAuthorization;
		now?: Date;
		release: NormalizedRelease;
	}): PreparedRelease;
	readonly providerId: string;
	validateConnection(): Promise<ReleaseConnectionState>;
};

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function isReleaseEnvironment(value: string): value is ReleaseEnvironment {
	return (SELENA_RELEASE_ENVIRONMENTS as readonly string[]).includes(value);
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * The single place these invariants are checked, so a new provider inherits
 * them by construction rather than by remembering to repeat them.
 */
export function assertReleaseDispatchInvariants(input: {
	authorization: ReleaseDispatchAuthorization;
	now?: Date;
	providerId: string;
	release: NormalizedRelease;
}): void {
	const { authorization } = input;
	if (!isReleaseEnvironment(authorization.environment)) {
		throw new ReleaseDispatchInvariantError("ENVIRONMENT_INVALID");
	}
	if (authorization.providerId !== input.providerId) throw new ReleaseDispatchInvariantError("PROVIDER_NOT_BOUND");
	if (authorization.killSwitchActive) throw new ReleaseDispatchInvariantError("KILL_SWITCH_ACTIVE");
	if (!authorization.idempotencyKey.trim()) throw new ReleaseDispatchInvariantError("IDEMPOTENCY_KEY_MISSING");
	if (!authorization.auditEventId.trim()) throw new ReleaseDispatchInvariantError("AUDIT_TRAIL_MISSING");
	if (
		!SHA256_PATTERN.test(authorization.contentHash) ||
		authorization.contentHash !== input.release.contentHash ||
		!SHA256_PATTERN.test(authorization.manifestHash)
	) {
		throw new ReleaseDispatchInvariantError("CONTENT_HASH_MISMATCH");
	}
	if (
		authorization.signatureAlgorithm !== "Ed25519" ||
		!authorization.signature.trim() ||
		!authorization.signingKeyVersion.trim()
	) {
		throw new ReleaseDispatchInvariantError("MANIFEST_SIGNATURE_INVALID");
	}
	const expiresAt = new Date(authorization.expiresAt);
	const now = input.now ?? new Date();
	if (Number.isNaN(expiresAt.getTime()) || expiresAt <= now) {
		throw new ReleaseDispatchInvariantError("MANIFEST_EXPIRED");
	}
}

/** Providers that only schedule must never be handed a time that already passed. */
export function assertFutureSchedule(notBefore: string, now: Date): void {
	const scheduledFor = new Date(notBefore);
	if (Number.isNaN(scheduledFor.getTime()) || scheduledFor <= now) {
		throw new ReleaseDispatchInvariantError("SCHEDULE_NOT_IN_FUTURE");
	}
}

export function assertSupportedPlatform(capabilities: ReleaseProviderCapabilities, platform: string): void {
	if (!capabilities.platforms.includes(platform)) throw new ReleaseDispatchInvariantError("PLATFORM_UNSUPPORTED");
}

/** Binds a prepared payload to the release it was shaped from. */
export function preparedReleaseHash(payload: unknown): string {
	return sha256(payload);
}

/**
 * Projects a signed publication package onto the normalized release model. The
 * package stays the immutable security binding; this only reads it.
 */
export function toNormalizedRelease(
	publicationPackage: unknown,
	assetUrls: Readonly<Record<string, string>> = {},
): NormalizedRelease {
	assertImmutablePublicationPackage(publicationPackage);
	const record = publicationPackage as Record<string, unknown>;
	const destination = asRecord(record.destination);
	const content = asRecord(record.content);
	const schedule = asRecord(record.schedule);
	const releaseIntentId = asString(record.releaseIntentId);
	const organizationId = asString(record.organizationId);
	const brandId = asString(record.brandId);
	const platform = asString(destination?.platform);
	const channelAccountId = asString(destination?.channelAccountId);
	const externalAccountId = asString(destination?.integrationId);
	const accountRef = asString(destination?.accountRef);
	const contentVersionId = asString(content?.contentVersionId);
	const contentHash = asString(content?.contentHash);
	const notBefore = asString(schedule?.notBefore);
	if (
		!releaseIntentId ||
		!organizationId ||
		!brandId ||
		!platform ||
		!channelAccountId ||
		!externalAccountId ||
		!accountRef ||
		!contentVersionId ||
		!contentHash ||
		!notBefore ||
		typeof content?.body !== "string"
	) {
		throw new Error("Publication package cannot be normalized into a release");
	}
	const assets = (record.assets as unknown[]).map((entry) => {
		const asset = asRecord(entry);
		const assetId = asString(asset?.assetId);
		const mimeType = asString(asset?.mimeType);
		const digest = asString(asset?.sha256);
		if (!assetId || !mimeType || !digest) throw new Error("Publication package asset is incomplete");
		const sourceUrl = assetUrls[assetId];
		if (!sourceUrl) throw new Error("Publication package asset has no resolved source URL");
		return { assetId, mimeType, sha256: digest, sourceUrl };
	});
	return {
		assets,
		body: content.body,
		brandId,
		contentHash,
		contentVersionId,
		ctaUrl: asString(content.ctaUrl),
		destination: { accountRef, channelAccountId, externalAccountId, platform },
		notBefore,
		organizationId,
		releaseIntentId,
		timezone: asString(schedule?.timezone) ?? "UTC",
	};
}

export type ReleaseProviderRegistry = {
	providers(): readonly string[];
	resolve(providerId: string): ReleaseProviderAdapter;
};

/**
 * The database keeps at most one active provider per channel and environment;
 * this refuses to hold two implementations under one provider ID so the two
 * halves cannot disagree about which adapter that binding names.
 */
export function createReleaseProviderRegistry(adapters: readonly ReleaseProviderAdapter[]): ReleaseProviderRegistry {
	const byId = new Map<string, ReleaseProviderAdapter>();
	for (const adapter of adapters) {
		if (byId.has(adapter.providerId)) throw new Error("A release provider ID may map to only one adapter");
		byId.set(adapter.providerId, adapter);
	}
	return {
		providers: () => [...byId.keys()].sort(),
		resolve(providerId) {
			const adapter = byId.get(providerId);
			if (!adapter) throw new ReleaseDispatchInvariantError("PROVIDER_NOT_BOUND");
			return adapter;
		},
	};
}

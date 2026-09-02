import type { ReleaseEnvironment, ReleaseProviderAdapter } from "./selena-release-provider";

/**
 * Publishing is the one action in the release path that cannot be undone: once
 * a provider accepts a post it is visible to the public. So the ability to
 * reach a provider is not a configuration detail — it is refused by default and
 * has to be granted deliberately, in three independent places.
 *
 * The three are independent on purpose. A flag can be set by mistake, an
 * environment can be mislabelled, and a wrapper can be bypassed by calling an
 * adapter directly. No single slip is enough.
 *
 *   1. `SELENA_RELEASE_PUBLISH_ENABLED` — off unless it is exactly "true".
 *   2. the release environment — only PRODUCTION may publish at all.
 *   3. the transport — a runtime that must not publish builds its providers on
 *      `disarmedFetch`, which cannot reach the network even if 1 and 2 are wrong.
 */

export const PUBLISH_FLAG = "SELENA_RELEASE_PUBLISH_ENABLED";

export type PublishPolicyEnv = Readonly<Record<string, string | undefined>>;

export type PublishRefusal =
	| "ENVIRONMENT_DOES_NOT_PUBLISH"
	| "PUBLISH_FLAG_NOT_SET"
	| "TRANSPORT_DISARMED"
	| "UNKNOWN_ENVIRONMENT";

export type PublishDecision = { allowed: true } | { allowed: false; refusal: PublishRefusal };

/**
 * A refusal is not a provider failure. Recording it as one would put a
 * "delivery failed" row in the publication attempt log for a delivery that was
 * never attempted, so this is raised rather than returned as an outcome.
 */
export class PublishRefusedError extends Error {
	constructor(readonly refusal: PublishRefusal) {
		super(refusal);
		this.name = "PublishRefusedError";
	}
}

const PUBLISHING_ENVIRONMENTS: readonly ReleaseEnvironment[] = ["PRODUCTION"];

export function resolvePublishDecision(environment: string, env: PublishPolicyEnv): PublishDecision {
	if (environment !== "PRODUCTION" && environment !== "STAGING" && environment !== "DRY_RUN") {
		return { allowed: false, refusal: "UNKNOWN_ENVIRONMENT" };
	}
	if (!PUBLISHING_ENVIRONMENTS.includes(environment)) {
		return { allowed: false, refusal: "ENVIRONMENT_DOES_NOT_PUBLISH" };
	}
	if (env[PUBLISH_FLAG] !== "true") return { allowed: false, refusal: "PUBLISH_FLAG_NOT_SET" };
	return { allowed: true };
}

export function assertPublishAllowed(environment: string, env: PublishPolicyEnv): void {
	const decision = resolvePublishDecision(environment, env);
	if (!decision.allowed) throw new PublishRefusedError(decision.refusal);
}

/**
 * The transport a non-publishing runtime hands to its providers. It satisfies
 * the `fetch` signature so an adapter needs no separate staging code path, and
 * refuses every call so no adapter can reach a provider by accident.
 */
export function disarmedFetch(): typeof fetch {
	return (() => {
		throw new PublishRefusedError("TRANSPORT_DISARMED");
	}) as unknown as typeof fetch;
}

export function isDisarmed(error: unknown): boolean {
	return error instanceof PublishRefusedError;
}

/**
 * Adapters classify a failed dispatch as definitive or ambiguous, and an
 * ambiguous one leaves a "we may have published" record behind. A refusal is
 * neither: nothing was sent. Adapters call this first so a refusal keeps its
 * meaning instead of being flattened into a provider outcome.
 */
export function rethrowIfRefused(error: unknown): void {
	if (error instanceof PublishRefusedError) throw error;
}

/**
 * Wraps any adapter so the policy is consulted before a dispatch is shaped,
 * not inside each adapter. Reading — connection, accounts, status, metrics —
 * stays open: those calls publish nothing and a blocked runtime still has to
 * be able to show what the provider holds.
 */
export function guardPublishing(
	adapter: ReleaseProviderAdapter,
	options: { env: PublishPolicyEnv; environment: string },
): ReleaseProviderAdapter {
	return {
		...adapter,
		providerId: adapter.providerId,
		capabilities: () => adapter.capabilities(),
		validateConnection: () => adapter.validateConnection(),
		listAccounts: () => adapter.listAccounts(),
		getStatus: (input) => adapter.getStatus(input),
		ingestMetrics: (request) => adapter.ingestMetrics(request),
		prepareManifest: (input) => {
			assertPublishAllowed(options.environment, options.env);
			return adapter.prepareManifest(input);
		},
		dispatch: async (prepared) => {
			assertPublishAllowed(options.environment, options.env);
			return adapter.dispatch(prepared);
		},
	};
}

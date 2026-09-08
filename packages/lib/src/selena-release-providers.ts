import type { ReleaseEnvironment } from "./selena-release-provider";
import { createReleaseProviderRegistry } from "./selena-release-provider";
import { createBlotatoReleaseProvider } from "./selena-release-provider-blotato";
import { guardPublishing, type PublishPolicyEnv } from "./selena-release-publish-policy";

export type ReleaseProviderRegistry = ReturnType<typeof createReleaseProviderRegistry>;

export type ReleaseProviderConfiguration =
	| { state: "NOT_CONFIGURED"; missing: string[] }
	| { state: "CONFIGURED"; environment: ReleaseEnvironment; providerId: string; registry: ReleaseProviderRegistry };

/**
 * The release environment a runtime guards its providers with.
 *
 * The contour already names itself for the projection worker through
 * `SELENA_GROWTH_SOURCE_ENVIRONMENT`; the release policy reads the same name
 * rather than asking to be told twice. Anything unrecognised — including the
 * variable being absent — guards as DRY_RUN: a runtime that has not said where
 * it is does not get to publish, and reads are unaffected either way.
 */
export function releaseEnvironmentFrom(env: PublishPolicyEnv = process.env): ReleaseEnvironment {
	switch (env.SELENA_GROWTH_SOURCE_ENVIRONMENT) {
		case "production":
			return "PRODUCTION";
		case "staging":
			return "STAGING";
		default:
			return "DRY_RUN";
	}
}

/**
 * The provider registry a runtime builds from its own configuration.
 *
 * This is the one place a live transport is handed to a provider. Every
 * adapter goes in behind `guardPublishing`, so reading — connection state,
 * the accounts a credential can see — works anywhere the key is present,
 * while shaping or dispatching a release refuses structurally outside a
 * production contour with the publish flag set. Without a key there is no
 * registry at all: the caller sees what is missing rather than a provider
 * that fails on first use.
 */
export function configureReleaseProviders(
	env: PublishPolicyEnv = process.env,
	fetchFn: typeof fetch = fetch,
): ReleaseProviderConfiguration {
	const missing = ["BLOTATO_API_KEY", "BLOTATO_ALLOWED_ACCOUNT_ID"].filter((name) => !env[name]);
	if (missing.length > 0) return { missing, state: "NOT_CONFIGURED" };

	const environment = releaseEnvironmentFrom(env);
	const blotato = createBlotatoReleaseProvider(
		{
			allowedAccountId: env.BLOTATO_ALLOWED_ACCOUNT_ID as string,
			allowedPageId: env.BLOTATO_ALLOWED_PAGE_ID || undefined,
			apiKey: env.BLOTATO_API_KEY as string,
		},
		fetchFn,
	);
	const registry = createReleaseProviderRegistry([guardPublishing(blotato, { env, environment })]);
	return { environment, providerId: blotato.providerId, registry, state: "CONFIGURED" };
}

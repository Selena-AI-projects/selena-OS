import type { ReleaseEnvironment, ReleaseProviderAdapter } from "./selena-release-provider";
import { createReleaseProviderRegistry } from "./selena-release-provider";
import { BLOTATO_PROVIDER_ID, createBlotatoReleaseProvider } from "./selena-release-provider-blotato";
import { createSelenaLabReleaseProvider, SELENA_LAB_PROVIDER_ID } from "./selena-release-provider-lab";
import { guardPublishing, type PublishPolicyEnv } from "./selena-release-publish-policy";

export type ReleaseProviderRegistry = ReturnType<typeof createReleaseProviderRegistry>;

export type ReleaseProviderConfiguration =
	| { state: "NOT_CONFIGURED"; missing: string[] }
	| {
			state: "CONFIGURED";
			environment: ReleaseEnvironment;
			providerIds: readonly string[];
			registry: ReleaseProviderRegistry;
	  };

/**
 * What each provider needs on a runtime before it is built. A runtime holds
 * only the providers it is given settings for: the site's GitHub token, for
 * one, belongs on the gateway that opens pull requests and nowhere else.
 */
export const RELEASE_PROVIDER_SETTINGS: Readonly<Record<string, readonly string[]>> = {
	[BLOTATO_PROVIDER_ID]: ["BLOTATO_API_KEY", "BLOTATO_ALLOWED_ACCOUNT_ID"],
	[SELENA_LAB_PROVIDER_ID]: ["SELENA_LAB_GITHUB_TOKEN", "SELENA_LAB_SITE_REPOSITORY"],
};

/** The settings a provider still lacks on this runtime; empty when it can be built. */
export function missingProviderSettings(providerId: string, env: PublishPolicyEnv = process.env): string[] {
	const required = RELEASE_PROVIDER_SETTINGS[providerId];
	if (!required) throw new Error(`Unknown release provider: ${providerId}`);
	return required.filter((name) => !env[name]);
}

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
 * production contour with the publish flag set. A provider without its
 * settings is left out rather than built to fail on first use; with none at
 * all there is no registry, and the caller sees what is missing.
 */
export function configureReleaseProviders(
	env: PublishPolicyEnv = process.env,
	fetchFn: typeof fetch = fetch,
): ReleaseProviderConfiguration {
	const adapters: ReleaseProviderAdapter[] = [];
	if (missingProviderSettings(BLOTATO_PROVIDER_ID, env).length === 0) {
		adapters.push(
			createBlotatoReleaseProvider(
				{
					allowedAccountId: env.BLOTATO_ALLOWED_ACCOUNT_ID as string,
					allowedPageId: env.BLOTATO_ALLOWED_PAGE_ID || undefined,
					apiKey: env.BLOTATO_API_KEY as string,
				},
				fetchFn,
			),
		);
	}
	if (missingProviderSettings(SELENA_LAB_PROVIDER_ID, env).length === 0) {
		adapters.push(
			createSelenaLabReleaseProvider(
				{ repository: env.SELENA_LAB_SITE_REPOSITORY as string, token: env.SELENA_LAB_GITHUB_TOKEN as string },
				fetchFn,
			),
		);
	}
	if (adapters.length === 0) {
		return {
			missing: Object.keys(RELEASE_PROVIDER_SETTINGS).flatMap((providerId) => missingProviderSettings(providerId, env)),
			state: "NOT_CONFIGURED",
		};
	}

	const environment = releaseEnvironmentFrom(env);
	const registry = createReleaseProviderRegistry(
		adapters.map((adapter) => guardPublishing(adapter, { env, environment })),
	);
	return { environment, providerIds: registry.providers(), registry, state: "CONFIGURED" };
}

import type { ReleaseEnvironment } from "@workspace/lib/selena-release-provider";

/**
 * Which contour a new channel binding may honestly target.
 *
 * A binding can only ever name the environment the runtime's own publishing
 * key already reports itself as — `configureReleaseProviders` reads a single
 * process-wide setting, and the release dispatcher never asks the binding
 * which contour it thinks it is in. So there is no independent choice to
 * offer: an unchecked or unconfigured connection means the contour is not yet
 * known, not that any of the three is a safe default.
 */
export function resolveBoundEnvironment(
	providerStatus: { state: string; environment?: ReleaseEnvironment } | null,
): ReleaseEnvironment | null {
	if (!providerStatus || providerStatus.state === "NOT_CONFIGURED") return null;
	return providerStatus.environment ?? null;
}

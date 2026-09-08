import type { ReleaseDispatchReport } from "./selena-release-dispatch";

/**
 * The Release Gateway as seen from outside its own process.
 *
 * The gateway holds the signing key and the only database identity allowed to
 * authorize a dispatch, so nothing else may do this work; a caller gets two
 * verbs and no way to reach past them.
 */
export type ReleaseGatewayClient = {
	dispatch(input: { idempotencyKey: string; manifestId: string }): Promise<ReleaseDispatchReport>;
	signManifest(releaseIntentId: string): Promise<{ expiresAt: string; manifestHash: string; manifestId: string }>;
};

export type ReleaseGatewayConfig = { baseUrl: string; token: string };

/**
 * The gateway is reached over the contour's private network, so an `http://`
 * base is allowed where a public one would not be: `*.railway.internal` never
 * leaves the project. Anything else must be HTTPS.
 */
export function requiredGatewayConfig(env = process.env): ReleaseGatewayConfig | null {
	const baseUrl = env.SELENA_GATEWAY_BASE_URL;
	const token = env.SELENA_GATEWAY_INTERNAL_TOKEN;
	if (!baseUrl && !token) return null;
	if (!baseUrl || !token) {
		throw new Error("The release carrier requires SELENA_GATEWAY_BASE_URL and SELENA_GATEWAY_INTERNAL_TOKEN together");
	}
	const url = new URL(baseUrl);
	const privateHost = url.hostname.endsWith(".railway.internal") || url.hostname === "localhost";
	if (url.protocol !== "https:" && !(url.protocol === "http:" && privateHost)) {
		throw new Error("SELENA_GATEWAY_BASE_URL must use HTTPS outside the private network");
	}
	return { baseUrl: baseUrl.replace(/\/$/, ""), token };
}

export function createReleaseGatewayClient(
	config: ReleaseGatewayConfig,
	fetchFn: typeof fetch = fetch,
): ReleaseGatewayClient {
	async function post<Result>(path: string, body: Record<string, unknown>): Promise<Result> {
		const response = await fetchFn(`${config.baseUrl}${path}`, {
			body: JSON.stringify(body),
			headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
			method: "POST",
		});
		if (!response.ok) throw new Error(`Release Gateway answered ${response.status} for ${path}`);
		return (await response.json()) as Result;
	}

	return {
		async dispatch(input) {
			return post<ReleaseDispatchReport>("/v1/release-dispatches", input);
		},

		async signManifest(releaseIntentId) {
			const signed = await post<{ expiresAt?: unknown; manifestHash?: unknown; manifestId?: unknown }>(
				"/v1/release-manifests",
				{ releaseIntentId },
			);
			if (typeof signed.manifestId !== "string" || signed.manifestId.length === 0) {
				throw new Error("Release Gateway returned no manifest id");
			}
			return {
				expiresAt: String(signed.expiresAt ?? ""),
				manifestHash: String(signed.manifestHash ?? ""),
				manifestId: signed.manifestId,
			};
		},
	};
}

export const CANONICAL_PUBLIC_READINESS_URL = "https://www.selenasystems.com/check";

export const CANONICAL_PUBLIC_READINESS_PAYLOAD = {
	error: "Canonical Public Readiness Surface",
	code: "PUBLIC_READINESS_MOVED",
	message: "The free Public Readiness check runs only on selenasystems.com/check.",
	canonicalUrl: CANONICAL_PUBLIC_READINESS_URL,
	providerCalls: 0,
	measurementJobsCreated: 0,
} as const;

export function canonicalPublicReadinessResponse(): Response {
	return Response.json(CANONICAL_PUBLIC_READINESS_PAYLOAD, {
		status: 410,
		headers: {
			Link: `<${CANONICAL_PUBLIC_READINESS_URL}>; rel="canonical"`,
			"Cache-Control": "no-store",
		},
	});
}

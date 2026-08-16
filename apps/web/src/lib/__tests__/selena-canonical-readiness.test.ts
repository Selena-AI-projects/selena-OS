import { describe, expect, it } from "vitest";
import {
	CANONICAL_PUBLIC_READINESS_PAYLOAD,
	CANONICAL_PUBLIC_READINESS_URL,
	canonicalPublicReadinessResponse,
} from "../selena-canonical-readiness";

describe("canonical Public Readiness boundary", () => {
	it("points historical app callers to the only free scanner without creating work", async () => {
		const response = canonicalPublicReadinessResponse();
		const body = await response.json();

		expect(response.status).toBe(410);
		expect(response.headers.get("link")).toContain(CANONICAL_PUBLIC_READINESS_URL);
		expect(body).toEqual(CANONICAL_PUBLIC_READINESS_PAYLOAD);
		expect(body.providerCalls).toBe(0);
		expect(body.measurementJobsCreated).toBe(0);
	});
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

	it("retires every legacy readiness read and fix path", () => {
		const routeFiles = [
			"../../routes/api/v1/selena/readiness/scans/$scanId.ts",
			"../../routes/api/v1/selena/readiness/scans/$scanId/fixes/$findingId.ts",
		];

		for (const routeFile of routeFiles) {
			const source = readFileSync(fileURLToPath(new URL(routeFile, import.meta.url)), "utf8");
			expect(source).toContain("canonicalPublicReadinessResponse");
			for (const retiredReference of [
				"svPublicScans",
				"generateReadinessFix",
				"readinessResultSchema",
				'from "@workspace/lib/db',
			]) {
				expect(source).not.toContain(retiredReference);
			}
		}
	});
});

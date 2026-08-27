import { describe, expect, it } from "vitest";
import {
	createPostizPerformanceSnapshot,
	normalizePostizAnalytics,
	POSTIZ_ANALYTICS_DEFINITION_VERSION,
} from "./selena-postiz-ingestion";

describe("Postiz analytics normalization", () => {
	it("keeps a versioned raw-payload hash and deterministic metrics", () => {
		const normalized = normalizePostizAnalytics([
			{ label: "Impressions", data: [{ date: "2030-01-01", total: "5200" }], percentageChange: 2.4 },
			{ label: "Followers", data: [{ date: "2030-01-01", total: 1280 }] },
		]);
		expect(normalized.definitionVersion).toBe(POSTIZ_ANALYTICS_DEFINITION_VERSION);
		expect(normalized.payloadSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(normalized.values.metrics).toMatchObject({
			impressions: { percentageChange: 2.4, points: [{ total: 5200 }] },
			followers: { percentageChange: null, points: [{ total: 1280 }] },
		});
	});

	it("rejects non-factual analytics values instead of coercing them", () => {
		expect(() =>
			normalizePostizAnalytics([{ label: "Impressions", data: [{ date: "bad", total: "unknown" }] }]),
		).toThrow("Postiz analytics date is invalid");
	});

	it("creates one stable raw-evidence request key for the same attributed collection window", () => {
		const input = {
			capturedAt: "2030-01-03T12:00:00.000Z",
			payload: [{ label: "Impressions", data: [{ date: "2030-01-02", total: 12 }] }],
			publicationAttemptId: "attempt-1",
			windowEndedAt: "2030-01-03T00:00:00.000Z",
			windowStartedAt: "2030-01-01T00:00:00.000Z",
		};
		const first = createPostizPerformanceSnapshot(input);
		const second = createPostizPerformanceSnapshot(input);
		expect(first.requestKey).toBe(second.requestKey);
		expect(first).toMatchObject({ checkpoint: "analytics", quality: "COMPLETE", values: { provider: "postiz" } });
	});
});

import { describe, expect, it, vi } from "vitest";
import { collectPostizPerformanceSnapshot } from "./selena-postiz-metrics-ingestion";

describe("Postiz performance ingestion", () => {
	it("collects raw provider payload before it is persisted as an attributed snapshot", async () => {
		const reader = {
			getPostAnalytics: vi
				.fn()
				.mockResolvedValue([{ label: "Impressions", data: [{ date: "2030-01-02", total: 24 }] }]),
		};
		const snapshot = await collectPostizPerformanceSnapshot(reader, {
			brandId: "selena",
			capturedAt: "2030-01-03T12:00:00.000Z",
			organizationId: "selena-systems",
			providerPostId: "postiz-post-1",
			publicationAttemptId: "attempt-1",
			windowEndedAt: "2030-01-03T00:00:00.000Z",
			windowStartedAt: "2030-01-01T00:00:00.000Z",
		});
		expect(reader.getPostAnalytics).toHaveBeenCalledTimes(1);
		expect(snapshot).toMatchObject({
			checkpoint: "analytics",
			quality: "COMPLETE",
			values: { provider: "postiz" },
		});
		expect(snapshot.payloadSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(snapshot.requestKey).toMatch(/^[a-f0-9]{64}$/);
	});

	it("rejects a provider response that cannot become factual metrics", async () => {
		await expect(
			collectPostizPerformanceSnapshot(
				{ getPostAnalytics: vi.fn().mockResolvedValue({ invalid: true }) },
				{
					brandId: "selena",
					capturedAt: "2030-01-03T12:00:00.000Z",
					organizationId: "selena-systems",
					providerPostId: "postiz-post-1",
					publicationAttemptId: "attempt-1",
					windowEndedAt: "2030-01-03T00:00:00.000Z",
					windowStartedAt: "2030-01-01T00:00:00.000Z",
				},
			),
		).rejects.toThrow("Postiz analytics response is invalid");
	});
});

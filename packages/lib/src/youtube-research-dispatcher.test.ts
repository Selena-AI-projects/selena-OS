import type { ResearchFetchRequest, ResearchProject } from "@workspace/content-workflow/research";
import { ContentResearchError } from "@workspace/content-workflow/research";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createYouTubeResearchDispatcher, parseIsoDurationSeconds } from "./youtube-research-dispatcher";

const API_KEY = "test-secret-api-key-123";

const project: ResearchProject = {
	brandId: "brand-1",
	slug: "acme",
	languages: ["en-US"],
	keywords: ["automation", "workflows"],
	topics: ["workflow automation", "ai agents"],
	negativeKeywords: [],
	profileVersionId: "pv-1",
	profileHash: "hash-1",
};

const request: ResearchFetchRequest = { project, now: new Date("2026-02-01T00:00:00.000Z") };

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
	return {
		CONTENT_OS_YOUTUBE_API_KEY: API_KEY,
		CONTENT_OS_VIDEO_RADAR_MAX_CALLS: "5",
		...overrides,
	} as NodeJS.ProcessEnv;
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const searchBody = {
	items: [
		{
			id: { videoId: "vid-1" },
			snippet: {
				title: "Search title",
				description: "Search description",
				channelId: "chan-1",
				channelTitle: "Chan One",
				publishedAt: "2026-01-20T00:00:00.000Z",
			},
		},
		{
			id: { videoId: "vid-2" },
			snippet: {
				title: "Second",
				description: "Second description",
				channelId: "chan-2",
				channelTitle: "Chan Two",
				publishedAt: "2026-01-25T00:00:00.000Z",
			},
		},
	],
};

const videosBody = {
	items: [
		{
			id: "vid-1",
			snippet: {
				title: "Detailed title",
				description: "Detailed description",
				channelId: "chan-1",
				channelTitle: "Chan One",
				publishedAt: "2026-01-20T00:00:00.000Z",
				defaultAudioLanguage: "en-US",
			},
			contentDetails: { duration: "PT14M2S" },
			statistics: { viewCount: "12345", likeCount: "678", commentCount: "90" },
		},
		{
			id: "vid-2",
			snippet: {
				title: "Second",
				description: "Second description",
				channelId: "chan-2",
				channelTitle: "Chan Two",
				publishedAt: "2026-01-25T00:00:00.000Z",
			},
			contentDetails: { duration: "PT55S" },
			// Hidden statistics: the mapping must produce nulls, never zeros.
			statistics: {},
		},
	],
};

/** A fetch stub that records every URL and serves canned bodies in order. */
function stubFetch(responses: (Response | Error)[]): { fetchImpl: typeof fetch; urls: string[] } {
	const urls: string[] = [];
	const fetchImpl = (async (input: RequestInfo | URL) => {
		urls.push(String(input));
		const next = responses.shift();
		if (!next) throw new Error("stub exhausted");
		if (next instanceof Error) throw next;
		return next;
	}) as typeof fetch;
	return { fetchImpl, urls };
}

describe("createYouTubeResearchDispatcher", () => {
	it("returns null when the key is absent or empty", () => {
		expect(createYouTubeResearchDispatcher(env({ CONTENT_OS_YOUTUBE_API_KEY: undefined }))).toBeNull();
		expect(createYouTubeResearchDispatcher(env({ CONTENT_OS_YOUTUBE_API_KEY: "  " }))).toBeNull();
	});

	it("maps search + videos responses into contract candidates and counts each HTTP request", async () => {
		const { fetchImpl, urls } = stubFetch([jsonResponse(200, searchBody), jsonResponse(200, videosBody)]);
		const dispatch = createYouTubeResearchDispatcher(env(), { fetchImpl });
		expect(dispatch).not.toBeNull();

		const result = await dispatch!(request);
		expect(result.externalProviderCalls).toBe(2);
		expect(urls).toHaveLength(2);
		expect(urls[0]).toContain("youtube/v3/search");
		expect(urls[0]).toContain("type=video");
		expect(urls[0]).toContain("publishedAfter=");
		expect(urls[1]).toContain("youtube/v3/videos");

		expect(result.sources).toHaveLength(2);
		const [first, second] = result.sources;
		expect(first).toMatchObject({
			externalId: "vid-1",
			platform: "youtube",
			channelId: "chan-1",
			channelName: "Chan One",
			title: "Detailed title",
			description: "Detailed description",
			sourceUrl: "https://www.youtube.com/watch?v=vid-1",
			publishedAt: "2026-01-20T00:00:00.000Z",
			durationSeconds: 14 * 60 + 2,
			language: "en",
			views: 12345,
			likes: 678,
			comments: 90,
			creatorPriority: null,
		});
		expect(first?.channelHistory).toEqual([]);
		expect(first?.snapshots).toEqual([
			{ capturedAt: request.now.toISOString(), views: 12345, likes: null, comments: null },
		]);
		expect(first?.transcript.status).toBe("PENDING");
		expect(first?.transcript.text).toBeNull();

		// Hidden statistics become explicit nulls, not zeros.
		expect(second?.views).toBeNull();
		expect(second?.likes).toBeNull();
		expect(second?.comments).toBeNull();
		expect(second?.snapshots).toEqual([]);

		// Provenance agrees with each source, which is what the pipeline verifies.
		expect(result.provenance).toHaveLength(2);
		expect(result.provenance[0]).toEqual({
			adapterId: "video-radar",
			platform: "youtube",
			externalId: "vid-1",
			sourceUrl: "https://www.youtube.com/watch?v=vid-1",
			capturedAt: request.now.toISOString(),
		});
	});

	it("stops at the call ceiling instead of exceeding it", async () => {
		const { fetchImpl, urls } = stubFetch([jsonResponse(200, searchBody)]);
		const dispatch = createYouTubeResearchDispatcher(env({ CONTENT_OS_VIDEO_RADAR_MAX_CALLS: "1" }), { fetchImpl });

		const result = await dispatch!(request);
		// Only the search request went out; the videos step was skipped entirely.
		expect(urls).toHaveLength(1);
		expect(result.externalProviderCalls).toBe(1);
		// Degraded candidates carry search-only fields with null stats.
		expect(result.sources).toHaveLength(2);
		expect(result.sources[0]?.views).toBeNull();
		expect(result.sources[0]?.durationSeconds).toBeNull();
	});

	it("refuses to dispatch with no configured ceiling", async () => {
		const { fetchImpl, urls } = stubFetch([]);
		const dispatch = createYouTubeResearchDispatcher(env({ CONTENT_OS_VIDEO_RADAR_MAX_CALLS: "0" }), { fetchImpl });
		await expect(dispatch!(request)).rejects.toMatchObject({ code: "PROVIDER_QUOTA_EXCEEDED" });
		expect(urls).toHaveLength(0);
	});

	it("normalizes a 403 quota body to PROVIDER_QUOTA_EXCEEDED", async () => {
		const { fetchImpl } = stubFetch([
			jsonResponse(403, { error: { errors: [{ reason: "quotaExceeded", message: `key ${API_KEY} exhausted` }] } }),
		]);
		const dispatch = createYouTubeResearchDispatcher(env(), { fetchImpl });
		const failure = await dispatch!(request).then(
			() => null,
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(ContentResearchError);
		expect((failure as ContentResearchError).code).toBe("PROVIDER_QUOTA_EXCEEDED");
		expect((failure as ContentResearchError).message).not.toContain(API_KEY);
	});

	it("normalizes auth and availability failures without leaking the key", async () => {
		for (const [response, code] of [
			[jsonResponse(401, {}), "PROVIDER_AUTH_FAILED"],
			[jsonResponse(403, { error: { errors: [{ reason: "forbidden" }] } }), "PROVIDER_AUTH_FAILED"],
			[jsonResponse(429, {}), "PROVIDER_RATE_LIMITED"],
			[jsonResponse(503, {}), "PROVIDER_UNAVAILABLE"],
			// A network error whose message embeds the full request URL and key.
			[new Error(`connect ECONNREFUSED for https://example.test/?key=${API_KEY}`), "PROVIDER_UNAVAILABLE"],
		] as const) {
			const { fetchImpl } = stubFetch([response]);
			const dispatch = createYouTubeResearchDispatcher(env(), { fetchImpl });
			const failure = await dispatch!(request).then(
				() => null,
				(error: unknown) => error,
			);
			expect(failure).toBeInstanceOf(ContentResearchError);
			expect((failure as ContentResearchError).code).toBe(code);
			expect((failure as ContentResearchError).message).not.toContain(API_KEY);
			expect((failure as ContentResearchError).message).not.toContain(encodeURIComponent(API_KEY));
		}
	});
});

describe("createYouTubeResearchDispatcher default transport", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("uses the global fetch when no fetchImpl is injected", async () => {
		const urls: string[] = [];
		vi.stubGlobal("fetch", (async (input: RequestInfo | URL) => {
			urls.push(String(input));
			return jsonResponse(200, urls.length === 1 ? searchBody : videosBody);
		}) as typeof fetch);

		const dispatch = createYouTubeResearchDispatcher(env());
		const result = await dispatch!(request);
		expect(result.externalProviderCalls).toBe(2);
		expect(urls[0]).toContain("googleapis.com/youtube/v3/search");
	});
});

describe("parseIsoDurationSeconds", () => {
	it("parses the API's duration shapes and refuses to invent zeros", () => {
		expect(parseIsoDurationSeconds("PT1H2M3S")).toBe(3723);
		expect(parseIsoDurationSeconds("PT45S")).toBe(45);
		expect(parseIsoDurationSeconds("P1DT1S")).toBe(86_401);
		expect(parseIsoDurationSeconds(undefined)).toBeNull();
		expect(parseIsoDurationSeconds("P")).toBeNull();
		expect(parseIsoDurationSeconds("garbage")).toBeNull();
	});
});

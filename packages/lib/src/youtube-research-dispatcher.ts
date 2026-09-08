/**
 * YouTube Data API v3 transport for the Video Radar adapter.
 *
 * This is the only module that ever reads `CONTENT_OS_YOUTUBE_API_KEY`. The
 * adapter itself still sees just `credentialPresent: boolean`, and every gate
 * in front of it (`CONTENT_OS_VIDEO_RADAR_LIVE`, the call ceiling, the durable
 * budget reservation in content-research-repositories) is unchanged: when any
 * of them is closed this dispatcher is never invoked, and when the key is
 * absent the factory returns null so the adapter refuses with
 * `PROVIDER_UNAVAILABLE` exactly as before.
 *
 * Accounting contract: one HTTP request equals one external provider call. The
 * returned `externalProviderCalls` is the number of requests actually made,
 * and the dispatcher never issues more requests than
 * `CONTENT_OS_VIDEO_RADAR_MAX_CALLS` permits — it degrades (skips the stats
 * step) rather than exceeding the ceiling.
 *
 * Secrecy contract: the key is only ever placed into a `URLSearchParams`
 * value, and every error message that leaves this module is either a fixed
 * string or passed through `scrub()`, which removes the key. No URL containing
 * the key is logged, thrown, or returned.
 */

import type {
	ResearchFetchRequest,
	ResearchFetchResult,
	ResearchSource,
	SourceProvenance,
	VideoRadarDispatch,
} from "@workspace/content-workflow/research";
import { ContentResearchError } from "@workspace/content-workflow/research";

/** How far back a live run looks. Fixed until the request contract carries a window. */
const SEARCH_WINDOW_DAYS = 30;

/** Upper bound on candidates asked from search.list (the API's own maximum is 50). */
const MAX_SEARCH_RESULTS = 25;

const SEARCH_ENDPOINT = "https://www.googleapis.com/youtube/v3/search";
const VIDEOS_ENDPOINT = "https://www.googleapis.com/youtube/v3/videos";

export interface YouTubeDispatcherOptions {
	/** Injection seam for tests. Defaults to the global fetch. */
	fetchImpl?: typeof fetch;
}

interface SearchItem {
	id?: { videoId?: string };
	snippet?: {
		title?: string;
		description?: string;
		channelId?: string;
		channelTitle?: string;
		publishedAt?: string;
	};
}

interface VideoItem {
	id?: string;
	snippet?: {
		title?: string;
		description?: string;
		channelId?: string;
		channelTitle?: string;
		publishedAt?: string;
		defaultAudioLanguage?: string;
		defaultLanguage?: string;
	};
	contentDetails?: { duration?: string };
	statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
}

/** Remove every occurrence of the key from a message before it can leave the module. */
function scrub(message: string, key: string): string {
	if (!key) return message;
	return message.split(key).join("[redacted]").split(encodeURIComponent(key)).join("[redacted]");
}

/**
 * A missing or hidden statistic is null — the contract's explicit "unavailable"
 * for numeric fields — never zero, because zero views is a real observation.
 */
function statNumber(value: string | undefined): number | null {
	if (value === undefined || value === "") return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** ISO 8601 duration (PT#H#M#S) to seconds; unknown shapes become null, not 0. */
export function parseIsoDurationSeconds(value: string | undefined): number | null {
	if (!value) return null;
	const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value);
	if (!match) return null;
	const [, days, hours, minutes, seconds] = match;
	if (!days && !hours && !minutes && !seconds) return null;
	return (
		Number(days ?? 0) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0)
	);
}

/** BCP-47 tag to its primary language subtag, lowercased ("en-US" -> "en"). */
function primaryLanguage(tag: string | undefined): string | null {
	if (!tag) return null;
	const subtag = tag.split("-")[0]?.trim().toLowerCase();
	return subtag ? subtag : null;
}

function normalizeHttpFailure(status: number, reason: string | null): ContentResearchError {
	if (status === 401) {
		return new ContentResearchError("PROVIDER_AUTH_FAILED", "YouTube rejected the configured API key");
	}
	if (status === 403) {
		// 403 carries both quota exhaustion and key problems; the body's error
		// reason (never its message) picks the code.
		if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
			return new ContentResearchError("PROVIDER_QUOTA_EXCEEDED", "YouTube reported the API quota as exhausted");
		}
		if (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded") {
			return new ContentResearchError("PROVIDER_RATE_LIMITED", "YouTube rate limited the request");
		}
		return new ContentResearchError("PROVIDER_AUTH_FAILED", "YouTube refused the configured API key");
	}
	if (status === 429) {
		return new ContentResearchError("PROVIDER_RATE_LIMITED", "YouTube rate limited the request");
	}
	return new ContentResearchError("PROVIDER_UNAVAILABLE", `YouTube request failed with status ${status}`);
}

/**
 * Build the adapter-compatible dispatch function, or null when no key is
 * configured. Returning null (rather than a throwing function) keeps the
 * adapter's own `PROVIDER_UNAVAILABLE` refusal path byte-identical to Stage 1.
 */
export function createYouTubeResearchDispatcher(
	env: NodeJS.ProcessEnv = process.env,
	options: YouTubeDispatcherOptions = {},
): VideoRadarDispatch | null {
	const apiKey = env.CONTENT_OS_YOUTUBE_API_KEY?.trim() ?? "";
	if (!apiKey) return null;

	const ceilingRaw = Number.parseInt(env.CONTENT_OS_VIDEO_RADAR_MAX_CALLS ?? "", 10);
	const callsPermitted = Number.isFinite(ceilingRaw) && ceilingRaw > 0 ? ceilingRaw : 0;
	const fetchImpl = options.fetchImpl ?? fetch;

	async function callApi(endpoint: string, params: Record<string, string>): Promise<unknown> {
		const query = new URLSearchParams({ ...params, key: apiKey });
		let response: Response;
		try {
			response = await fetchImpl(`${endpoint}?${query.toString()}`);
		} catch (error) {
			// A transport failure's message may embed the request URL (and the key
			// inside it); it is scrubbed and demoted to the normalized code.
			const detail = error instanceof Error ? scrub(error.message, apiKey) : "network failure";
			throw new ContentResearchError("PROVIDER_UNAVAILABLE", `YouTube request failed: ${detail}`);
		}
		if (!response.ok) {
			let reason: string | null = null;
			try {
				const body = (await response.json()) as { error?: { errors?: { reason?: string }[] } };
				reason = body.error?.errors?.[0]?.reason ?? null;
			} catch {
				// The body is discarded; only the status decides the code.
			}
			throw normalizeHttpFailure(response.status, reason);
		}
		try {
			return await response.json();
		} catch {
			throw new ContentResearchError("PROVIDER_UNAVAILABLE", "YouTube returned an unreadable response body");
		}
	}

	return async function dispatch(request: ResearchFetchRequest): Promise<ResearchFetchResult> {
		// The ceiling is re-read per factory construction and enforced here as
		// well as in the adapter: this function never issues more HTTP requests
		// than the configured ceiling permits, whatever the caller believed.
		if (callsPermitted < 1) {
			throw new ContentResearchError("PROVIDER_QUOTA_EXCEEDED", "No research provider call ceiling is configured");
		}
		let callsMade = 0;
		const spendCall = (): void => {
			callsMade += 1;
		};

		const { project, now } = request;
		const topics = project.topics.length > 0 ? project.topics : project.keywords;
		const query = topics.slice(0, 3).join(" | ");
		const publishedAfter = new Date(now.getTime() - SEARCH_WINDOW_DAYS * 86_400_000).toISOString();
		const relevanceLanguage = primaryLanguage(project.languages[0]);

		const searchParams: Record<string, string> = {
			part: "snippet",
			type: "video",
			order: "relevance",
			q: query,
			publishedAfter,
			maxResults: String(MAX_SEARCH_RESULTS),
		};
		if (relevanceLanguage) searchParams.relevanceLanguage = relevanceLanguage;

		spendCall();
		const searchBody = (await callApi(SEARCH_ENDPOINT, searchParams)) as { items?: SearchItem[] };
		const searchItems = (searchBody.items ?? []).filter((item): item is Required<SearchItem> & SearchItem =>
			Boolean(item.id?.videoId),
		);

		const videoIds = searchItems.map((item) => item.id?.videoId as string);
		// The stats step is skipped, not squeezed in, when the ceiling only
		// afforded the search call: degraded candidates with null stats are
		// honest; an extra HTTP request over the ceiling is not.
		const statsById = new Map<string, VideoItem>();
		if (videoIds.length > 0 && callsMade < callsPermitted) {
			spendCall();
			const videosBody = (await callApi(VIDEOS_ENDPOINT, {
				part: "snippet,statistics,contentDetails",
				id: videoIds.join(","),
				maxResults: String(videoIds.length),
			})) as { items?: VideoItem[] };
			for (const item of videosBody.items ?? []) {
				if (item.id) statsById.set(item.id, item);
			}
		}

		const capturedAt = now.toISOString();
		const sources: ResearchSource[] = [];
		const provenance: SourceProvenance[] = [];

		for (const item of searchItems) {
			const videoId = item.id?.videoId as string;
			const details = statsById.get(videoId);
			const snippet = details?.snippet ?? item.snippet ?? {};
			const publishedAt = snippet.publishedAt ?? item.snippet?.publishedAt;
			if (!publishedAt) continue;
			const sourceUrl = `https://www.youtube.com/watch?v=${videoId}`;
			const views = statNumber(details?.statistics?.viewCount);

			sources.push({
				externalId: videoId,
				platform: "youtube",
				channelId: snippet.channelId ?? "",
				channelName: snippet.channelTitle ?? "",
				title: snippet.title ?? "",
				description: snippet.description ?? "",
				sourceUrl,
				publishedAt,
				durationSeconds: parseIsoDurationSeconds(details?.contentDetails?.duration),
				language: primaryLanguage(snippet.defaultAudioLanguage ?? snippet.defaultLanguage),
				views,
				likes: statNumber(details?.statistics?.likeCount),
				comments: statNumber(details?.statistics?.commentCount),
				// The v3 API cannot return a channel's comparable upload history
				// (published-at plus views per past upload) without one search.list
				// per channel, which no realistic ceiling affords. An empty history
				// makes the baseline report UNAVAILABLE — a true statement — rather
				// than a confident number built from invented entries.
				channelHistory: [],
				// One observation at capture time. Velocity needs repeated
				// snapshots and will honestly report UNAVAILABLE from one.
				snapshots: views !== null ? [{ capturedAt, views, likes: null, comments: null }] : [],
				// Transcript retrieval is a separate provider this dispatcher does
				// not call; PENDING states "not yet attempted", never "absent".
				transcript: {
					status: "PENDING",
					language: null,
					text: null,
					failureReason: "TRANSCRIPT_RETRIEVAL_NOT_ATTEMPTED",
				},
				creatorPriority: null,
			});
			provenance.push({
				adapterId: "video-radar",
				platform: "youtube",
				externalId: videoId,
				sourceUrl,
				capturedAt,
			});
		}

		return { sources, provenance, externalProviderCalls: callsMade };
	};
}

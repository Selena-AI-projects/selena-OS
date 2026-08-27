const DEFAULT_POSTIZ_API_URL = "https://api.postiz.com/public/v1";

export type PostizIntegration = {
	id: string;
	identifier: string;
	name: string | null;
	organizationId: string | null;
	status: "ACTIVE" | "DISCONNECTED" | "UNKNOWN";
};

export type PostizMedia = { id: string; path: string };

export type PostizScheduledPost = {
	content: string;
	integrationId: string;
	media: readonly PostizMedia[];
	scheduledFor: string;
};

export type PostizConnectionStatus =
	| { state: "CONNECTED"; destination: PostizIntegration }
	| { state: "NOT_CONNECTED" }
	| { state: "MISCONFIGURED"; reason: string };

export class PostizApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "PostizApiError";
	}
}

export type PostizAdapter = {
	cancelPost(postId: string): Promise<void>;
	connectionStatus(): Promise<PostizConnectionStatus>;
	getPostAnalytics(postId: string): Promise<unknown>;
	listDestinations(): Promise<PostizIntegration[]>;
	listPosts(window: { end: string; start: string }): Promise<unknown[]>;
	scheduleLinkedInPagePost(input: PostizScheduledPost): Promise<{ integrationId: string; postId: string }>;
	uploadMedia(input: { bytes: Uint8Array; filename: string; mimeType: string }): Promise<PostizMedia>;
};

export type PostizAdapterConfig = {
	allowedIntegrationId: string;
	apiUrl?: string;
	expectedOrganizationId?: string;
	token: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function requireHttpsUrl(value: string): string {
	const url = new URL(value);
	if (url.protocol !== "https:") throw new Error("Postiz API URL must use HTTPS");
	return url.toString().replace(/\/$/, "");
}

function parseIntegration(value: unknown): PostizIntegration | null {
	const record = asRecord(value);
	if (!record) return null;
	const id = asString(record.id);
	const identifier = asString(record.identifier) ?? asString(record.provider);
	if (!id || !identifier) return null;
	const rawStatus = asString(record.status)?.toUpperCase();
	return {
		id,
		identifier,
		name: asString(record.name) ?? asString(record.displayName),
		organizationId: asString(record.organizationId) ?? asString(asRecord(record.organization)?.id),
		status:
			rawStatus === "ACTIVE" || rawStatus === "CONNECTED"
				? "ACTIVE"
				: rawStatus === "DISCONNECTED"
					? "DISCONNECTED"
					: "UNKNOWN",
	};
}

function responseMessage(status: number): string {
	return `Postiz API request failed with status ${status}`;
}

function parseMedia(value: unknown): PostizMedia {
	const record = asRecord(value);
	const id = asString(record?.id);
	const path = asString(record?.path);
	if (!id || !path || !/^https:\/\//.test(path)) throw new Error("Postiz upload returned an invalid media reference");
	return { id, path };
}

function parsePostCreated(value: unknown, integrationId: string): { integrationId: string; postId: string } {
	const response = Array.isArray(value) ? value[0] : value;
	const record = asRecord(response);
	const postId = asString(record?.postId);
	const returnedIntegration = asString(record?.integration);
	if (!postId || returnedIntegration !== integrationId) throw new Error("Postiz returned an unexpected post reference");
	return { integrationId, postId };
}

/**
 * Gateway-only adapter for the documented Postiz Public API. It deliberately
 * has no immediate-publish operation; scheduled submissions must pass the
 * same integration ID that the gateway allowlists.
 */
export function createPostizAdapter(config: PostizAdapterConfig, fetchFn: typeof fetch = fetch): PostizAdapter {
	if (!config.token) throw new Error("Postiz token is required by the Release Gateway");
	if (!config.allowedIntegrationId) throw new Error("Postiz allowed integration ID is required");
	const apiUrl = requireHttpsUrl(config.apiUrl ?? DEFAULT_POSTIZ_API_URL);

	async function request(path: string, init?: RequestInit): Promise<unknown> {
		const response = await fetchFn(`${apiUrl}${path}`, {
			...init,
			headers: {
				authorization: config.token,
				...(init?.headers ?? {}),
			},
		});
		if (!response.ok) throw new PostizApiError(response.status, responseMessage(response.status));
		if (response.status === 204) return null;
		return response.json();
	}

	function assertAllowedIntegration(integrationId: string): void {
		if (integrationId !== config.allowedIntegrationId)
			throw new Error("Postiz destination is not allowlisted by the Release Gateway");
	}

	return {
		async listDestinations() {
			const response = await request("/integrations");
			const entries = Array.isArray(response) ? response : asRecord(response)?.integrations;
			if (!Array.isArray(entries)) throw new Error("Postiz integrations response is invalid");
			return entries.map(parseIntegration).filter((entry): entry is PostizIntegration => entry !== null);
		},

		async connectionStatus() {
			const destinations = await this.listDestinations();
			const destination = destinations.find((entry) => entry.id === config.allowedIntegrationId);
			if (!destination) return { state: "NOT_CONNECTED" };
			if (destination.identifier !== "linkedin-page") {
				return { state: "MISCONFIGURED", reason: "The allowlisted Postiz destination is not a LinkedIn Page" };
			}
			if (destination.status !== "ACTIVE") {
				return { state: "MISCONFIGURED", reason: "The allowlisted LinkedIn Page is not active" };
			}
			if (config.expectedOrganizationId && destination.organizationId !== config.expectedOrganizationId) {
				return { state: "MISCONFIGURED", reason: "Postiz organization isolation could not be verified" };
			}
			return { state: "CONNECTED", destination };
		},

		async uploadMedia(input) {
			if (!/^image\/(jpeg|png|webp)$/.test(input.mimeType))
				throw new Error("Only approved image media may be uploaded to Postiz");
			const form = new FormData();
			form.append("file", new Blob([new Uint8Array(input.bytes)], { type: input.mimeType }), input.filename);
			return parseMedia(await request("/upload", { method: "POST", body: form }));
		},

		async scheduleLinkedInPagePost(input) {
			assertAllowedIntegration(input.integrationId);
			const scheduledFor = new Date(input.scheduledFor);
			if (Number.isNaN(scheduledFor.getTime()) || scheduledFor <= new Date()) {
				throw new Error("Postiz scheduled time must be a future ISO timestamp");
			}
			if (!input.content.trim()) throw new Error("Postiz content is required");
			const response = await request("/posts", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					type: "schedule",
					date: scheduledFor.toISOString(),
					shortLink: false,
					tags: [],
					posts: [
						{
							integration: { id: input.integrationId },
							value: [{ content: input.content, image: input.media }],
							settings: { __type: "linkedin-page", post_as_images_carousel: false },
						},
					],
				}),
			});
			return parsePostCreated(response, input.integrationId);
		},

		async listPosts(window) {
			const start = new Date(window.start);
			const end = new Date(window.end);
			if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end)
				throw new Error("Postiz status window is invalid");
			const query = new URLSearchParams({ endDate: end.toISOString(), startDate: start.toISOString() });
			const response = await request(`/posts?${query.toString()}`);
			const posts = Array.isArray(response) ? response : asRecord(response)?.posts;
			if (!Array.isArray(posts)) throw new Error("Postiz posts response is invalid");
			return posts;
		},

		async cancelPost(postId) {
			if (!postId) throw new Error("Postiz post ID is required");
			await request(`/posts/${encodeURIComponent(postId)}`, { method: "DELETE" });
		},

		async getPostAnalytics(postId) {
			if (!postId) throw new Error("Postiz post ID is required");
			return request(`/analytics/post/${encodeURIComponent(postId)}`);
		},
	};
}

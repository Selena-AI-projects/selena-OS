/**
 * Blotato HTTP client.
 *
 * The request and response shapes below follow Blotato's documented public API.
 * They have not been confirmed against a live workspace: this repository holds
 * no Blotato credential, and none was created, so every test drives the client
 * through an injected transport. Treat the paths in `BLOTATO_ROUTES` as the
 * single place to correct if a live account disagrees.
 */

const DEFAULT_BLOTATO_API_URL = "https://backend.blotato.com/v2";

export const BLOTATO_ROUTES = {
	accounts: "/accounts",
	postAnalytics: (postId: string) => `/posts/${encodeURIComponent(postId)}/analytics`,
	posts: "/posts",
	submission: (submissionId: string) => `/posts/submissions/${encodeURIComponent(submissionId)}`,
} as const;

export type BlotatoAccount = {
	displayName: string | null;
	id: string;
	platform: string;
	status: "ACTIVE" | "DISCONNECTED" | "UNKNOWN";
	subaccounts: readonly { id: string; name: string | null }[];
	username: string | null;
};

export type BlotatoPostRequest = {
	accountId: string;
	mediaUrls: readonly string[];
	pageId?: string;
	platform: string;
	scheduledTime: string;
	text: string;
};

/** Blotato answers a create with a submission id; publication is asynchronous. */
export type BlotatoSubmission = { postSubmissionId: string; scheduledTime: string | null };

export type BlotatoSubmissionState =
	| { state: "IN_PROGRESS" }
	| { publicUrl: string | null; state: "PUBLISHED" }
	| { scheduledTime: string | null; state: "SCHEDULED" }
	| { errorMessage: string; state: "FAILED" };

export type BlotatoAnalytics = { lastError: string | null; metrics: Record<string, string> | null };

export class BlotatoApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "BlotatoApiError";
	}
}

export type BlotatoAdapterConfig = {
	/**
	 * The one account this deployment may reach. A credential usually unlocks a
	 * whole workspace, so the account is pinned in configuration rather than
	 * chosen per request — a wrong account id cannot become a wrong audience.
	 */
	allowedAccountId: string;
	apiKey: string;
	apiUrl?: string;
	allowedPageId?: string;
};

export type BlotatoAdapter = {
	createPost(input: BlotatoPostRequest): Promise<BlotatoSubmission>;
	getPostAnalytics(postId: string): Promise<BlotatoAnalytics>;
	getSubmissionState(submissionId: string): Promise<BlotatoSubmissionState>;
	listAccounts(): Promise<BlotatoAccount[]>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function requireHttpsUrl(value: string): string {
	const url = new URL(value);
	if (url.protocol !== "https:") throw new Error("Blotato API URL must use HTTPS");
	return url.toString().replace(/\/$/, "");
}

function parseAccount(value: unknown): BlotatoAccount | null {
	const record = asRecord(value);
	const id = asString(record?.id);
	const platform = asString(record?.platform);
	if (!record || !id || !platform) return null;
	const rawStatus = asString(record.status)?.toUpperCase();
	const subaccounts = Array.isArray(record.subaccounts) ? record.subaccounts : [];
	return {
		displayName: asString(record.displayName) ?? asString(record.name),
		id,
		platform,
		status: rawStatus === "ACTIVE" || rawStatus === "DISCONNECTED" ? rawStatus : "UNKNOWN",
		subaccounts: subaccounts
			.map((entry) => {
				const sub = asRecord(entry);
				const subId = asString(sub?.id);
				return subId ? { id: subId, name: asString(sub?.name) } : null;
			})
			.filter((entry): entry is { id: string; name: string | null } => entry !== null),
		username: asString(record.username),
	};
}

function parseSubmissionState(value: unknown): BlotatoSubmissionState {
	const record = asRecord(value);
	const status = asString(record?.status)?.toLowerCase();
	if (status === "published") return { publicUrl: asString(record?.publicUrl), state: "PUBLISHED" };
	if (status === "scheduled") return { scheduledTime: asString(record?.scheduledTime), state: "SCHEDULED" };
	if (status === "failed") {
		return { errorMessage: asString(record?.errorMessage) ?? "Blotato reported a failed post", state: "FAILED" };
	}
	if (status === "in-progress") return { state: "IN_PROGRESS" };
	throw new BlotatoApiError(200, "Blotato returned an unrecognized submission status");
}

export function createBlotatoAdapter(config: BlotatoAdapterConfig, fetchFn: typeof fetch): BlotatoAdapter {
	const apiUrl = requireHttpsUrl(config.apiUrl ?? DEFAULT_BLOTATO_API_URL);

	async function request(path: string, init?: RequestInit): Promise<unknown> {
		const response = await fetchFn(`${apiUrl}${path}`, {
			...init,
			headers: {
				"blotato-api-key": config.apiKey,
				"content-type": "application/json",
				...(init?.headers ?? {}),
			},
		});
		if (!response.ok) {
			throw new BlotatoApiError(response.status, `Blotato request to ${path} failed with ${response.status}`);
		}
		return response.json();
	}

	function unwrap(value: unknown): unknown {
		const record = asRecord(value);
		return record && "data" in record ? record.data : value;
	}

	return {
		async createPost(input) {
			if (input.accountId !== config.allowedAccountId) {
				throw new Error("Blotato adapter may only post to its configured account");
			}
			if (input.pageId !== undefined && input.pageId !== config.allowedPageId) {
				throw new Error("Blotato adapter may only post to its configured page");
			}
			const body = unwrap(
				await request(BLOTATO_ROUTES.posts, {
					body: JSON.stringify({
						accountId: input.accountId,
						mediaUrls: input.mediaUrls,
						platform: input.platform,
						scheduledTime: input.scheduledTime,
						text: input.text,
						...(input.pageId ? { pageId: input.pageId } : {}),
					}),
					method: "POST",
				}),
			);
			const submissionId = asString(asRecord(body)?.postSubmissionId);
			if (!submissionId) throw new BlotatoApiError(200, "Blotato did not return a post submission id");
			return { postSubmissionId: submissionId, scheduledTime: asString(asRecord(body)?.scheduledTime) };
		},

		async getPostAnalytics(postId) {
			const body = asRecord(unwrap(await request(BLOTATO_ROUTES.postAnalytics(postId))));
			const metrics = asRecord(body?.metrics);
			return {
				lastError: asString(body?.lastError),
				metrics: metrics
					? Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, String(value)]))
					: null,
			};
		},

		async getSubmissionState(submissionId) {
			return parseSubmissionState(unwrap(await request(BLOTATO_ROUTES.submission(submissionId))));
		},

		async listAccounts() {
			const body = unwrap(await request(BLOTATO_ROUTES.accounts));
			const entries = Array.isArray(body) ? body : [];
			return entries
				.map(parseAccount)
				.filter((account): account is BlotatoAccount => account !== null)
				.filter((account) => account.id === config.allowedAccountId);
		},
	};
}

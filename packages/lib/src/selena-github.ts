/**
 * GitHub, as far as a release needs it: propose a change to one repository as
 * a pull request and report what became of it.
 *
 * The client is pinned to one repository and writes only branches under
 * `selena-lab/`. It has no call that moves the base branch: what reaches the
 * site is decided by the person who merges the pull request, not by the token.
 */

const GITHUB_API_URL = "https://api.github.com";
export const RELEASE_BRANCH_PREFIX = "selena-lab/";

const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

export class GitHubApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "GitHubApiError";
	}
}

export type GitHubRepositoryConfig = {
	baseBranch: string;
	/** `owner/name`. */
	repository: string;
	token: string;
};

export type GitHubPullRequest = {
	merged: boolean;
	number: number;
	state: "open" | "closed";
	url: string;
};

export type GitHubFile = { content: string; path: string };

export type GitHubClient = {
	readonly baseBranch: string;
	readonly repository: string;
	/** Writes one commit on top of the base branch's head to a release branch, creating or resetting it. */
	commitToBranch(input: { branch: string; files: readonly GitHubFile[]; message: string }): Promise<string>;
	createPullRequest(input: { body: string; branch: string; title: string }): Promise<GitHubPullRequest>;
	findPullRequest(branch: string): Promise<GitHubPullRequest | null>;
	getPullRequest(number: number): Promise<GitHubPullRequest>;
	/** The repository as the token sees it, or a GitHubApiError when it cannot. */
	getRepository(): Promise<{ defaultBranch: string; fullName: string }>;
	/** A text file on the base branch, or null when there is none. */
	readFile(path: string): Promise<string | null>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function decodeBase64(value: string): string {
	const binary = atob(value.replace(/\s/g, ""));
	return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

function parsePullRequest(value: unknown): GitHubPullRequest {
	const record = asRecord(value);
	const url = asString(record?.html_url);
	const number = record?.number;
	const state = record?.state;
	if (!url || typeof number !== "number" || (state !== "open" && state !== "closed")) {
		throw new GitHubApiError(200, "GitHub returned a pull request without its number, address or state");
	}
	return { merged: record?.merged === true || asString(record?.merged_at) !== null, number, state, url };
}

function assertReleaseBranch(branch: string, baseBranch: string): void {
	if (!branch.startsWith(RELEASE_BRANCH_PREFIX) || branch === baseBranch || /\.\.|[\s~^:?*[\\]|@\{/.test(branch)) {
		throw new Error(`A release may write only a ${RELEASE_BRANCH_PREFIX} branch`);
	}
}

export function createGitHubClient(config: GitHubRepositoryConfig, fetchFn: typeof fetch): GitHubClient {
	if (!REPOSITORY.test(config.repository)) throw new Error("The repository must be named owner/name");
	if (!config.baseBranch.trim()) throw new Error("The base branch is required");
	const [owner] = config.repository.split("/");
	const repoPath = `/repos/${config.repository}`;

	async function request(path: string, init?: RequestInit & { allow404?: boolean }): Promise<unknown> {
		const response = await fetchFn(`${GITHUB_API_URL}${repoPath}${path}`, {
			...init,
			headers: {
				accept: "application/vnd.github+json",
				authorization: `Bearer ${config.token}`,
				"content-type": "application/json",
				"user-agent": "selena-release-gateway",
				"x-github-api-version": "2022-11-28",
			},
			// The token is sent to api.github.com alone; a redirect would carry it elsewhere.
			redirect: "error",
		});
		if (response.status === 404 && init?.allow404) return null;
		if (!response.ok) {
			let detail = "";
			try {
				detail = asString(asRecord(await response.json())?.message) ?? "";
			} catch {
				// GitHub's error body is a courtesy; the status already says what happened.
			}
			throw new GitHubApiError(
				response.status,
				`GitHub answered ${response.status} to ${init?.method ?? "GET"} ${path.split("?")[0]}${detail ? `: ${detail}` : ""}`,
			);
		}
		return response.status === 204 ? null : response.json();
	}

	async function baseHead(): Promise<string> {
		const ref = asRecord(
			await request(`/git/ref/heads/${config.baseBranch.split("/").map(encodeURIComponent).join("/")}`),
		);
		const sha = asString(asRecord(ref?.object)?.sha);
		if (!sha) throw new GitHubApiError(200, "GitHub returned the base branch without its commit");
		return sha;
	}

	return {
		baseBranch: config.baseBranch,
		repository: config.repository,

		async getRepository() {
			const record = asRecord(await request(""));
			const fullName = asString(record?.full_name);
			const defaultBranch = asString(record?.default_branch);
			if (!fullName || !defaultBranch) throw new GitHubApiError(200, "GitHub returned the repository without its name");
			return { defaultBranch, fullName };
		},

		async readFile(path) {
			const body = asRecord(
				await request(
					`/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(config.baseBranch)}`,
					{
						allow404: true,
					},
				),
			);
			if (!body) return null;
			const content = asString(body.content);
			if (body.type !== "file" || body.encoding !== "base64" || content === null) {
				throw new GitHubApiError(200, `${path} on ${config.baseBranch} is not a readable file`);
			}
			return decodeBase64(content);
		},

		async commitToBranch(input) {
			assertReleaseBranch(input.branch, config.baseBranch);
			const parent = await baseHead();
			const commit = asRecord(await request(`/git/commits/${parent}`));
			const baseTree = asString(asRecord(commit?.tree)?.sha);
			if (!baseTree) throw new GitHubApiError(200, "GitHub returned the base commit without its tree");
			const tree = asString(
				asRecord(
					await request("/git/trees", {
						body: JSON.stringify({
							base_tree: baseTree,
							tree: input.files.map((file) => ({
								content: file.content,
								mode: "100644",
								path: file.path,
								type: "blob",
							})),
						}),
						method: "POST",
					}),
				)?.sha,
			);
			if (!tree) throw new GitHubApiError(200, "GitHub did not return the new tree");
			const sha = asString(
				asRecord(
					await request("/git/commits", {
						body: JSON.stringify({ message: input.message, parents: [parent], tree }),
						method: "POST",
					}),
				)?.sha,
			);
			if (!sha) throw new GitHubApiError(200, "GitHub did not return the new commit");
			try {
				await request("/git/refs", {
					body: JSON.stringify({ ref: `refs/heads/${input.branch}`, sha }),
					method: "POST",
				});
			} catch (error) {
				// The branch is this release's own, left by an attempt that stopped
				// before its pull request; it is reset to the commit just made.
				if (!(error instanceof GitHubApiError) || error.status !== 422) throw error;
				await request(`/git/refs/heads/${input.branch}`, {
					body: JSON.stringify({ force: true, sha }),
					method: "PATCH",
				});
			}
			return sha;
		},

		async findPullRequest(branch) {
			const found = await request(
				`/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(config.baseBranch)}`,
			);
			if (!Array.isArray(found) || found.length === 0) return null;
			return parsePullRequest(found[0]);
		},

		async getPullRequest(number) {
			return parsePullRequest(await request(`/pulls/${number}`));
		},

		async createPullRequest(input) {
			assertReleaseBranch(input.branch, config.baseBranch);
			return parsePullRequest(
				await request("/pulls", {
					body: JSON.stringify({
						base: config.baseBranch,
						body: input.body,
						head: input.branch,
						maintainer_can_modify: false,
						title: input.title,
					}),
					method: "POST",
				}),
			);
		},
	};
}

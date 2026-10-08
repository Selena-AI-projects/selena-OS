import { describe, expect, it } from "vitest";
import type { NormalizedRelease, ReleaseDispatchAuthorization } from "./selena-release-provider";
import { createSelenaLabReleaseProvider, SELENA_LAB_PROVIDER_ID } from "./selena-release-provider-lab";
import { PublishRefusedError } from "./selena-release-publish-policy";

const REPOSITORY = "Selena-AI-projects/SELENA-AI-COMPANY";
const NOW = new Date("2030-01-01T00:00:00.000Z");
const PR_URL = `https://github.com/${REPOSITORY}/pull/154`;
const ENGLISH_ONLY = "data/lab/english-only.json";
const EN_FILE = "data/lab/articles/ai-recommendations-check.en.json";
const RU_FILE = "data/lab/articles/ai-recommendations-check.ru.json";

const ARTICLE = `# Why AI assistants skip a restaurant that ranks on Google

A restaurant can rank first on Google and still be absent from AI answers.

## What the assistants read

They repeat what a few pages already say.

## Sources

- [AI features and your website](https://developers.google.com/search/docs/appearance/ai-features) — Google
`;

const RUSSIAN = `# Почему ИИ не советует ресторан

Ресторан может быть первым в Google и отсутствовать в ответах ИИ.

## Что читают помощники

Они повторяют то, что уже написано на нескольких страницах.
`;

type Pull = { head: string; html_url: string; merged_at: string | null; number: number; state: "open" | "closed" };

const BRANCH = "selena-lab/articles/ai-recommendations-check";
const BRANCH_URL = `https://github.com/${REPOSITORY}/tree/${BRANCH}`;

/** An in-memory site repository behind GitHub's REST paths: branches are snapshots of files. */
function github(
	options: { failOn?: Record<string, number>; files?: Record<string, string | undefined>; pulls?: Pull[] } = {},
) {
	const commits = new Map<string, Record<string, string | undefined>>([
		["base-commit", { [ENGLISH_ONLY]: "[]\n", ...options.files }],
	]);
	const trees = new Map<string, Record<string, string | undefined>>();
	const refs = new Map<string, string>([["main", "base-commit"]]);
	const pulls: Pull[] = [...(options.pulls ?? [])];
	const requests: Array<{ body: unknown; host: string; key: string; redirect?: RequestRedirect }> = [];
	const written: Array<Array<{ content: string; path: string }>> = [];
	const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

	const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		const path = decodeURIComponent(url.pathname.replace(`/repos/${REPOSITORY}`, ""));
		const key = `${method} ${path}`;
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		requests.push({ body, host: url.host, key, redirect: init?.redirect });
		if (new Headers(init?.headers).get("authorization") !== "Bearer site-token")
			return json(401, { message: "Bad credentials" });
		const failure = Object.entries(options.failOn ?? {}).find(([pattern]) => key.startsWith(pattern));
		if (failure) return json(failure[1], { message: "Server Error" });

		if (key === "GET ") return json(200, { default_branch: "main", full_name: REPOSITORY });
		if (method === "GET" && path.startsWith("/git/ref/heads/")) {
			const sha = refs.get(path.slice("/git/ref/heads/".length));
			return sha ? json(200, { object: { sha } }) : json(404, { message: "Not Found" });
		}
		if (method === "GET" && path.startsWith("/git/commits/")) {
			return json(200, { tree: { sha: `tree-of-${path.slice("/git/commits/".length)}` } });
		}
		if (method === "GET" && path.startsWith("/contents/")) {
			const sha = refs.get(url.searchParams.get("ref") ?? "main");
			const content = sha ? commits.get(sha)?.[path.slice("/contents/".length)] : undefined;
			if (content === undefined) return json(404, { message: "Not Found" });
			return json(200, { content: Buffer.from(content, "utf8").toString("base64"), encoding: "base64", type: "file" });
		}
		if (key === "POST /git/trees") {
			const entries = body.tree.map((entry: { content: string; path: string }) => ({
				content: entry.content,
				path: entry.path,
			}));
			written.push(entries);
			const base = commits.get(String(body.base_tree).replace("tree-of-", "")) ?? {};
			const sha = `tree-${written.length}`;
			trees.set(sha, {
				...base,
				...Object.fromEntries(entries.map((entry: { content: string; path: string }) => [entry.path, entry.content])),
			});
			return json(201, { sha });
		}
		if (key === "POST /git/commits") {
			const sha = `commit-${commits.size}`;
			commits.set(sha, trees.get(body.tree) ?? {});
			return json(201, { sha });
		}
		if (key === "POST /git/refs") {
			const ref = body.ref.replace("refs/heads/", "");
			if (refs.has(ref)) return json(422, { message: "Reference already exists" });
			refs.set(ref, body.sha);
			return json(201, {});
		}
		if (method === "PATCH" && path.startsWith("/git/refs/heads/")) {
			refs.set(path.slice("/git/refs/heads/".length), body.sha);
			return json(200, {});
		}
		if (key === "GET /pulls") {
			const head = url.searchParams.get("head")?.split(":")[1];
			return json(200, pulls.filter((pull) => pull.head === head).reverse());
		}
		if (key === "POST /pulls") {
			if (pulls.some((pull) => pull.head === body.head && pull.state === "open"))
				return json(422, { message: "A pull request already exists" });
			const pull: Pull = { head: body.head, html_url: PR_URL, merged_at: null, number: 154, state: "open" };
			pulls.push(pull);
			return json(201, pull);
		}
		if (method === "GET" && path.startsWith("/pulls/")) {
			const pull = pulls.find((entry) => entry.number === Number(path.slice("/pulls/".length)));
			return pull ? json(200, pull) : json(404, { message: "Not Found" });
		}
		throw new Error(`Unexpected GitHub request: ${key}`);
	}) as typeof fetch;

	const filesOn = (branch: string) => commits.get(refs.get(branch) ?? "") ?? {};
	const writes = () => requests.filter((request) => request.key.startsWith("POST") || request.key.startsWith("PATCH"));
	return { fetchFn, filesOn, pulls, refs, requests, writes, written };
}

function release(overrides: Partial<NormalizedRelease> = {}, language = "en", body = ARTICLE): NormalizedRelease {
	return {
		assets: [],
		body,
		brandId: "selena",
		contentHash: "a".repeat(64),
		contentVersionId: "11111111-1111-1111-1111-111111111111",
		ctaUrl: null,
		destination: {
			accountRef: "Selena Lab",
			channelAccountId: "22222222-2222-2222-2222-222222222222",
			externalAccountId: REPOSITORY,
			platform: "website_lab",
		},
		disclosure: {
			language,
			metadata: {
				meta_description:
					"Why a restaurant that ranks on Google can still be missing from AI recommendations, and the three checks that show where it drops out.",
				meta_title: "Missing from AI recommendations",
				slug: "ai-recommendations-check",
			},
		},
		notBefore: "2030-01-01T20:00:00.000Z",
		organizationId: "default",
		releaseIntentId: "33333333-3333-3333-3333-333333333333",
		timezone: "Asia/Makassar",
		...overrides,
	};
}

function authorization(): ReleaseDispatchAuthorization {
	return {
		auditEventId: "44444444-4444-4444-4444-444444444444",
		contentHash: "a".repeat(64),
		environment: "PRODUCTION",
		expiresAt: "2030-01-01T01:00:00.000Z",
		idempotencyKey: "release-idempotency-key",
		killSwitchActive: false,
		manifestHash: "b".repeat(64),
		providerId: SELENA_LAB_PROVIDER_ID,
		signature: "signed-manifest",
		signatureAlgorithm: "Ed25519",
		signingKeyVersion: "v1",
	};
}

function provider(fetchFn: typeof fetch) {
	return createSelenaLabReleaseProvider({ repository: REPOSITORY, token: "site-token" }, fetchFn);
}

async function publish(site: ReturnType<typeof github>, input: NormalizedRelease = release()) {
	const lab = provider(site.fetchFn);
	return lab.dispatch(lab.prepareManifest({ authorization: authorization(), now: NOW, release: input }));
}

describe("Selena Lab release provider", () => {
	it("holds the first edition on the article's branch until the other one arrives", async () => {
		const site = github();
		await expect(publish(site, release({}, "ru", RUSSIAN))).resolves.toEqual({
			outcome: "ACCEPTED",
			providerReferenceId: BRANCH_URL,
		});
		expect(site.pulls).toEqual([]);
		expect(Object.keys(site.filesOn(BRANCH))).toContain(RU_FILE);
		expect(site.refs.get("main")).toBe("base-commit");
	});

	it("opens one pull request with both editions once the second is approved", async () => {
		const site = github();
		await publish(site, release({}, "ru", RUSSIAN));
		await expect(publish(site, release({ releaseIntentId: "55555555-5555-5555-5555-555555555555" }))).resolves.toEqual({
			outcome: "ACCEPTED",
			providerReferenceId: PR_URL,
		});

		const onBranch = site.filesOn(BRANCH);
		expect(onBranch[RU_FILE]).toBeDefined();
		const english = JSON.parse(onBranch[EN_FILE] ?? "{}");
		// The planned date in the release's own time zone, not UTC's.
		expect(english).toMatchObject({ publishedAt: "2030-01-02", slug: "ai-recommendations-check" });
		expect(english.provenance.releaseIntentId).toBe("55555555-5555-5555-5555-555555555555");

		const pullRequest = site.requests.find((request) => request.key === "POST /pulls")?.body as Record<string, string>;
		expect(pullRequest).toMatchObject({ base: "main", head: BRANCH });
		expect(pullRequest.body).toContain("https://www.selenasystems.com/ru/lab/articles/ai-recommendations-check");
		expect(pullRequest.body).toContain("https://www.selenasystems.com/lab/articles/ai-recommendations-check");
		expect(site.refs.get("main")).toBe("base-commit");
		expect(site.writes().every((request) => !request.key.endsWith("heads/main"))).toBe(true);
		expect(site.requests.every((request) => request.host === "api.github.com" && request.redirect === "error")).toBe(
			true,
		);
		// The site's own list of untranslated hand-written articles is never touched.
		expect(site.written.flat().some((file) => file.path === ENGLISH_ONLY)).toBe(false);
	});

	it("revises one edition alone when the pair is already on the site, keeping its first date", async () => {
		const previous = `${JSON.stringify({ publishedAt: "2029-11-05", slug: "ai-recommendations-check" })}\n`;
		const site = github({ files: { [EN_FILE]: previous, [RU_FILE]: "{}\n" } });
		await expect(publish(site)).resolves.toEqual({ outcome: "ACCEPTED", providerReferenceId: PR_URL });
		expect(site.written).toHaveLength(1);
		expect(site.written[0].map((file) => file.path)).toEqual([EN_FILE]);
		expect(JSON.parse(site.written[0][0].content)).toMatchObject({
			publishedAt: "2029-11-05",
			updatedAt: "2030-01-02",
		});
	});

	it("answers a repeated release with the pull request already open, writing nothing again", async () => {
		const site = github();
		await publish(site, release({}, "ru", RUSSIAN));
		await publish(site);
		const writes = site.writes().length;
		await expect(publish(site)).resolves.toEqual({ outcome: "ACCEPTED", providerReferenceId: PR_URL });
		expect(site.writes()).toHaveLength(writes);
	});

	it("starts the branch again when an earlier pull request for the article is over", async () => {
		const site = github({
			pulls: [{ head: BRANCH, html_url: PR_URL, merged_at: "2029-12-01T00:00:00Z", number: 120, state: "closed" }],
		});
		site.refs.set(BRANCH, "base-commit");
		await expect(publish(site, release({}, "ru", RUSSIAN))).resolves.toEqual({
			outcome: "ACCEPTED",
			providerReferenceId: BRANCH_URL,
		});
		expect(site.requests.some((request) => request.key === `PATCH /git/refs/heads/${BRANCH}`)).toBe(true);
	});

	it("refuses to write to a site that does not read Lab files yet", async () => {
		const site = github({ files: { [ENGLISH_ONLY]: undefined } });
		await expect(publish(site)).resolves.toMatchObject({
			outcome: "DEFINITIVE_FAILURE",
			reason: expect.stringContaining("does not read Lab files yet"),
		});
		expect(site.writes()).toEqual([]);
	});

	it("calls a failure before the pull request definitive and a lost answer to it ambiguous", async () => {
		await expect(publish(github({ failOn: { "POST /git/trees": 500 } }))).resolves.toMatchObject({
			outcome: "DEFINITIVE_FAILURE",
			reason: expect.stringContaining("Nothing was opened for the owner to merge"),
		});
		const pair = { [RU_FILE]: "{}\n", [EN_FILE]: "{}\n" };
		await expect(publish(github({ failOn: { "POST /pulls": 502 }, files: pair }))).resolves.toMatchObject({
			outcome: "AMBIGUOUS",
		});
		await expect(publish(github({ failOn: { "POST /pulls": 403 }, files: pair }))).resolves.toMatchObject({
			outcome: "DEFINITIVE_FAILURE",
		});
	});

	it("will not shape a release for another repository, with media, or that the page cannot show", () => {
		const lab = provider(github().fetchFn);
		const prepare = (input: NormalizedRelease) =>
			lab.prepareManifest({ authorization: authorization(), now: NOW, release: input });
		expect(() =>
			prepare(release({ destination: { ...release().destination, externalAccountId: "someone/else" } })),
		).toThrow(/bound to someone\/else/);
		expect(() =>
			prepare(
				release({ assets: [{ assetId: "a", mimeType: "image/png", sha256: "c".repeat(64), sourceUrl: "https://x" }] }),
			),
		).toThrow(/media/);
		expect(() => prepare(release({}, "en", `${ARTICLE}\n| a | b |\n`))).toThrow(/Tables/);
		expect(() => prepare(release({ destination: { ...release().destination, platform: "linkedin_page" } }))).toThrow(
			"PLATFORM_UNSUPPORTED",
		);
	});

	it("reaches nothing until it is handed a live transport", async () => {
		const lab = createSelenaLabReleaseProvider({ repository: REPOSITORY, token: "site-token" });
		const prepared = lab.prepareManifest({ authorization: authorization(), now: NOW, release: release() });
		await expect(lab.dispatch(prepared)).rejects.toBeInstanceOf(PublishRefusedError);
		await expect(lab.validateConnection()).resolves.toMatchObject({ state: "MISCONFIGURED" });
	});

	it("reports the site as connected only when the token reaches it and the site reads Lab files", async () => {
		await expect(provider(github().fetchFn).validateConnection()).resolves.toMatchObject({
			account: { externalAccountId: REPOSITORY, platform: "website_lab" },
			state: "CONNECTED",
		});
		const unprepared = github();
		await expect(
			createSelenaLabReleaseProvider(
				{ repository: REPOSITORY, token: "wrong-token" },
				unprepared.fetchFn,
			).validateConnection(),
		).resolves.toMatchObject({ reason: expect.stringContaining("Bad credentials"), state: "MISCONFIGURED" });
	});

	it("reads a pull request's fate back as the release's status", async () => {
		const site = github({
			pulls: [{ head: "x", html_url: PR_URL, merged_at: "2030-01-02T00:00:00Z", number: 154, state: "closed" }],
		});
		const lab = provider(site.fetchFn);
		const window = { end: "2030-01-03T00:00:00Z", start: "2030-01-02T00:00:00Z" };
		await expect(lab.getStatus({ providerReferenceId: PR_URL, window })).resolves.toMatchObject({ state: "SCHEDULED" });
		await expect(
			lab.getStatus({ providerReferenceId: `https://github.com/${REPOSITORY}/pull/999`, window }),
		).resolves.toMatchObject({ state: "NOT_FOUND" });
	});
});

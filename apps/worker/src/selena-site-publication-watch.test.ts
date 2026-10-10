import type { GitHubClient, GitHubPullRequest } from "@workspace/lib/selena-github";
import { SELENA_PUBLICATION_PACKAGE_VERSION } from "@workspace/lib/selena-release-gateway";
import { describe, expect, it } from "vitest";
import {
	type PendingSitePublication,
	type SitePublicationResult,
	watchSitePublications,
} from "./selena-site-publication-watch";

const BRANCH = "selena-lab/articles/ai-recommendations-check";
const RU_PATH = "data/lab/articles/ai-recommendations-check.ru.json";
const ACCEPTED_AT = "2026-10-10T08:00:00.000Z";

function pending(overrides: Partial<PendingSitePublication> = {}, language = "ru"): PendingSitePublication {
	return {
		accepted_at: ACCEPTED_AT,
		manifest: {
			approval: { approvalId: "66666666-6666-6666-6666-666666666666" },
			assets: [],
			brandId: "selena",
			content: {
				body: "# Article",
				contentHash: "a".repeat(64),
				contentVersionId: "11111111-1111-1111-1111-111111111111",
				disclosure: { language, metadata: { slug: "ai-recommendations-check" } },
			},
			destination: {
				accountRef: "Selena Lab",
				channelAccountId: "22222222-2222-2222-2222-222222222222",
				integrationId: "Selena-AI-projects/SELENA-AI-COMPANY",
				platform: "website_lab",
			},
			organizationId: "default",
			releaseIntentId: "33333333-3333-3333-3333-333333333333",
			schedule: { notBefore: "2026-10-10T07:00:00.000Z", timezone: "UTC" },
			schemaVersion: SELENA_PUBLICATION_PACKAGE_VERSION,
		},
		manifest_hash: "m1",
		provider_reference_id: `https://github.com/Selena-AI-projects/SELENA-AI-COMPANY/tree/${BRANCH}`,
		release_manifest_id: "77777777-7777-7777-7777-777777777777",
		reservation_id: "88888888-8888-8888-8888-888888888888",
		...overrides,
	};
}

function edition(manifestHash: string): string {
	return `${JSON.stringify({ provenance: { manifestHash }, slug: "ai-recommendations-check" }, null, 2)}\n`;
}

function site(state: { files?: Record<string, string>; pullRequest?: Partial<GitHubPullRequest> | null }) {
	const branchesAsked: string[] = [];
	const client = {
		baseBranch: "main",
		repository: "Selena-AI-projects/SELENA-AI-COMPANY",
		async findPullRequest(branch: string) {
			branchesAsked.push(branch);
			if (!state.pullRequest) return null;
			return {
				closedAt: null,
				merged: false,
				number: 7,
				state: "open",
				url: "https://github.com/Selena-AI-projects/SELENA-AI-COMPANY/pull/7",
				...state.pullRequest,
			} as GitHubPullRequest;
		},
		async readFile(path: string, ref?: string) {
			if (ref && ref !== "main") throw new Error("the watch reads the base branch only");
			return state.files?.[path] ?? null;
		},
	} as unknown as GitHubClient;
	return { branchesAsked, client };
}

async function settle(client: GitHubClient, releases: PendingSitePublication[]) {
	const recorded: Array<{ outcome: SitePublicationResult; reservation: string }> = [];
	const logged: string[] = [];
	const summary = await watchSitePublications({
		client,
		ledger: {
			listPending: async () => releases,
			record: async (release, outcome) => {
				recorded.push({ outcome, reservation: release.reservation_id });
			},
		},
		log: (message) => logged.push(message),
	});
	return { logged, recorded, summary };
}

describe("watchSitePublications", () => {
	it("reports the public page once the approved edition is on the site", async () => {
		const { client } = site({ files: { [RU_PATH]: edition("m1") }, pullRequest: { merged: true, state: "closed" } });
		const { recorded } = await settle(client, [pending()]);
		expect(recorded).toEqual([
			{
				outcome: {
					reference: "https://www.selenasystems.com/ru/lab/articles/ai-recommendations-check",
					result: "PUBLISHED",
				},
				reservation: "88888888-8888-8888-8888-888888888888",
			},
		]);
	});

	it("gives the English edition its English page", async () => {
		const { client } = site({ files: { "data/lab/articles/ai-recommendations-check.en.json": edition("m1") } });
		const { recorded } = await settle(client, [pending({}, "en-US")]);
		expect(recorded[0]?.outcome).toEqual({
			reference: "https://www.selenasystems.com/lab/articles/ai-recommendations-check",
			result: "PUBLISHED",
		});
	});

	it("keeps waiting while the pull request is open or the other language has not arrived", async () => {
		for (const pullRequest of [{ state: "open" as const }, null]) {
			const { client } = site({ pullRequest });
			const { recorded, summary } = await settle(client, [pending()]);
			expect(recorded).toEqual([]);
			expect(summary).toEqual({ checked: 1, settled: 0 });
		}
	});

	it("tells the author when the owner closed the pull request without merging", async () => {
		const { branchesAsked, client } = site({
			pullRequest: { closedAt: "2026-10-10T09:00:00Z", merged: false, state: "closed" },
		});
		const { recorded } = await settle(client, [pending()]);
		expect(branchesAsked).toEqual([BRANCH]);
		expect(recorded[0]?.outcome).toEqual({ result: "CLOSED" });
	});

	it("does not call an edition published when a later approved version of it was merged instead", async () => {
		const { client } = site({
			files: { [RU_PATH]: edition("m2") },
			pullRequest: { closedAt: "2026-10-10T09:00:00Z", merged: true, state: "closed" },
		});
		const { recorded } = await settle(client, [pending()]);
		expect(recorded[0]?.outcome).toEqual({ result: "SUPERSEDED" });
	});

	it("does not judge an edition by a pull request that ended before it reached the branch", async () => {
		const { client } = site({
			files: { [RU_PATH]: edition("m0") },
			pullRequest: { closedAt: "2026-10-01T09:00:00Z", merged: true, state: "closed" },
		});
		const { recorded } = await settle(client, [pending()]);
		expect(recorded).toEqual([]);
	});

	it("leaves a release it cannot check for the next round without holding up the others", async () => {
		const { client } = site({ files: { [RU_PATH]: edition("m1") } });
		const broken = pending({ manifest: { schemaVersion: "other/v1" }, reservation_id: "broken" });
		const { logged, recorded, summary } = await settle(client, [broken, pending()]);
		expect(recorded.map((entry) => entry.reservation)).toEqual(["88888888-8888-8888-8888-888888888888"]);
		expect(summary).toEqual({ checked: 2, settled: 1 });
		expect(logged).toHaveLength(1);
		expect(logged[0]).toContain("broken");
	});
});

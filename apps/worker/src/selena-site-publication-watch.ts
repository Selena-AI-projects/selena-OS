import type { GitHubClient } from "@workspace/lib/selena-github";
import { RELEASE_BRANCH_PREFIX } from "@workspace/lib/selena-github";
import { labEditionOf } from "@workspace/lib/selena-lab-article";
import { toNormalizedRelease } from "@workspace/lib/selena-release-provider";
import { SELENA_LAB_SITE_URL } from "@workspace/lib/selena-release-provider-lab";

/** How often the gateway asks GitHub what became of the site's pull requests. */
export const SITE_PUBLICATION_WATCH_INTERVAL_MS = 10 * 60 * 1000;
const PENDING_PER_ROUND = 50;

export type PendingSitePublication = {
	accepted_at: Date | string;
	manifest: unknown;
	manifest_hash: string;
	provider_reference_id: string | null;
	release_manifest_id: string;
	reservation_id: string;
};

export type SitePublicationResult =
	| { reference: string; result: "PUBLISHED" }
	| { result: "CLOSED" }
	| { result: "SUPERSEDED" };

export type SitePublicationLedger = {
	listPending(limit: number): Promise<PendingSitePublication[]>;
	record(pending: PendingSitePublication, outcome: SitePublicationResult): Promise<void>;
};

function manifestHashOn(content: string | null): string | null {
	if (content === null) return null;
	try {
		const provenance = (JSON.parse(content) as { provenance?: { manifestHash?: unknown } }).provenance;
		return typeof provenance?.manifestHash === "string" ? provenance.manifestHash : null;
	} catch {
		return null;
	}
}

/**
 * What became of one accepted site release, or null while it still waits on the
 * owner (or on the other language edition).
 *
 * The site's base branch is the truth: the edition is published when the file
 * there carries this release's signed manifest hash. The pull request only
 * says how a release that is not there ended.
 */
export async function siteOutcomeOf(
	client: GitHubClient,
	pending: PendingSitePublication,
): Promise<SitePublicationResult | null> {
	const edition = labEditionOf(toNormalizedRelease(pending.manifest).disclosure);
	if (!edition) throw new Error("The release does not name a Selena Lab edition");
	if (manifestHashOn(await client.readFile(edition.path)) === pending.manifest_hash) {
		return { reference: `${SELENA_LAB_SITE_URL}${edition.labPath}`, result: "PUBLISHED" };
	}
	const pullRequest = await client.findPullRequest(`${RELEASE_BRANCH_PREFIX}articles/${edition.slug}`);
	if (!pullRequest || pullRequest.state === "open" || !pullRequest.closedAt) return null;
	// A pull request that ended before this edition reached the branch belongs to
	// an earlier publication of the same article; this one has not been opened.
	if (Date.parse(pullRequest.closedAt) < new Date(pending.accepted_at).getTime()) return null;
	return { result: pullRequest.merged ? "SUPERSEDED" : "CLOSED" };
}

/**
 * One round: settle every accepted site release whose pull request has ended.
 * A release that cannot be checked now is left for the next round rather than
 * guessed at, and does not hold up the others.
 */
export async function watchSitePublications(input: {
	client: GitHubClient;
	ledger: SitePublicationLedger;
	log?: (message: string) => void;
}): Promise<{ checked: number; settled: number }> {
	const log = input.log ?? ((message: string) => console.error(message));
	const pending = await input.ledger.listPending(PENDING_PER_ROUND);
	let settled = 0;
	for (const release of pending) {
		try {
			const outcome = await siteOutcomeOf(input.client, release);
			if (!outcome) continue;
			await input.ledger.record(release, outcome);
			settled += 1;
		} catch (error) {
			log(
				`Site publication ${release.reservation_id} was not checked: ${error instanceof Error ? error.message : "unknown error"}`,
			);
		}
	}
	return { checked: pending.length, settled };
}

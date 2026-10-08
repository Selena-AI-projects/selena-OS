import { createGitHubClient, GitHubApiError, type GitHubClient, RELEASE_BRANCH_PREFIX } from "./selena-github";
import { asRevisionOf, type LabArticleFile, labArticleFile } from "./selena-lab-article";
import {
	assertReleaseDispatchInvariants,
	assertSupportedPlatform,
	type NormalizedRelease,
	type PreparedRelease,
	preparedReleaseHash,
	type ReleaseConnectionState,
	type ReleaseDispatchOutcome,
	type ReleaseProviderAccount,
	type ReleaseProviderAdapter,
	type ReleaseProviderCapabilities,
	type ReleaseStatus,
} from "./selena-release-provider";
import { disarmedFetch, rethrowIfRefused } from "./selena-release-publish-policy";

export const SELENA_LAB_PROVIDER_ID = "selena_lab";
export const SELENA_LAB_PLATFORM = "website_lab";

const SITE_URL = "https://www.selenasystems.com";
const ENGLISH_ONLY_PATH = "data/lab/english-only.json";

const CAPABILITIES: ReleaseProviderCapabilities = {
	cancellation: false,
	mediaMimeTypes: [],
	metrics: false,
	platforms: [SELENA_LAB_PLATFORM],
	providerId: SELENA_LAB_PROVIDER_ID,
	// A pull request is opened at once; the article goes out when it is merged.
	scheduling: "IMMEDIATE_AND_SCHEDULE",
};

export type SelenaLabConfig = {
	baseBranch?: string;
	/** `owner/name` of the site repository. */
	repository: string;
	token: string;
};

type LabReleasePayload = {
	branch: string;
	commitMessage: string;
	file: LabArticleFile;
	pullRequest: { body: string; title: string };
	repository: string;
};

function calendarDate(instant: string, timezone: string): string {
	const date = new Date(instant);
	try {
		return new Intl.DateTimeFormat("en-CA", {
			day: "2-digit",
			month: "2-digit",
			timeZone: timezone,
			year: "numeric",
		}).format(date);
	} catch {
		return date.toISOString().slice(0, 10);
	}
}

function account(repository: string): ReleaseProviderAccount {
	return {
		accountRef: "Selena Lab",
		displayName: "Selena Lab · selenasystems.com",
		externalAccountId: repository,
		organizationRef: repository.split("/")[0] ?? null,
		platform: SELENA_LAB_PLATFORM,
		status: "ACTIVE",
	};
}

function otherEditionPath(file: LabArticleFile): string {
	return `data/lab/articles/${file.slug}.${file.locale === "ru" ? "en" : "ru"}.json`;
}

function pullRequestBody(release: NormalizedRelease, file: LabArticleFile, manifestHash: string): string {
	const russianPath = file.labPath.startsWith("/ru/") ? file.labPath : `/ru${file.labPath}`;
	const englishPath = russianPath.replace(/^\/ru/, "");
	return [
		"Статья из Control Room, одобренная владельцем, в двух языковых версиях.",
		"",
		`- Русская версия: ${SITE_URL}${russianPath}`,
		`- Английская версия: ${SITE_URL}${englishPath}`,
		`- Последней одобрена версия \`${release.contentVersionId}\` (${file.locale}), подписанный выпуск \`${manifestHash}\``,
		"",
		"Слияние публикует обе версии: сайт выкладывается из `main` сразу.",
		"",
		"Файлы собраны из одобренных текстов. Правка руками разойдётся с одобренной версией — если",
		"нужна правка, исправьте материал и одобрите его заново.",
	].join("\n");
}

function asLabPayload(payload: unknown): LabReleasePayload {
	const record = payload as Partial<LabReleasePayload> | null;
	if (
		!record ||
		typeof record.branch !== "string" ||
		typeof record.commitMessage !== "string" ||
		typeof record.repository !== "string" ||
		!record.file ||
		typeof record.file.content !== "string" ||
		!record.pullRequest
	) {
		throw new Error("Prepared release was not shaped by the Selena Lab adapter");
	}
	return record as LabReleasePayload;
}

function isDecided(error: unknown): boolean {
	return (
		error instanceof GitHubApiError &&
		error.status >= 400 &&
		error.status < 500 &&
		error.status !== 408 &&
		error.status !== 429
	);
}

function reasonOf(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Where the article's branch stands: still collecting editions, already under
 * review, or left from a publication that is over and must start again.
 */
async function branchState(client: GitHubClient, branch: string) {
	const pullRequest = await client.findPullRequest(branch);
	if (pullRequest?.state === "open") return { extend: true, pullRequest } as const;
	return { extend: pullRequest === null, pullRequest: null } as const;
}

/**
 * Selena Lab, the articles section of selenasystems.com, as a release channel.
 *
 * The site publishes an article only in both languages (owner decision of
 * 08.10.2026: Russian primary, English required), and each edition is its own
 * approved release. So each release adds its edition as a data file to one
 * branch per article, and the pull request opens once both editions are on
 * it. Either step is what the provider reports as ACCEPTED — the reference is
 * the branch while it waits for the other edition, then the pull request. The
 * article is public only once the owner merges it, because the site deploys
 * from its main branch; nothing in this adapter can write to the main branch.
 *
 * Like the other adapters, the transport defaults to `disarmedFetch()`.
 */
export function createSelenaLabReleaseProvider(
	config: SelenaLabConfig,
	fetchFn: typeof fetch = disarmedFetch(),
	client: GitHubClient = createGitHubClient(
		{ baseBranch: config.baseBranch ?? "main", repository: config.repository, token: config.token },
		fetchFn,
	),
): ReleaseProviderAdapter {
	async function validateConnection(): Promise<ReleaseConnectionState> {
		try {
			const repository = await client.getRepository();
			if (repository.fullName.toLowerCase() !== config.repository.toLowerCase()) {
				return { reason: `The token reaches ${repository.fullName}, not ${config.repository}`, state: "MISCONFIGURED" };
			}
			if ((await client.readFile(ENGLISH_ONLY_PATH)) === null) {
				return {
					reason: `The site on ${client.baseBranch} does not read Lab files yet: ${ENGLISH_ONLY_PATH} is missing`,
					state: "MISCONFIGURED",
				};
			}
			return { account: account(config.repository), state: "CONNECTED" };
		} catch (error) {
			if (error instanceof GitHubApiError && error.status === 404) return { state: "NOT_CONNECTED" };
			return { reason: reasonOf(error, "GitHub connection check failed"), state: "MISCONFIGURED" };
		}
	}

	return {
		providerId: SELENA_LAB_PROVIDER_ID,

		capabilities() {
			return CAPABILITIES;
		},

		validateConnection,

		async listAccounts() {
			const connection = await validateConnection();
			return connection.state === "CONNECTED" ? [connection.account] : [];
		},

		prepareManifest(input): PreparedRelease {
			const now = input.now ?? new Date();
			assertReleaseDispatchInvariants({ ...input, now, providerId: SELENA_LAB_PROVIDER_ID });
			assertSupportedPlatform(CAPABILITIES, input.release.destination.platform);
			const { release } = input;
			if (release.destination.externalAccountId.toLowerCase() !== config.repository.toLowerCase()) {
				throw new Error(
					`This release is bound to ${release.destination.externalAccountId}; the site provider writes to ${config.repository}`,
				);
			}
			if (release.assets.length > 0) throw new Error("A Selena Lab article cannot carry attached media yet");
			const file = labArticleFile({
				body: release.body,
				disclosure: release.disclosure,
				provenance: {
					contentHash: release.contentHash,
					contentVersionId: release.contentVersionId,
					manifestHash: input.authorization.manifestHash,
					releaseIntentId: release.releaseIntentId,
				},
				publishedOn: calendarDate(release.notBefore, release.timezone),
			});
			const payload: LabReleasePayload = {
				branch: `${RELEASE_BRANCH_PREFIX}articles/${file.slug}`,
				commitMessage: `Publish the Lab article ${file.slug} (${file.locale})\n\nRelease intent ${release.releaseIntentId}, content version ${release.contentVersionId}.`,
				file,
				pullRequest: {
					body: pullRequestBody(release, file, input.authorization.manifestHash),
					title: `Selena Lab: ${file.slug} (RU + EN)`,
				},
				repository: config.repository,
			};
			return {
				environment: input.authorization.environment,
				externalAccountId: release.destination.externalAccountId,
				idempotencyKey: input.authorization.idempotencyKey,
				manifestHash: input.authorization.manifestHash,
				notBefore: release.notBefore,
				payload,
				payloadHash: preparedReleaseHash(payload),
				providerId: SELENA_LAB_PROVIDER_ID,
			};
		},

		async dispatch(prepared): Promise<ReleaseDispatchOutcome> {
			const payload = asLabPayload(prepared.payload);
			if (payload.repository.toLowerCase() !== client.repository.toLowerCase()) {
				return { outcome: "DEFINITIVE_FAILURE", reason: "The prepared release names another repository" };
			}
			// Everything before the pull request is invisible to the site: a branch
			// alone publishes nothing, so a failure up to here is definitive.
			let state: Awaited<ReturnType<typeof branchState>>;
			try {
				if ((await client.readFile(ENGLISH_ONLY_PATH)) === null) {
					return {
						outcome: "DEFINITIVE_FAILURE",
						reason: `The site on ${client.baseBranch} does not read Lab files yet: ${ENGLISH_ONLY_PATH} is missing`,
					};
				}
				state = await branchState(client, payload.branch);
				const previous = await client.readFile(payload.file.path);
				const file = previous === null ? payload.file : asRevisionOf(payload.file, previous);
				if (previous === file.content) {
					return { outcome: "DEFINITIVE_FAILURE", reason: "The site already has this edition exactly as approved" };
				}
				const onBranch = state.extend ? await client.readFile(file.path, payload.branch) : null;
				if (onBranch !== file.content) {
					await client.commitToBranch({
						branch: payload.branch,
						extend: state.extend,
						files: [{ content: file.content, path: file.path }],
						message: payload.commitMessage,
					});
				}
				// The site takes an article only with both editions, so the pull
				// request waits until the other one is on the branch.
				if ((await client.readFile(otherEditionPath(file), payload.branch)) === null) {
					return {
						outcome: "ACCEPTED",
						providerReferenceId: `https://github.com/${client.repository}/tree/${payload.branch}`,
					};
				}
				if (state.pullRequest) return { outcome: "ACCEPTED", providerReferenceId: state.pullRequest.url };
			} catch (error) {
				rethrowIfRefused(error);
				return {
					outcome: "DEFINITIVE_FAILURE",
					reason: `Nothing was opened for the owner to merge: ${reasonOf(error, "GitHub request failed")}`,
				};
			}
			try {
				const pullRequest = await client.createPullRequest({
					body: payload.pullRequest.body,
					branch: payload.branch,
					title: payload.pullRequest.title,
				});
				return { outcome: "ACCEPTED", providerReferenceId: pullRequest.url };
			} catch (error) {
				rethrowIfRefused(error);
				if (error instanceof GitHubApiError && error.status === 422) {
					// GitHub refuses a second pull request for a branch that has one.
					const existing = await client.findPullRequest(payload.branch).catch(() => null);
					if (existing?.state === "open") return { outcome: "ACCEPTED", providerReferenceId: existing.url };
				}
				// A refusal GitHub decided left no pull request; anything else may have.
				return isDecided(error)
					? { outcome: "DEFINITIVE_FAILURE", reason: reasonOf(error, "GitHub refused the pull request") }
					: { outcome: "AMBIGUOUS", reason: reasonOf(error, "The pull request may or may not have been opened") };
			}
		},

		async getStatus(input): Promise<ReleaseStatus> {
			const number = Number(/\/pull\/(\d+)$/.exec(input.providerReferenceId)?.[1]);
			if (!Number.isInteger(number) || number <= 0) {
				return {
					providerReferenceId: input.providerReferenceId,
					reason: "Not a pull request address",
					state: "UNKNOWN",
				};
			}
			try {
				const pullRequest = await client.getPullRequest(number);
				if (pullRequest.state === "open" || pullRequest.merged) {
					return { providerReferenceId: input.providerReferenceId, state: "SCHEDULED" };
				}
				return {
					providerReferenceId: input.providerReferenceId,
					reason: "The pull request was closed without merging",
					state: "UNKNOWN",
				};
			} catch (error) {
				if (error instanceof GitHubApiError && error.status === 404) {
					return { providerReferenceId: input.providerReferenceId, state: "NOT_FOUND" };
				}
				return {
					providerReferenceId: input.providerReferenceId,
					reason: reasonOf(error, "GitHub status lookup failed"),
					state: "UNKNOWN",
				};
			}
		},

		async ingestMetrics() {
			throw new Error("Selena Lab reports no metrics; a page's readers are measured by the site's analytics");
		},
	};
}

import {
	createGitHubClient,
	GitHubApiError,
	type GitHubClient,
	type GitHubFile,
	RELEASE_BRANCH_PREFIX,
} from "./selena-github";
import { asRevisionOf, englishOnlyAfter, type LabArticleFile, labArticleFile } from "./selena-lab-article";
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

function pullRequestBody(release: NormalizedRelease, file: LabArticleFile, manifestHash: string): string {
	const language = file.locale === "en" ? "английская версия" : "русская версия";
	return [
		"Статья из Control Room, одобренная владельцем.",
		"",
		`- Страница после слияния: ${SITE_URL}${file.labPath}`,
		`- Язык: ${language}`,
		`- Плановая дата: ${release.notBefore} (${release.timezone})`,
		`- Версия материала: \`${release.contentVersionId}\`, хеш \`${release.contentHash}\``,
		`- Подписанный выпуск: \`${manifestHash}\``,
		"",
		"Слияние публикует статью: сайт выкладывается из `main` сразу.",
		"",
		"Файл собран из одобренного текста. Правка руками разойдётся с одобренной версией — если",
		"нужна правка, исправьте материал и одобрите его заново: откроется новый pull request.",
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

/** The files the pull request changes, or a refusal when the site cannot take this edition. */
async function filesFor(client: GitHubClient, prepared: LabArticleFile): Promise<GitHubFile[] | { refusal: string }> {
	const englishOnlyRaw = await client.readFile(ENGLISH_ONLY_PATH);
	if (englishOnlyRaw === null) {
		return { refusal: `The site on ${client.baseBranch} does not read Lab files yet: ${ENGLISH_ONLY_PATH} is missing` };
	}
	const englishOnly: unknown = JSON.parse(englishOnlyRaw);
	if (!Array.isArray(englishOnly) || englishOnly.some((entry) => typeof entry !== "string")) {
		return { refusal: `${ENGLISH_ONLY_PATH} on ${client.baseBranch} is not a list of page addresses` };
	}
	const previous = await client.readFile(prepared.path);
	const file = previous === null ? prepared : asRevisionOf(prepared, previous);
	if (previous === file.content) return { refusal: "The site already has this article exactly as approved" };

	const englishPath = `/lab/articles/${prepared.slug}`;
	if (prepared.locale === "ru" && previous === null) {
		const englishFile = await client.readFile(`data/lab/articles/${prepared.slug}.en.json`);
		if (englishFile === null && !englishOnly.includes(englishPath)) {
			return {
				refusal: `The Russian edition goes out after its English article, and ${englishPath} is not on the site waiting for one`,
			};
		}
	}
	const russianEditionExists =
		prepared.locale === "en" && (await client.readFile(`data/lab/articles/${prepared.slug}.ru.json`)) !== null;
	const nextEnglishOnly = englishOnlyAfter(englishOnly as string[], file, russianEditionExists);
	const listChanged =
		nextEnglishOnly.length !== englishOnly.length || nextEnglishOnly.some((entry) => !englishOnly.includes(entry));
	const article = { content: file.content, path: file.path };
	return listChanged
		? [article, { content: `${JSON.stringify(nextEnglishOnly, null, 2)}\n`, path: ENGLISH_ONLY_PATH }]
		: [article];
}

/**
 * Selena Lab, the articles section of selenasystems.com, as a release channel.
 *
 * A release here opens a pull request in the site repository that adds the
 * article as a data file. Opening it is what the provider reports as
 * ACCEPTED; the article is public only once the owner merges it, because the
 * site deploys from its main branch. So the provider proposes and the owner
 * publishes, and nothing in this adapter can write to the main branch.
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
				branch: `${RELEASE_BRANCH_PREFIX}articles/${file.slug}-${file.locale}-${release.releaseIntentId.slice(0, 8)}`,
				commitMessage: `Publish the Lab article ${file.slug} (${file.locale})\n\nRelease intent ${release.releaseIntentId}, content version ${release.contentVersionId}.`,
				file,
				pullRequest: {
					body: pullRequestBody(release, file, input.authorization.manifestHash),
					title: `Selena Lab: ${file.title} (${file.locale.toUpperCase()})`,
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
			try {
				const existing = await client.findPullRequest(payload.branch);
				if (existing) {
					return existing.state === "open" || existing.merged
						? { outcome: "ACCEPTED", providerReferenceId: existing.url }
						: {
								outcome: "DEFINITIVE_FAILURE",
								reason: `The pull request for this release was closed without merging: ${existing.url}`,
							};
				}
				const files = await filesFor(client, payload.file);
				if ("refusal" in files) return { outcome: "DEFINITIVE_FAILURE", reason: files.refusal };
				await client.commitToBranch({
					branch: payload.branch,
					files: files.map((file) => ({ content: file.content, path: file.path })),
					message: payload.commitMessage,
				});
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

import { randomUUID } from "node:crypto";
import {
	evidenceSnapshot,
	renderReadableBody,
	STRUCTURED_FORMAT_VERSION,
	type YouTubeVideoDocument,
} from "@workspace/content-workflow/content-document";
import {
	buildConceptDocument,
	buildEvidenceContext,
	buildScriptDocument,
	buildScriptEvidenceContext,
	ContentCreationError,
	CREATION_VERSIONS,
	type CreationAdapter,
	type CreationErrorCode,
	type EvidenceClaim,
	FixtureCreationAdapter,
	type GeminiAdapterGates,
	GeminiCreationAdapter,
	type IdeaPackage,
	ProviderCallLedger,
	type ResearchEvidenceContext,
	runIdeaGeneration,
	runScriptGeneration,
} from "@workspace/content-workflow/creation";
import type { NormalizedProjectProfile } from "@workspace/content-workflow/profile";
import type { ResearchOpportunity } from "@workspace/content-workflow/research";
import { and, desc, eq, max } from "drizzle-orm";
import {
	appendContentAudit,
	type ContentAuthContext,
	type ContentTransaction,
	withBrandRequestContext,
} from "./content-workflow-repositories";
import { selenaWebDb as db } from "./db/db";
import {
	scrBrandContentProfileDecisions,
	scrBrandContentProfileVersions,
	scrContentChannels,
	scrContentItems,
	scrContentResearchOpportunities,
	scrContentResearchOpportunityDecisions,
	scrContentResearchSources,
	scrContentVersions,
	scrGenerationRuns,
} from "./db/schema";
import { contentWorkflowV2Hash, sha256 } from "./selena-control-room";

const AGGREGATE_TYPE = "content_creation";
const POLICY_VERSION = "brand-pack/v1";
const PROMPT_VERSION = "fixture/v1";

type GenerationRunRow = typeof scrGenerationRuns.$inferSelect;
type ContentItemRow = typeof scrContentItems.$inferSelect;
type ContentVersionRow = typeof scrContentVersions.$inferSelect;

function assertWritable(context: ContentAuthContext): void {
	if (context.authType !== "session" || !["owner", "member"].includes(context.role)) {
		throw new Error("Forbidden: owner or member access required");
	}
}

/**
 * Live Gemini gates, read fail-closed from the environment and separate from
 * research's. Two adapters that share one flag cannot be enabled independently,
 * and "turn on ideas but not radar" is exactly the decision an owner should be
 * able to make one at a time.
 *
 * The credential itself is never read: only a separate boolean states that one
 * exists. Stage 1 also injects no dispatcher, so the adapter refuses even when
 * every gate below is somehow open.
 */
function geminiGates(env: NodeJS.ProcessEnv = process.env): GeminiAdapterGates {
	const ceiling = Number.parseInt(env.CONTENT_OS_GEMINI_MAX_CALLS ?? "", 10);
	return {
		liveProviderEnabled: env.CONTENT_OS_GEMINI_LIVE === "true",
		maxProviderCalls: Number.isFinite(ceiling) && ceiling > 0 ? ceiling : null,
		credentialPresent: env.CONTENT_OS_GEMINI_CREDENTIAL_PRESENT === "true",
	};
}

/**
 * One ledger for the process, held separately from research's.
 *
 * A per-request ledger starts at zero every time, so the ceiling it is compared
 * against can never be reached and the gate is decoration. This one at least
 * holds for the life of the process; it still cannot bound real spending across
 * a deployment, which is why plan section 7.5 names a durable shared ledger as a
 * prerequisite for any live-call authorization.
 */
const providerCallLedger = new ProviderCallLedger();

export function creationProviderCallCount(): number {
	return providerCallLedger.count;
}

export type CreationAdapterId = "fixture" | "gemini";

/** What a run is permitted to spend. The fixture path spends nothing by construction. */
function permittedCalls(adapterId: CreationAdapterId): number {
	return adapterId === "fixture" ? 0 : (geminiGates().maxProviderCalls ?? 0);
}

function creationAdapter(adapterId: CreationAdapterId): CreationAdapter {
	if (adapterId === "fixture") return new FixtureCreationAdapter();
	return new GeminiCreationAdapter({ gates: geminiGates(), ledger: providerCallLedger });
}

export interface ConfirmedProfileRef {
	profileVersionId: string;
	profileHash: string;
	version: number;
	profile: NormalizedProjectProfile;
}

/**
 * The creation store, always constructed with an authenticated context and one
 * brand id. Nothing it exposes takes a tenant argument, so a caller has no way
 * to reach another brand's content even by mistake.
 */
export function createPostgresCreationStore(options: {
	context: ContentAuthContext;
	brandId: string;
	database?: typeof db;
}) {
	const { context, brandId } = options;

	async function readConfirmedProfile(tx: ContentTransaction): Promise<ConfirmedProfileRef | null> {
		const versions = await tx
			.select()
			.from(scrBrandContentProfileVersions)
			.where(
				and(
					eq(scrBrandContentProfileVersions.organizationId, context.tenantId),
					eq(scrBrandContentProfileVersions.brandId, brandId),
				),
			)
			.orderBy(desc(scrBrandContentProfileVersions.version));

		for (const version of versions) {
			const [decision] = await tx
				.select()
				.from(scrBrandContentProfileDecisions)
				.where(eq(scrBrandContentProfileDecisions.profileVersionId, version.id))
				.orderBy(desc(scrBrandContentProfileDecisions.createdAt), desc(scrBrandContentProfileDecisions.id))
				.limit(1);
			if (decision?.decision !== "CONFIRMED") continue;
			return {
				profileVersionId: version.id,
				profileHash: version.profileHash,
				version: version.version,
				profile: {
					languages: version.languages,
					audience: version.audience,
					voice: version.voice,
					ctaRules: version.ctaRules,
					visualRules: version.visualRules,
					claimRules: version.claimRules,
					facts: version.facts,
					sourceRefs: version.sourceRefs,
				} as NormalizedProjectProfile,
			};
		}
		return null;
	}

	/**
	 * A generation may only start from an opportunity the brand actually decided
	 * to keep. An undecided or rejected opportunity is a suggestion nobody chose,
	 * and building content on it would quietly turn a maybe into a commitment.
	 */
	async function readSavedOpportunity(tx: ContentTransaction, opportunityId: string) {
		const [opportunity] = await tx
			.select()
			.from(scrContentResearchOpportunities)
			.where(
				and(
					eq(scrContentResearchOpportunities.id, opportunityId),
					eq(scrContentResearchOpportunities.organizationId, context.tenantId),
					eq(scrContentResearchOpportunities.brandId, brandId),
				),
			)
			.limit(1);
		if (!opportunity) throw new ContentCreationError("NOT_FOUND", "Opportunity is not available for this brand");

		const [decision] = await tx
			.select()
			.from(scrContentResearchOpportunityDecisions)
			.where(eq(scrContentResearchOpportunityDecisions.opportunityId, opportunityId))
			.orderBy(desc(scrContentResearchOpportunityDecisions.createdAt), desc(scrContentResearchOpportunityDecisions.id))
			.limit(1);
		if (decision?.decision !== "SAVED" && decision?.decision !== "SENT_TO_CREATION") {
			throw new ContentCreationError(
				"OPPORTUNITY_NOT_SAVED",
				"Creation starts from an opportunity the brand has saved",
			);
		}
		return opportunity;
	}

	async function readRunSources(tx: ContentTransaction, runId: string) {
		return tx
			.select({
				id: scrContentResearchSources.id,
				externalId: scrContentResearchSources.externalId,
				title: scrContentResearchSources.title,
			})
			.from(scrContentResearchSources)
			.where(
				and(
					eq(scrContentResearchSources.organizationId, context.tenantId),
					eq(scrContentResearchSources.brandId, brandId),
					eq(scrContentResearchSources.runId, runId),
				),
			);
	}

	async function findGenerationByIdempotencyKey(
		tx: ContentTransaction,
		idempotencyKey: string,
	): Promise<GenerationRunRow | undefined> {
		const [existing] = await tx
			.select()
			.from(scrGenerationRuns)
			.where(
				and(
					eq(scrGenerationRuns.organizationId, context.tenantId),
					eq(scrGenerationRuns.brandId, brandId),
					eq(scrGenerationRuns.idempotencyKey, idempotencyKey),
				),
			)
			.limit(1);
		return existing;
	}

	async function readChannel(tx: ContentTransaction): Promise<string | null> {
		const [channel] = await tx
			.select({ id: scrContentChannels.id })
			.from(scrContentChannels)
			.where(and(eq(scrContentChannels.organizationId, context.tenantId), eq(scrContentChannels.brandId, brandId)))
			.limit(1);
		return channel?.id ?? null;
	}

	async function nextVersionNumber(tx: ContentTransaction, contentId: string): Promise<number> {
		const [row] = await tx
			.select({ highest: max(scrContentVersions.version) })
			.from(scrContentVersions)
			.where(eq(scrContentVersions.contentId, contentId));
		return (row?.highest ?? 0) + 1;
	}

	return {
		readConfirmedProfile,
		readSavedOpportunity,
		readRunSources,
		findGenerationByIdempotencyKey,
		readChannel,
		nextVersionNumber,

		async readItems(tx: ContentTransaction): Promise<ContentItemRow[]> {
			return tx
				.select()
				.from(scrContentItems)
				.where(and(eq(scrContentItems.organizationId, context.tenantId), eq(scrContentItems.brandId, brandId)))
				.orderBy(desc(scrContentItems.createdAt));
		},

		async readVersions(tx: ContentTransaction, contentId: string): Promise<ContentVersionRow[]> {
			return tx
				.select()
				.from(scrContentVersions)
				.where(
					and(
						eq(scrContentVersions.organizationId, context.tenantId),
						eq(scrContentVersions.brandId, brandId),
						eq(scrContentVersions.contentId, contentId),
					),
				)
				.orderBy(desc(scrContentVersions.version));
		},

		async readGenerationRun(tx: ContentTransaction, id: string): Promise<GenerationRunRow | undefined> {
			const [run] = await tx
				.select()
				.from(scrGenerationRuns)
				.where(
					and(
						eq(scrGenerationRuns.id, id),
						eq(scrGenerationRuns.organizationId, context.tenantId),
						eq(scrGenerationRuns.brandId, brandId),
					),
				)
				.limit(1);
			return run;
		},

		async readLatestIdeaRun(tx: ContentTransaction): Promise<GenerationRunRow | undefined> {
			const [run] = await tx
				.select()
				.from(scrGenerationRuns)
				.where(
					and(
						eq(scrGenerationRuns.organizationId, context.tenantId),
						eq(scrGenerationRuns.brandId, brandId),
						eq(scrGenerationRuns.kind, "IDEAS"),
					),
				)
				.orderBy(desc(scrGenerationRuns.createdAt), desc(scrGenerationRuns.id))
				.limit(1);
			return run;
		},
	};
}

/** What the surface renders. No prompt, no provider payload, no raw output. */
function toGenerationView(run: GenerationRunRow) {
	return {
		id: run.id,
		kind: run.kind,
		status: run.status,
		adapterId: run.adapterId,
		provider: run.provider,
		pipelineVersion: run.pipelineVersion,
		schemaVersion: run.schemaVersion,
		researchRunId: run.researchRunId,
		researchOpportunityId: run.researchOpportunityId,
		requestedCallCount: run.requestedCallCount,
		actualCallCount: run.actualCallCount,
		errorCode: run.errorCode,
		createdAt: run.createdAt.toISOString(),
	};
}

function toItemView(item: ContentItemRow) {
	return {
		id: item.id,
		title: item.title,
		contentKind: item.contentKind,
		workflowStage: item.workflowStage,
		contentChannelId: item.contentChannelId,
		createdAt: item.createdAt.toISOString(),
	};
}

function toVersionView(version: ContentVersionRow) {
	return {
		id: version.id,
		version: version.version,
		formatVersion: version.formatVersion,
		hashVersion: version.hashVersion,
		contentHash: version.contentHash,
		structuredBody: version.structuredBody as YouTubeVideoDocument | null,
		researchRunId: version.researchRunId,
		generationRunId: version.generationRunId,
		createdBy: version.createdBy,
		createdAt: version.createdAt.toISOString(),
	};
}

export interface GenerationRunRef {
	id: string;
	status: GenerationRunRow["status"];
	errorCode: string | null;
	reused: boolean;
}

export interface ContentVersionRef {
	contentId: string;
	versionId: string;
	version: number;
	contentHash: string;
}

export function createContentCreationRepositories(database: typeof db = db) {
	/**
	 * Assembles everything a generation needs and records the attempt, whatever
	 * it produces. The shape is deliberately the same as research's: a refused
	 * adapter becomes a FAILED run with a normalized code rather than vanishing,
	 * because an absent run reads as "never attempted".
	 */
	async function recordGeneration(
		tx: ContentTransaction,
		context: ContentAuthContext,
		brandId: string,
		input: {
			kind: GenerationRunRow["kind"];
			adapterId: CreationAdapterId;
			idempotencyKey: string;
			profile: ConfirmedProfileRef;
			researchRunId: string | null;
			researchOpportunityId: string | null;
			inputSnapshot: unknown;
			schemaVersion: string;
			requestedCallCount: number;
			run: () => Promise<{ output: unknown; externalProviderCalls: number }>;
		},
	): Promise<{ id: string; status: GenerationRunRow["status"]; output: unknown; errorCode: string | null }> {
		const runId = randomUUID();
		const correlationId = randomUUID();
		const startedAt = new Date();

		await appendContentAudit(tx, context, brandId, "content.generation_started", AGGREGATE_TYPE, runId, {
			kind: input.kind,
			adapterId: input.adapterId,
			profileVersionId: input.profile.profileVersionId,
			profileHash: input.profile.profileHash,
			researchRunId: input.researchRunId,
			correlationId,
		});

		let output: unknown = null;
		let errorCode: string | null = null;
		let externalProviderCalls = 0;
		try {
			const result = await input.run();
			output = result.output;
			externalProviderCalls = result.externalProviderCalls;
		} catch (error) {
			errorCode = error instanceof ContentCreationError ? error.code : "INTERNAL_ERROR";
		}

		const status: GenerationRunRow["status"] = errorCode ? "FAILED" : "COMPLETED";
		await tx.insert(scrGenerationRuns).values({
			id: runId,
			organizationId: context.tenantId,
			brandId,
			kind: input.kind,
			status,
			adapterId: input.adapterId,
			// Stage 1 records the provider a run would have reached as `none`,
			// because none was reached. Naming gemini here with zero calls would
			// read as "we called it and it cost nothing".
			provider: "none",
			promptVersion: PROMPT_VERSION,
			schemaVersion: input.schemaVersion,
			pipelineVersion: CREATION_VERSIONS.pipeline,
			inputSnapshotHash: sha256(input.inputSnapshot),
			outputHash: status === "COMPLETED" ? sha256(output) : null,
			validatedOutput: status === "COMPLETED" ? (output as Record<string, unknown>) : null,
			profileVersionId: input.profile.profileVersionId,
			profileHash: input.profile.profileHash,
			researchRunId: input.researchRunId,
			researchOpportunityId: input.researchOpportunityId,
			idempotencyKey: input.idempotencyKey,
			correlationId,
			// The ceiling the run was permitted, not a constant. The database refuses
			// a run whose actual calls exceed its requested ones, so hard-coding zero
			// here would mean a live adapter that did dispatch could not have its run
			// recorded at all — losing the record of a call that already cost money.
			requestedCallCount: input.requestedCallCount,
			actualCallCount: externalProviderCalls,
			errorCode,
			startedAt,
			completedAt: new Date(),
			createdBy: context.actorId,
		});

		await appendContentAudit(
			tx,
			context,
			brandId,
			status === "FAILED" ? "content.generation_failed" : "content.generation_completed",
			AGGREGATE_TYPE,
			runId,
			{
				kind: input.kind,
				status,
				adapterId: input.adapterId,
				externalProviderCalls,
				errorCode,
				correlationId,
			},
		);

		return { id: runId, status, output, errorCode };
	}

	async function writeStructuredVersion(
		tx: ContentTransaction,
		context: ContentAuthContext,
		brandId: string,
		input: {
			contentId: string;
			version: number;
			document: YouTubeVideoDocument;
			claims: readonly EvidenceClaim[];
			profile: ConfirmedProfileRef;
			researchRunId: string;
			generationRunId: string;
			contentChannelId: string | null;
		},
	): Promise<ContentVersionRef> {
		const snapshot = evidenceSnapshot(input.document, input.claims);
		const contentHash = contentWorkflowV2Hash({
			contentKind: "YOUTUBE_VIDEO",
			contentChannelId: input.contentChannelId,
			structuredBody: input.document,
			ctaUrl: input.document.script?.primaryCta ?? input.document.concept.honestPromise,
			claims: [],
			evidenceSnapshot: snapshot,
			disclosure: {},
			policyVersion: POLICY_VERSION,
			projectProfileVersionId: input.profile.profileVersionId,
			projectProfileHash: input.profile.profileHash,
			researchRunId: input.researchRunId,
			generationRunId: input.generationRunId,
		});

		const [created] = await tx
			.insert(scrContentVersions)
			.values({
				organizationId: context.tenantId,
				brandId,
				contentId: input.contentId,
				version: input.version,
				// Both are written: the document is canonical, and the rendering keeps
				// surfaces that predate structured content readable.
				body: renderReadableBody(input.document, input.claims),
				ctaUrl: input.document.script?.primaryCta ?? input.document.concept.honestPromise,
				claims: [],
				evidence: snapshot as Record<string, unknown>[],
				disclosure: {},
				policyVersion: POLICY_VERSION,
				contentHash,
				formatVersion: STRUCTURED_FORMAT_VERSION,
				hashVersion: "content.workflow/v2",
				structuredBody: input.document,
				projectProfileVersionId: input.profile.profileVersionId,
				researchRunId: input.researchRunId,
				generationRunId: input.generationRunId,
				createdBy: context.actorId,
			})
			.returning({ id: scrContentVersions.id });
		if (!created) throw new ContentCreationError("INTERNAL_ERROR", "Content version could not be recorded");

		await appendContentAudit(tx, context, brandId, "content.version_created", AGGREGATE_TYPE, created.id, {
			contentId: input.contentId,
			version: input.version,
			formatVersion: STRUCTURED_FORMAT_VERSION,
			hashVersion: "content.workflow/v2",
			contentHash,
			profileVersionId: input.profile.profileVersionId,
			researchRunId: input.researchRunId,
			generationRunId: input.generationRunId,
		});

		return { contentId: input.contentId, versionId: created.id, version: input.version, contentHash };
	}

	/**
	 * Rebuilds the evidence a stored generation ran against.
	 *
	 * Reconstructed from the run rather than stored twice: the opportunity and its
	 * research run are already immutable, so deriving the context is deterministic
	 * and cannot drift from a copy nobody updated.
	 */
	async function evidenceForOpportunity(
		tx: ContentTransaction,
		store: ReturnType<typeof createPostgresCreationStore>,
		opportunityId: string,
	): Promise<{ evidence: ResearchEvidenceContext; sourceTitles: string[]; researchRunId: string }> {
		const opportunity = await store.readSavedOpportunity(tx, opportunityId);
		const sources = await store.readRunSources(tx, opportunity.runId);
		// The opportunity stores its source by row id; evidence cites sources by
		// their external id, so the mapping is resolved here rather than assumed.
		const citedSource = sources.find((source) => source.id === opportunity.sourceId);
		if (!citedSource) {
			throw new ContentCreationError("EVIDENCE_REQUIRED", "The opportunity's source is not part of its research run");
		}
		const researchOpportunity: ResearchOpportunity = {
			key: opportunity.opportunityKey,
			sourceExternalId: citedSource.externalId,
			proposedAngle: opportunity.proposedAngle,
			proposedHook: opportunity.proposedHook,
			contentFormat: opportunity.contentFormat,
			rationale: opportunity.rationale,
			evidenceSummary: opportunity.evidenceSummary,
			confidence: opportunity.confidence as ResearchOpportunity["confidence"],
			factRequirements: (opportunity.factRequirements as string[]) ?? [],
		};
		return {
			evidence: buildEvidenceContext({
				researchRunId: opportunity.runId,
				opportunity: researchOpportunity,
				sources,
			}),
			sourceTitles: sources.map((source) => source.title),
			researchRunId: opportunity.runId,
		};
	}

	return {
		async getCreation(context: ContentAuthContext, brandId: string) {
			const store = createPostgresCreationStore({ context, brandId, database });
			return withBrandRequestContext(database, context, brandId, async (tx) => {
				const profile = await store.readConfirmedProfile(tx);
				const ideaRun = await store.readLatestIdeaRun(tx);
				const items = await store.readItems(tx);
				const versionsByItem: Record<string, ReturnType<typeof toVersionView>[]> = {};
				for (const item of items) {
					versionsByItem[item.id] = (await store.readVersions(tx, item.id)).map(toVersionView);
				}
				return {
					confirmedProfile: profile
						? { profileVersionId: profile.profileVersionId, profileHash: profile.profileHash, version: profile.version }
						: null,
					ideaRun: ideaRun ? toGenerationView(ideaRun) : null,
					ideas:
						ideaRun?.status === "COMPLETED" ? ((ideaRun.validatedOutput as { ideas: IdeaPackage[] }).ideas ?? []) : [],
					items: items.map(toItemView),
					versionsByItem,
					canDecide: context.authType === "session" && ["owner", "member"].includes(context.role),
				};
			});
		},

		/**
		 * Six ideas from one saved opportunity. The idempotency key makes a repeated
		 * delivery return the run that already exists rather than a second one.
		 */
		async generateIdeas(
			context: ContentAuthContext,
			input: { brandId: string; opportunityId: string; idempotencyKey: string; adapterId?: CreationAdapterId },
		): Promise<GenerationRunRef> {
			assertWritable(context);
			const store = createPostgresCreationStore({ context, brandId: input.brandId, database });
			return withBrandRequestContext(
				database,
				context,
				input.brandId,
				async (tx) => {
					const existing = await store.findGenerationByIdempotencyKey(tx, input.idempotencyKey);
					if (existing) {
						return { id: existing.id, status: existing.status, errorCode: existing.errorCode, reused: true };
					}

					const profile = await store.readConfirmedProfile(tx);
					if (!profile) {
						throw new ContentCreationError(
							"PROFILE_NOT_CONFIRMED",
							"Idea generation requires a confirmed project profile for this brand",
						);
					}

					const { evidence, sourceTitles, researchRunId } = await evidenceForOpportunity(
						tx,
						store,
						input.opportunityId,
					);
					const adapterId = input.adapterId ?? "fixture";

					const recorded = await recordGeneration(tx, context, input.brandId, {
						kind: "IDEAS",
						adapterId,
						idempotencyKey: input.idempotencyKey,
						profile,
						researchRunId,
						researchOpportunityId: input.opportunityId,
						inputSnapshot: { evidence, profileHash: profile.profileHash },
						schemaVersion: CREATION_VERSIONS.ideaSchema,
						requestedCallCount: permittedCalls(adapterId),
						run: async () => {
							const outcome = await runIdeaGeneration({
								adapter: creationAdapter(adapterId),
								evidence,
								projectSlug: input.brandId,
								profileHash: profile.profileHash,
								languages: profile.profile.languages,
								audience: "GENERAL",
								sourceTitles,
								now: new Date(),
							});
							return {
								output: { ideas: outcome.ideas },
								externalProviderCalls: outcome.counters.externalProviderCalls,
							};
						},
					});

					return { id: recorded.id, status: recorded.status, errorCode: recorded.errorCode, reused: false };
				},
				true,
			);
		},

		/**
		 * Selecting an idea creates the content item and its first immutable
		 * version. The five unselected ideas stay in the generation run's output;
		 * nothing deletes them, so the choice stays reviewable.
		 */
		async selectIdea(
			context: ContentAuthContext,
			input: { brandId: string; generationRunId: string; ideaIndex: number },
		): Promise<ContentVersionRef> {
			assertWritable(context);
			const store = createPostgresCreationStore({ context, brandId: input.brandId, database });
			return withBrandRequestContext(
				database,
				context,
				input.brandId,
				async (tx) => {
					const run = await store.readGenerationRun(tx, input.generationRunId);
					if (run?.kind !== "IDEAS" || run.status !== "COMPLETED") {
						throw new ContentCreationError("NOT_FOUND", "No completed idea run is available for this brand");
					}
					const ideas = (run.validatedOutput as { ideas: IdeaPackage[] }).ideas ?? [];
					const idea = ideas[input.ideaIndex];
					if (!idea) throw new ContentCreationError("NOT_FOUND", "That idea is not part of this run");

					const profile = await store.readConfirmedProfile(tx);
					if (!profile) {
						throw new ContentCreationError("PROFILE_NOT_CONFIRMED", "Selecting an idea requires a confirmed profile");
					}
					if (!run.researchOpportunityId || !run.researchRunId) {
						throw new ContentCreationError("EVIDENCE_REQUIRED", "The idea run has no research lineage");
					}

					const { evidence } = await evidenceForOpportunity(tx, store, run.researchOpportunityId);
					const scriptEvidence = buildScriptEvidenceContext({ evidence, idea });
					const document = buildConceptDocument({ idea, evidence: scriptEvidence, audience: "GENERAL" });

					const contentChannelId = await store.readChannel(tx);
					if (!contentChannelId) {
						throw new ContentCreationError("NOT_FOUND", "This brand has no draft-only content channel");
					}

					const [item] = await tx
						.insert(scrContentItems)
						.values({
							organizationId: context.tenantId,
							brandId: input.brandId,
							title: idea.title,
							contentKind: "YOUTUBE_VIDEO",
							contentChannelId,
							workflowStage: "IDEA_SELECTED",
							createdBy: context.actorId,
						})
						.returning({ id: scrContentItems.id });
					if (!item) throw new ContentCreationError("INTERNAL_ERROR", "Content item could not be recorded");

					return writeStructuredVersion(tx, context, input.brandId, {
						contentId: item.id,
						version: 1,
						document,
						claims: [...scriptEvidence.evidenceClaims, ...idea.evidenceClaims],
						profile,
						researchRunId: run.researchRunId,
						generationRunId: run.id,
						contentChannelId,
					});
				},
				true,
			);
		},

		/**
		 * A script is a new immutable version on the same item, never an edit of the
		 * one before it. `kind` distinguishes the first script from a later revision
		 * so the run history says which is which.
		 */
		async generateScript(
			context: ContentAuthContext,
			input: {
				brandId: string;
				contentId: string;
				idempotencyKey: string;
				adapterId?: CreationAdapterId;
				revision?: boolean;
			},
		): Promise<ContentVersionRef> {
			assertWritable(context);
			const store = createPostgresCreationStore({ context, brandId: input.brandId, database });
			return withBrandRequestContext(
				database,
				context,
				input.brandId,
				async (tx) => {
					const [item] = await tx
						.select()
						.from(scrContentItems)
						.where(
							and(
								eq(scrContentItems.id, input.contentId),
								eq(scrContentItems.organizationId, context.tenantId),
								eq(scrContentItems.brandId, input.brandId),
							),
						)
						.limit(1);
					if (!item) throw new ContentCreationError("NOT_FOUND", "That content item is not available for this brand");

					const versions = await store.readVersions(tx, input.contentId);
					const latest = versions[0];
					if (!latest?.structuredBody || !latest.researchRunId || !latest.generationRunId) {
						throw new ContentCreationError("NOT_FOUND", "That content item has no structured version to build on");
					}

					const profile = await store.readConfirmedProfile(tx);
					if (!profile) {
						throw new ContentCreationError("PROFILE_NOT_CONFIRMED", "Script generation requires a confirmed profile");
					}

					// The idea lives in the IDEAS run, which is the *first* version's
					// generation run. Reading it off the latest version works only until
					// the first revision, when the latest version's run is a SCRIPT run
					// whose output has no ideas in it at all.
					const conceptVersion = versions[versions.length - 1];
					const ideaRun = conceptVersion?.generationRunId
						? await store.readGenerationRun(tx, conceptVersion.generationRunId)
						: undefined;
					if (ideaRun?.kind !== "IDEAS" || !ideaRun.researchOpportunityId) {
						throw new ContentCreationError("EVIDENCE_REQUIRED", "The version has no research lineage to build on");
					}
					const { evidence } = await evidenceForOpportunity(tx, store, ideaRun.researchOpportunityId);
					const ideas = (ideaRun.validatedOutput as { ideas: IdeaPackage[] } | null)?.ideas ?? [];
					const idea = ideas.find((candidate) => candidate.title === item.title) ?? ideas[0];
					if (!idea) throw new ContentCreationError("EVIDENCE_REQUIRED", "The selected idea is no longer available");
					const scriptEvidence = buildScriptEvidenceContext({ evidence, idea });
					const adapterId = input.adapterId ?? "fixture";

					const recorded = await recordGeneration(tx, context, input.brandId, {
						kind: input.revision ? "SCRIPT_REVISION" : "SCRIPT",
						adapterId,
						idempotencyKey: input.idempotencyKey,
						profile,
						researchRunId: latest.researchRunId,
						researchOpportunityId: ideaRun.researchOpportunityId,
						inputSnapshot: { evidence: scriptEvidence, contentId: input.contentId, version: latest.version },
						schemaVersion: CREATION_VERSIONS.scriptSchema,
						requestedCallCount: permittedCalls(adapterId),
						run: async () => {
							const outcome = await runScriptGeneration({
								adapter: creationAdapter(adapterId),
								evidence: scriptEvidence,
								projectSlug: input.brandId,
								profileHash: profile.profileHash,
								languages: profile.profile.languages,
								audience: "GENERAL",
								now: new Date(),
							});
							return { output: outcome.script, externalProviderCalls: outcome.externalProviderCalls };
						},
					});

					if (recorded.status === "FAILED") {
						// Invalid output never becomes a content version. The failure is
						// already recorded above, with a normalized code and no output.
						throw new ContentCreationError(
							(recorded.errorCode as CreationErrorCode) ?? "INVALID_GENERATION_OUTPUT",
							"Script generation did not produce a usable script",
						);
					}

					const document = buildScriptDocument({
						concept: latest.structuredBody as YouTubeVideoDocument,
						script: recorded.output as Parameters<typeof buildScriptDocument>[0]["script"],
					});

					const version = await store.nextVersionNumber(tx, input.contentId);
					const written = await writeStructuredVersion(tx, context, input.brandId, {
						contentId: input.contentId,
						version,
						document,
						claims: [...scriptEvidence.evidenceClaims, ...idea.evidenceClaims],
						profile,
						researchRunId: latest.researchRunId,
						generationRunId: recorded.id,
						contentChannelId: item.contentChannelId,
					});

					await tx
						.update(scrContentItems)
						.set({ workflowStage: "SCRIPT_DRAFTED", updatedAt: new Date() })
						.where(eq(scrContentItems.id, input.contentId));

					return written;
				},
				true,
			);
		},
	};
}

export const contentCreationRepositories = createContentCreationRepositories();

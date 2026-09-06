import { randomUUID } from "node:crypto";
import { allowedClaimFacts, type NormalizedProjectProfile } from "@workspace/content-workflow/profile";
import {
	ContentResearchError,
	deriveResearchProject,
	emptyRunCounters,
	FixtureResearchAdapter,
	type OpportunityDecisionInput,
	type OpportunityDecisionRef,
	ProviderCallLedger,
	RESEARCH_VERSIONS,
	type ResearchAdapter,
	type ResearchAdapterId,
	type ResearchErrorCode,
	type ResearchProject,
	type ResearchRunCounters,
	type ResearchRunFailure,
	type ResearchRunOutcome,
	type ResearchSource,
	runResearchPipeline,
	type ScoreComponent,
	type ScoredSource,
	VideoRadarAdapter,
	type VideoRadarAdapterGates,
	validateOpportunityDecision,
} from "@workspace/content-workflow/research";
import { and, desc, eq } from "drizzle-orm";
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
	scrContentResearchMetricSnapshots,
	scrContentResearchOpportunities,
	scrContentResearchOpportunityDecisions,
	scrContentResearchRuns,
	scrContentResearchSources,
} from "./db/schema";

const AGGREGATE_TYPE = "content_research";

type RunRow = typeof scrContentResearchRuns.$inferSelect;
type SourceRow = typeof scrContentResearchSources.$inferSelect;
type OpportunityRow = typeof scrContentResearchOpportunities.$inferSelect;
type DecisionRow = typeof scrContentResearchOpportunityDecisions.$inferSelect;

function assertWritable(context: ContentAuthContext): void {
	if (context.authType !== "session" || !["owner", "member"].includes(context.role)) {
		throw new Error("Forbidden: editor or owner access required");
	}
}

/**
 * Live Video Radar gates, read fail-closed from the environment. The credential
 * itself is never read: only a separate boolean states that one exists, so no
 * secret can reach this process, a log line or a stored row.
 *
 * Stage 1 also injects no dispatcher, so the adapter refuses even when every
 * gate below is somehow open.
 */
function videoRadarGates(env: NodeJS.ProcessEnv = process.env): VideoRadarAdapterGates {
	const ceiling = Number.parseInt(env.CONTENT_OS_VIDEO_RADAR_MAX_CALLS ?? "", 10);
	return {
		liveProviderEnabled: env.CONTENT_OS_VIDEO_RADAR_LIVE === "true",
		maxProviderCalls: Number.isFinite(ceiling) && ceiling > 0 ? ceiling : null,
		credentialPresent: env.CONTENT_OS_VIDEO_RADAR_CREDENTIAL_PRESENT === "true",
	};
}

/**
 * One ledger for the process, not one per call.
 *
 * A ledger constructed per request starts at zero every time, so the call
 * ceiling it is compared against can never be reached and the gate is
 * decorative. This one at least holds for the life of the process.
 *
 * It is still not sufficient for a live provider: a ceiling that resets on
 * deploy and is not shared between instances cannot bound real spending. A
 * durable, shared ledger is a prerequisite for any future live-call
 * authorization, and Stage 1 injects no dispatcher, so nothing can be recorded
 * in it yet.
 */
const providerCallLedger = new ProviderCallLedger();

export function researchProviderCallCount(): number {
	return providerCallLedger.count;
}

function researchAdapter(adapterId: ResearchAdapterId, imported?: ResearchSource[]): ResearchAdapter {
	if (adapterId === "fixture") return new FixtureResearchAdapter(imported);
	return new VideoRadarAdapter({ gates: videoRadarGates(), ledger: providerCallLedger });
}

/** A run that never produced a result is still recorded, with a normalized code. */
function failedOutcome(code: ResearchErrorCode, occurredAt: string): ResearchRunOutcome {
	return {
		status: "FAILED",
		pipelineVersion: RESEARCH_VERSIONS.pipeline,
		scoringVersion: RESEARCH_VERSIONS.scoring,
		baselineVersion: RESEARCH_VERSIONS.baseline,
		counters: emptyRunCounters(),
		failures: [{ stage: "adapter", subjectId: null, code, occurredAt }],
		scored: [],
		opportunities: [],
	};
}

export interface ConfirmedProfileRef {
	profileVersionId: string;
	profileHash: string;
	version: number;
	profile: NormalizedProjectProfile;
}

/**
 * The research store, always constructed with an authenticated context and one
 * brand id. Nothing it exposes takes a tenant argument, so a caller has no way
 * to reach another brand's runs even by mistake.
 */
export function createPostgresRadarStore(options: {
	context: ContentAuthContext;
	brandId: string;
	database?: typeof db;
}) {
	const { context, brandId } = options;
	const database = options.database ?? db;

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

	async function findRunByIdempotencyKey(tx: ContentTransaction, idempotencyKey: string): Promise<RunRow | undefined> {
		const [existing] = await tx
			.select()
			.from(scrContentResearchRuns)
			.where(
				and(
					eq(scrContentResearchRuns.organizationId, context.tenantId),
					eq(scrContentResearchRuns.brandId, brandId),
					eq(scrContentResearchRuns.idempotencyKey, idempotencyKey),
				),
			)
			.limit(1);
		return existing;
	}

	async function readLatestRun(tx: ContentTransaction): Promise<RunRow | undefined> {
		const [latest] = await tx
			.select()
			.from(scrContentResearchRuns)
			.where(
				and(eq(scrContentResearchRuns.organizationId, context.tenantId), eq(scrContentResearchRuns.brandId, brandId)),
			)
			.orderBy(desc(scrContentResearchRuns.createdAt), desc(scrContentResearchRuns.id))
			.limit(1);
		return latest;
	}

	async function persistRun(
		tx: ContentTransaction,
		input: {
			runId: string;
			correlationId: string;
			idempotencyKey: string;
			adapterId: string;
			project: ResearchProject;
			outcome: ResearchRunOutcome;
			startedAt: Date;
			completedAt: Date;
		},
	): Promise<void> {
		await tx.insert(scrContentResearchRuns).values({
			id: input.runId,
			organizationId: context.tenantId,
			brandId,
			profileVersionId: input.project.profileVersionId,
			profileHash: input.project.profileHash,
			idempotencyKey: input.idempotencyKey,
			adapterId: input.adapterId,
			status: input.outcome.status,
			pipelineVersion: input.outcome.pipelineVersion,
			scoringVersion: input.outcome.scoringVersion,
			baselineVersion: input.outcome.baselineVersion,
			counters: input.outcome.counters,
			failures: input.outcome.failures,
			correlationId: input.correlationId,
			externalProviderCalls: input.outcome.counters.externalProviderCalls,
			startedAt: input.startedAt,
			completedAt: input.completedAt,
			createdBy: context.actorId,
		});

		const sourceIdByExternalId = new Map<string, string>();
		for (const scored of input.outcome.scored) {
			const sourceId = randomUUID();
			sourceIdByExternalId.set(scored.source.externalId, sourceId);
			await tx.insert(scrContentResearchSources).values(sourceRow(sourceId, input.runId, scored));
			for (const snapshot of scored.source.snapshots) {
				await tx.insert(scrContentResearchMetricSnapshots).values({
					organizationId: context.tenantId,
					brandId,
					sourceId,
					capturedAt: new Date(snapshot.capturedAt),
					views: snapshot.views,
					likes: snapshot.likes,
					comments: snapshot.comments,
					createdBy: context.actorId,
				});
			}
		}

		for (const opportunity of input.outcome.opportunities) {
			const sourceId = sourceIdByExternalId.get(opportunity.sourceExternalId);
			if (!sourceId) continue;
			await tx.insert(scrContentResearchOpportunities).values({
				organizationId: context.tenantId,
				brandId,
				runId: input.runId,
				sourceId,
				profileVersionId: input.project.profileVersionId,
				profileHash: input.project.profileHash,
				opportunityKey: opportunity.key,
				proposedAngle: opportunity.proposedAngle,
				proposedHook: opportunity.proposedHook,
				contentFormat: opportunity.contentFormat,
				rationale: opportunity.rationale,
				evidenceSummary: opportunity.evidenceSummary,
				confidence: opportunity.confidence,
				factRequirements: opportunity.factRequirements,
				createdBy: context.actorId,
			});
		}
	}

	function sourceRow(sourceId: string, runId: string, scored: ScoredSource) {
		const source: ResearchSource = scored.source;
		return {
			id: sourceId,
			organizationId: context.tenantId,
			brandId,
			runId,
			platform: source.platform,
			externalId: source.externalId,
			sourceUrl: source.sourceUrl,
			adapterId: scored.provenance.adapterId,
			channelId: source.channelId,
			channelName: source.channelName,
			title: source.title,
			description: source.description,
			publishedAt: new Date(source.publishedAt),
			capturedAt: new Date(scored.provenance.capturedAt),
			durationSeconds: source.durationSeconds,
			videoType: scored.videoType,
			language: source.language,
			views: source.views,
			likes: source.likes,
			comments: source.comments,
			transcriptStatus: source.transcript.status,
			transcriptLanguage: source.transcript.language,
			transcriptFailureReason: source.transcript.failureReason,
			baselineViews: scored.baseline.baselineViews,
			baselineSampleSize: scored.baseline.sampleSize,
			baselineConfidence: scored.baseline.confidence,
			outlierRatio: scored.outlier.ratio,
			outlierBand: scored.outlier.band,
			outlierMaturity: scored.outlier.maturity,
			relevanceScore: scored.relevance.score,
			candidateScore: scored.score.score,
			weightCoverage: scored.score.weightCoverage,
			scoreComponents: scored.score.components,
			gateReasons: scored.gateReasons,
			shortlisted: scored.shortlisted,
			scoringVersion: scored.score.scoringVersion,
			baselineVersion: scored.baseline.baselineVersion,
			createdBy: context.actorId,
		};
	}

	async function readProfileVersionNumber(tx: ContentTransaction, profileVersionId: string): Promise<number | null> {
		const [row] = await tx
			.select({ version: scrBrandContentProfileVersions.version })
			.from(scrBrandContentProfileVersions)
			.where(eq(scrBrandContentProfileVersions.id, profileVersionId))
			.limit(1);
		return row?.version ?? null;
	}

	async function readRunDetail(tx: ContentTransaction, runId: string) {
		// RLS already scopes these reads; the explicit tenant predicates are the
		// second lock, so a future change to a policy cannot silently widen a read.
		const sources = await tx
			.select()
			.from(scrContentResearchSources)
			.where(
				and(
					eq(scrContentResearchSources.organizationId, context.tenantId),
					eq(scrContentResearchSources.brandId, brandId),
					eq(scrContentResearchSources.runId, runId),
				),
			)
			.orderBy(desc(scrContentResearchSources.candidateScore));
		const opportunities = await tx
			.select()
			.from(scrContentResearchOpportunities)
			.where(
				and(
					eq(scrContentResearchOpportunities.organizationId, context.tenantId),
					eq(scrContentResearchOpportunities.brandId, brandId),
					eq(scrContentResearchOpportunities.runId, runId),
				),
			)
			.orderBy(desc(scrContentResearchOpportunities.createdAt));
		const decisions = await tx
			.select()
			.from(scrContentResearchOpportunityDecisions)
			.where(
				and(
					eq(scrContentResearchOpportunityDecisions.organizationId, context.tenantId),
					eq(scrContentResearchOpportunityDecisions.brandId, brandId),
				),
			)
			.orderBy(desc(scrContentResearchOpportunityDecisions.createdAt));
		return { sources, opportunities, decisions };
	}

	return {
		database,
		context,
		brandId,
		readConfirmedProfile,
		findRunByIdempotencyKey,
		readLatestRun,
		readProfileVersionNumber,
		readRunDetail,
		persistRun,
	};
}

export interface ResearchRunRef {
	id: string;
	status: RunRow["status"];
	profileVersionId: string;
	reused: boolean;
}

export interface ResearchStateView {
	confirmedProfile: { profileVersionId: string; profileHash: string; version: number } | null;
	run: {
		id: string;
		status: RunRow["status"];
		adapterId: string;
		pipelineVersion: string;
		scoringVersion: string;
		baselineVersion: string;
		profileVersionId: string;
		profileHash: string;
		profileVersion: number | null;
		/** Whether the profile this run was scored against is still the confirmed one. */
		profileStillConfirmed: boolean;
		counters: ResearchRunCounters;
		failures: ResearchRunFailure[];
		externalProviderCalls: number;
		startedAt: string;
		completedAt: string;
	} | null;
	sources: ReturnType<typeof toSourceView>[];
	opportunities: ReturnType<typeof toOpportunityView>[];
}

function toSourceView(row: SourceRow) {
	return {
		id: row.id,
		externalId: row.externalId,
		sourceUrl: row.sourceUrl,
		channelName: row.channelName,
		title: row.title,
		publishedAt: row.publishedAt.toISOString(),
		capturedAt: row.capturedAt.toISOString(),
		videoType: row.videoType,
		language: row.language,
		views: row.views,
		transcriptStatus: row.transcriptStatus,
		transcriptLanguage: row.transcriptLanguage,
		transcriptFailureReason: row.transcriptFailureReason,
		baselineSampleSize: row.baselineSampleSize,
		baselineConfidence: row.baselineConfidence,
		outlierRatio: row.outlierRatio,
		outlierBand: row.outlierBand,
		outlierMaturity: row.outlierMaturity,
		relevanceScore: row.relevanceScore,
		candidateScore: row.candidateScore,
		weightCoverage: row.weightCoverage,
		scoreComponents: row.scoreComponents as ScoreComponent[],
		gateReasons: row.gateReasons as string[],
		shortlisted: row.shortlisted,
		scoringVersion: row.scoringVersion,
	};
}

function toOpportunityView(row: OpportunityRow, decisions: DecisionRow[]) {
	const latest = decisions.filter((decision) => decision.opportunityId === row.id).at(0);
	return {
		id: row.id,
		sourceId: row.sourceId,
		proposedAngle: row.proposedAngle,
		proposedHook: row.proposedHook,
		contentFormat: row.contentFormat,
		rationale: row.rationale,
		evidenceSummary: row.evidenceSummary,
		confidence: row.confidence,
		factRequirements: row.factRequirements as string[],
		createdAt: row.createdAt.toISOString(),
		state: latest?.decision ?? ("NEW" as const),
		decidedBy: latest?.decidedBy ?? null,
		decisionReason: latest?.reason ?? null,
	};
}

export function createContentResearchRepositories(database: typeof db = db) {
	async function loadState(context: ContentAuthContext, brandId: string): Promise<ResearchStateView> {
		const store = createPostgresRadarStore({ context, brandId, database });
		return withBrandRequestContext(database, context, brandId, async (tx) => {
			const profile = await store.readConfirmedProfile(tx);
			const run = await store.readLatestRun(tx);
			if (!run) {
				return {
					confirmedProfile: profile
						? {
								profileVersionId: profile.profileVersionId,
								profileHash: profile.profileHash,
								version: profile.version,
							}
						: null,
					run: null,
					sources: [],
					opportunities: [],
				};
			}
			const detail = await store.readRunDetail(tx, run.id);
			const profileVersion = await store.readProfileVersionNumber(tx, run.profileVersionId);
			return {
				confirmedProfile: profile
					? {
							profileVersionId: profile.profileVersionId,
							profileHash: profile.profileHash,
							version: profile.version,
						}
					: null,
				run: {
					id: run.id,
					status: run.status,
					adapterId: run.adapterId,
					pipelineVersion: run.pipelineVersion,
					scoringVersion: run.scoringVersion,
					baselineVersion: run.baselineVersion,
					profileVersionId: run.profileVersionId,
					profileHash: run.profileHash,
					profileVersion,
					profileStillConfirmed: profile?.profileVersionId === run.profileVersionId,
					counters: run.counters as ResearchRunCounters,
					failures: run.failures as ResearchRunFailure[],
					externalProviderCalls: run.externalProviderCalls,
					startedAt: run.startedAt.toISOString(),
					completedAt: run.completedAt.toISOString(),
				},
				sources: detail.sources.map(toSourceView),
				opportunities: detail.opportunities.map((row) => toOpportunityView(row, detail.decisions)),
			};
		});
	}

	return {
		getResearch: loadState,

		/**
		 * Import and score one deterministic fixture. The idempotency key makes a
		 * repeated delivery return the run that already exists rather than a second
		 * one, so a double-submitted form cannot fork a brand's evidence.
		 */
		async runResearch(
			context: ContentAuthContext,
			input: {
				brandId: string;
				idempotencyKey: string;
				imported?: ResearchSource[];
				adapterId?: ResearchAdapterId;
			},
		): Promise<ResearchRunRef> {
			assertWritable(context);
			const store = createPostgresRadarStore({ context, brandId: input.brandId, database });
			return withBrandRequestContext(
				database,
				context,
				input.brandId,
				async (tx) => {
					const existing = await store.findRunByIdempotencyKey(tx, input.idempotencyKey);
					if (existing) {
						return {
							id: existing.id,
							status: existing.status,
							profileVersionId: existing.profileVersionId,
							reused: true,
						};
					}

					const confirmed = await store.readConfirmedProfile(tx);
					if (!confirmed) {
						throw new ContentResearchError(
							"PROFILE_NOT_CONFIRMED",
							"Research requires a confirmed project profile for this brand",
						);
					}

					const project = deriveResearchProject({
						brandId: input.brandId,
						profileVersionId: confirmed.profileVersionId,
						profileHash: confirmed.profileHash,
						profile: confirmed.profile,
					});

					const runId = randomUUID();
					const correlationId = randomUUID();
					const startedAt = new Date();
					const adapterId = input.adapterId ?? "fixture";

					await appendContentAudit(tx, context, input.brandId, "content.research_started", AGGREGATE_TYPE, runId, {
						profileVersionId: confirmed.profileVersionId,
						profileHash: confirmed.profileHash,
						adapterId,
						correlationId,
					});

					let outcome: ResearchRunOutcome;
					try {
						outcome = await runResearchPipeline({
							project,
							adapter: researchAdapter(adapterId, input.imported),
							now: startedAt,
							verifiedFactStatements: allowedClaimFacts(confirmed.profile).map((fact) => fact.statement),
						});
					} catch (error) {
						// A refused adapter is recorded as a failed run rather than
						// disappearing: an absent run reads as "never attempted", and
						// rethrowing here would roll back the very event that says so.
						outcome = failedOutcome(
							error instanceof ContentResearchError ? error.code : "INTERNAL_ERROR",
							startedAt.toISOString(),
						);
					}

					const completedAt = new Date();
					await store.persistRun(tx, {
						runId,
						correlationId,
						idempotencyKey: input.idempotencyKey,
						adapterId,
						project,
						outcome,
						startedAt,
						completedAt,
					});

					const action = outcome.status === "FAILED" ? "content.research_failed" : "content.research_completed";
					await appendContentAudit(tx, context, input.brandId, action, AGGREGATE_TYPE, runId, {
						profileVersionId: confirmed.profileVersionId,
						profileHash: confirmed.profileHash,
						status: outcome.status,
						sourcesScored: outcome.counters.sourcesScored,
						shortlisted: outcome.counters.shortlisted,
						opportunitiesProduced: outcome.counters.opportunitiesProduced,
						externalProviderCalls: outcome.counters.externalProviderCalls,
						errorCodes: outcome.failures.map((failure) => failure.code),
						correlationId,
					});

					return { id: runId, status: outcome.status, profileVersionId: confirmed.profileVersionId, reused: false };
				},
				true,
			);
		},

		async decideOpportunity(
			context: ContentAuthContext,
			input: OpportunityDecisionInput,
		): Promise<OpportunityDecisionRef> {
			assertWritable(context);
			validateOpportunityDecision(input);
			if (input.organizationId !== context.tenantId) {
				throw new Error("Forbidden: organization is controlled by the session");
			}
			return withBrandRequestContext(
				database,
				context,
				input.brandId,
				async (tx) => {
					const [opportunity] = await tx
						.select()
						.from(scrContentResearchOpportunities)
						.where(
							and(
								eq(scrContentResearchOpportunities.id, input.opportunityId),
								eq(scrContentResearchOpportunities.organizationId, context.tenantId),
								eq(scrContentResearchOpportunities.brandId, input.brandId),
							),
						)
						.limit(1);
					if (!opportunity) throw new ContentResearchError("NOT_FOUND", "Opportunity is not available for this brand");

					const decision = input.decision as Exclude<OpportunityDecisionInput["decision"], "NEW">;
					const [created] = await tx
						.insert(scrContentResearchOpportunityDecisions)
						.values({
							organizationId: context.tenantId,
							brandId: input.brandId,
							opportunityId: opportunity.id,
							decision,
							reason: input.reason?.trim() || null,
							decidedBy: context.actorId,
						})
						.returning({
							id: scrContentResearchOpportunityDecisions.id,
							opportunityId: scrContentResearchOpportunityDecisions.opportunityId,
							decision: scrContentResearchOpportunityDecisions.decision,
						});
					if (!created) throw new ContentResearchError("INTERNAL_ERROR", "Opportunity decision could not be recorded");

					await appendContentAudit(
						tx,
						context,
						input.brandId,
						decision === "REJECTED" ? "content.opportunity_rejected" : "content.opportunity_saved",
						AGGREGATE_TYPE,
						opportunity.id,
						{
							opportunityId: opportunity.id,
							runId: opportunity.runId,
							profileHash: opportunity.profileHash,
							decision,
						},
					);

					return created;
				},
				true,
			);
		},
	};
}

export const contentResearchRepositories = createContentResearchRepositories();

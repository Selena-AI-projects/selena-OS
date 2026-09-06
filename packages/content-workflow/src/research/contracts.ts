/**
 * Research vocabulary, transferred from `parkourcafe/video-radar-marketing-tool`
 * at `b589a811a4e1f205a784e5128283f9d227143f32` (`lib/video-radar/contracts.ts`).
 *
 * Modifications: persisted state values are uppercase to match the registry
 * enums; the global project registry is replaced by a single brand-derived
 * project; provider transport types are not transferred.
 */

/** v1 is YouTube-only. The union exists so a second platform is additive, not a rewrite. */
export type ResearchPlatform = "youtube";

/**
 * `UNKNOWN` is a real state, not a placeholder: an uncertain video is never
 * forced into a bucket, because a short compared against long-form baselines
 * produces a confident wrong answer rather than a missing one.
 */
export type VideoType = "SHORT" | "LONG" | "UNKNOWN";

export type BaselineConfidence = "HIGH" | "MEDIUM" | "LOW" | "UNAVAILABLE";

/** Whether a source has had enough exposure time for its outlier result to mean anything. */
export type OutlierMaturity = "PROVISIONAL" | "MATURE";

export type OutlierBand = "UNAVAILABLE" | "NORMAL" | "INTERESTING" | "STRONG" | "MAJOR" | "EXCEPTIONAL";

/** Retrieval state of a transcript. There is no state that means "we made the text up". */
export type TranscriptStatus = "PENDING" | "AVAILABLE" | "UNAVAILABLE" | "BLOCKED" | "FAILED" | "UNSUPPORTED";

export type VelocityStatus = "MEASURED" | "UNAVAILABLE";

export type EvidenceConfidence = "HIGH" | "MEDIUM" | "LOW";

export type ResearchRunStatus = "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED";

export type OpportunityState = "NEW" | "SAVED" | "REJECTED" | "SENT_TO_CREATION";

/**
 * Version stamps recorded on every run and score. Never bump silently — an old
 * ranking must stay interpretable next to a new one.
 */
export const RESEARCH_VERSIONS = {
	pipeline: "content.research/v1",
	scoring: "radar-scoring-v1",
	baseline: "radar-baseline-v1",
} as const;

/**
 * Normalized research error codes. Callers and the UI branch on the code, never
 * on a message, so provider wording never reaches a customer surface.
 */
export const RESEARCH_ERROR_CODES = [
	"PROFILE_NOT_CONFIRMED",
	"INVALID_INPUT",
	"NOT_FOUND",
	"ADAPTER_DISABLED",
	"PROVIDER_UNAVAILABLE",
	"PROVIDER_RATE_LIMITED",
	"PROVIDER_AUTH_FAILED",
	"PROVIDER_QUOTA_EXCEEDED",
	"MISSING_PROVENANCE",
	"TRANSCRIPT_UNAVAILABLE",
	"OPPORTUNITY_EVIDENCE_REQUIRED",
	"RUN_IN_PROGRESS",
	"INTERNAL_ERROR",
] as const;

export type ResearchErrorCode = (typeof RESEARCH_ERROR_CODES)[number];

export class ContentResearchError extends Error {
	readonly code: ResearchErrorCode;

	constructor(code: ResearchErrorCode, message: string) {
		super(message);
		this.name = "ContentResearchError";
		this.code = code;
	}
}

export function isResearchErrorCode(value: unknown): value is ResearchErrorCode {
	return typeof value === "string" && (RESEARCH_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * The single project a run is scored against, derived from the brand's
 * confirmed profile. Upstream resolved this from a shared JSON registry; here
 * a run can only ever see its own brand.
 */
export interface ResearchProject {
	brandId: string;
	slug: string;
	languages: string[];
	keywords: string[];
	negativeKeywords: string[];
	profileVersionId: string;
	profileHash: string;
}

/** Where a source came from. A source without provenance is rejected, never stored. */
export interface SourceProvenance {
	adapterId: ResearchAdapterId;
	platform: ResearchPlatform;
	externalId: string;
	sourceUrl: string;
	capturedAt: string;
}

export type ResearchAdapterId = "fixture" | "video-radar";

export interface ResearchSource {
	externalId: string;
	platform: ResearchPlatform;
	channelId: string;
	channelName: string;
	title: string;
	description: string;
	sourceUrl: string;
	publishedAt: string;
	durationSeconds: number | null;
	language: string | null;
	views: number | null;
	likes: number | null;
	comments: number | null;
	/** Comparable history for this source's channel, used to build the baseline. */
	channelHistory: ChannelHistoryEntry[];
	/** Repeated observations of the same source, used to measure velocity. */
	snapshots: MetricSnapshot[];
	transcript: TranscriptRecord;
	creatorPriority: number | null;
}

export interface ChannelHistoryEntry {
	externalId: string;
	publishedAt: string;
	durationSeconds: number | null;
	views: number | null;
	invalid?: boolean;
}

export interface MetricSnapshot {
	capturedAt: string;
	views: number | null;
	likes: number | null;
	comments: number | null;
}

/**
 * Transcript retrieval state. `text` is only ever present alongside
 * `AVAILABLE`; every other state carries a reason instead, so an unavailable
 * transcript can never be mistaken for an empty one.
 */
export interface TranscriptRecord {
	status: TranscriptStatus;
	language: string | null;
	text: string | null;
	failureReason: string | null;
}

export interface BaselineResult {
	baselineViews: number | null;
	sampleSize: number;
	confidence: BaselineConfidence;
	baselineVersion: string;
}

export interface OutlierResult {
	ratio: number | null;
	band: OutlierBand;
	maturity: OutlierMaturity;
	ageHours: number;
	available: boolean;
}

export interface VelocityResult {
	status: VelocityStatus;
	viewsPerHour: number | null;
	windowHours: number | null;
	snapshotCount: number;
}

export interface EngagementResult {
	likeRate: number | null;
	commentRate: number | null;
}

export interface RelevanceResult {
	score: number;
	matchedKeywords: string[];
	languageMatched: boolean;
	blockedByNegativeKeyword: boolean;
}

/** One weighted input to the candidate score, kept so a ranking can always be explained. */
export interface ScoreComponent {
	id: ScoreComponentId;
	label: string;
	/** Normalized 0..1, or null when the underlying data is genuinely missing. */
	value: number | null;
	weight: number;
	/** weight x value after renormalizing over available components; 0 when unavailable. */
	contribution: number;
	available: boolean;
}

export type ScoreComponentId =
	| "outlierSignal"
	| "confidenceSignal"
	| "relevance"
	| "freshness"
	| "engagement"
	| "velocity"
	| "creatorPriority";

export interface CandidateScore {
	score: number;
	components: ScoreComponent[];
	scoringVersion: string;
	/** Sum of the weights of components that actually had data. Low values mean a thin ranking. */
	weightCoverage: number;
}

/** A scored source plus every intermediate result the score was built from. */
export interface ScoredSource {
	source: ResearchSource;
	videoType: VideoType;
	baseline: BaselineResult;
	outlier: OutlierResult;
	relevance: RelevanceResult;
	engagement: EngagementResult;
	velocity: VelocityResult;
	score: CandidateScore;
	shortlisted: boolean;
	gateReasons: string[];
	provenance: SourceProvenance;
}

export interface ResearchOpportunity {
	/** Stable within a run, so a repeated delivery cannot duplicate opportunities. */
	key: string;
	sourceExternalId: string;
	proposedAngle: string;
	proposedHook: string;
	contentFormat: string;
	rationale: string;
	evidenceSummary: string;
	confidence: EvidenceConfidence;
	factRequirements: string[];
}

/** Every counter a run surfaces. Monetary cost is absent because Stage 1 spends nothing. */
export interface ResearchRunCounters {
	sourcesDiscovered: number;
	sourcesScored: number;
	shortlisted: number;
	transcriptsAvailable: number;
	transcriptsUnavailable: number;
	opportunitiesProduced: number;
	opportunitiesRejectedByAntiCopy: number;
	duplicateSourcesDropped: number;
	externalProviderCalls: number;
}

export function emptyRunCounters(): ResearchRunCounters {
	return {
		sourcesDiscovered: 0,
		sourcesScored: 0,
		shortlisted: 0,
		transcriptsAvailable: 0,
		transcriptsUnavailable: 0,
		opportunitiesProduced: 0,
		opportunitiesRejectedByAntiCopy: 0,
		duplicateSourcesDropped: 0,
		externalProviderCalls: 0,
	};
}

/** A failure that a run survived. Messages are normalized codes, never provider bodies. */
export interface ResearchRunFailure {
	stage: string;
	subjectId: string | null;
	code: ResearchErrorCode;
	occurredAt: string;
}

export interface ResearchRunOutcome {
	status: ResearchRunStatus;
	pipelineVersion: string;
	scoringVersion: string;
	baselineVersion: string;
	counters: ResearchRunCounters;
	failures: ResearchRunFailure[];
	scored: ScoredSource[];
	opportunities: ResearchOpportunity[];
}

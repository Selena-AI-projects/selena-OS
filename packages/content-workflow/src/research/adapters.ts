/**
 * The research adapter seam.
 *
 * Two adapters exist and they are not interchangeable in Stage 1: the fixture
 * adapter is the acceptance adapter, and the Video Radar adapter is transferred
 * code that must prove it stays shut. Every gate is checked before anything is
 * dispatched, and the adapter never receives a credential value — only the fact
 * that one is present — so there is no secret in it to leak.
 */

import { ProviderCallLedger } from "../provider-ledger";
import type {
	ChannelHistoryEntry,
	MetricSnapshot,
	ResearchAdapterId,
	ResearchProject,
	ResearchSource,
	SourceProvenance,
} from "./contracts";
import { ContentResearchError } from "./contracts";

export { ProviderCallLedger };

export interface ResearchFetchRequest {
	project: ResearchProject;
	/** Supplied by the caller so a run is reproducible rather than clock-dependent. */
	now: Date;
}

export interface ResearchFetchResult {
	sources: ResearchSource[];
	provenance: SourceProvenance[];
	externalProviderCalls: number;
}

export interface ResearchAdapter {
	readonly id: ResearchAdapterId;
	fetch(request: ResearchFetchRequest): Promise<ResearchFetchResult>;
}

/** FNV-1a. Deterministic and dependency-free; used only to shape fixture data. */
function seedFrom(value: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash;
}

function seededInt(seed: string, min: number, max: number): number {
	return min + (seedFrom(seed) % (max - min + 1));
}

/** A fixed anchor, so fixture timestamps do not move when the clock does. */
const FIXTURE_EPOCH = Date.parse("2026-01-01T00:00:00.000Z");

function isoAt(offsetHours: number): string {
	return new Date(FIXTURE_EPOCH + offsetHours * 3_600_000).toISOString();
}

function fixtureHistory(seed: string, videoTypeDurationSeconds: number, anchorHours: number): ChannelHistoryEntry[] {
	// Sixteen comparable uploads put the baseline in HIGH confidence, which is
	// what makes the fixture exercise the whole scoring path rather than the
	// unavailable branch.
	return Array.from({ length: 16 }, (_, index) => ({
		externalId: `${seed}-history-${index}`,
		publishedAt: isoAt(anchorHours - (index + 1) * 168),
		durationSeconds: videoTypeDurationSeconds,
		views: seededInt(`${seed}-history-views-${index}`, 4_000, 9_000),
	}));
}

function fixtureSnapshots(anchorHours: number, views: number): MetricSnapshot[] {
	return [
		{ capturedAt: isoAt(anchorHours + 24), views: Math.round(views * 0.6), likes: null, comments: null },
		{ capturedAt: isoAt(anchorHours + 72), views, likes: null, comments: null },
	];
}

/**
 * Deterministic research the acceptance path runs against. Output is derived
 * from the project's own vocabulary, so the fixture is meaningful for any brand
 * while staying byte-identical for a given confirmed profile.
 */
export class FixtureResearchAdapter implements ResearchAdapter {
	readonly id = "fixture" as const;

	readonly #imported: ResearchSource[] | null;

	/**
	 * `imported` carries a fixture supplied through the import path. When it is
	 * absent the adapter derives one from the project.
	 */
	constructor(imported?: ResearchSource[]) {
		this.#imported = imported ?? null;
	}

	async fetch(request: ResearchFetchRequest): Promise<ResearchFetchResult> {
		const sources = this.#imported ?? buildFixtureSources(request.project);
		return {
			sources,
			provenance: sources.map((source) => ({
				adapterId: this.id,
				platform: source.platform,
				externalId: source.externalId,
				sourceUrl: source.sourceUrl,
				capturedAt: request.now.toISOString(),
			})),
			externalProviderCalls: 0,
		};
	}
}

export function buildFixtureSources(project: ResearchProject): ResearchSource[] {
	const keywords = project.keywords.slice(0, 3);
	const primary = keywords[0] ?? project.slug;
	const secondary = keywords[1] ?? primary;
	const language = project.languages[0] ?? null;

	const specs = [
		{
			suffix: "strong-long",
			title: `What nobody explains about ${primary}`,
			description: `A walkthrough covering ${primary} and ${secondary} for teams starting out.`,
			durationSeconds: 840,
			anchorHours: -240,
			viewMultiplier: 4.2,
			creatorPriority: 5,
			transcriptAvailable: true,
		},
		{
			suffix: "strong-short",
			title: `${primary} in ninety seconds`,
			description: `A short take on ${primary}.`,
			durationSeconds: 90,
			anchorHours: -180,
			viewMultiplier: 3.1,
			creatorPriority: 4,
			transcriptAvailable: true,
		},
		{
			suffix: "ordinary",
			title: `Weekly update on ${secondary}`,
			description: `Routine coverage of ${secondary}.`,
			durationSeconds: 600,
			anchorHours: -600,
			viewMultiplier: 1.05,
			creatorPriority: 2,
			transcriptAvailable: false,
		},
	];

	return specs.map((spec) => {
		const seed = `${project.profileHash}-${spec.suffix}`;
		const baselineViews = seededInt(`${seed}-baseline`, 5_000, 7_000);
		const views = Math.round(baselineViews * spec.viewMultiplier);
		return {
			externalId: `fixture-${spec.suffix}`,
			platform: "youtube" as const,
			channelId: `fixture-channel-${spec.suffix}`,
			channelName: `Fixture Channel ${spec.suffix}`,
			title: spec.title,
			description: spec.description,
			sourceUrl: `https://example.test/fixture/${spec.suffix}`,
			publishedAt: isoAt(spec.anchorHours),
			durationSeconds: spec.durationSeconds,
			language,
			views,
			likes: Math.round(views * 0.05),
			comments: Math.round(views * 0.004),
			channelHistory: fixtureHistory(seed, spec.durationSeconds, spec.anchorHours),
			snapshots: fixtureSnapshots(spec.anchorHours, views),
			transcript: spec.transcriptAvailable
				? {
						status: "AVAILABLE" as const,
						language,
						text: `Fixture transcript discussing ${primary}.`,
						failureReason: null,
					}
				: // An absent transcript is recorded as absent. There is no state that
					// means the text was invented.
					{ status: "UNAVAILABLE" as const, language: null, text: null, failureReason: "NO_TRANSCRIPT_PUBLISHED" },
			creatorPriority: spec.creatorPriority,
		};
	});
}

/**
 * Gates that must all hold before the Video Radar adapter may dispatch.
 * `credentialPresent` is a boolean on purpose: the adapter is never given a
 * credential value, so it cannot log, persist or leak one.
 */
export interface VideoRadarAdapterGates {
	liveProviderEnabled: boolean;
	maxProviderCalls: number | null;
	credentialPresent: boolean;
}

export type VideoRadarDispatch = (request: ResearchFetchRequest) => Promise<ResearchFetchResult>;

/**
 * Transferred Video Radar behavior behind its own independent gates.
 *
 * Stage 1 constructs it with the gates closed and no dispatcher, and the
 * acceptance evidence is that constructing it changes nothing: every path below
 * throws before touching the dispatcher, and the ledger stays empty.
 */
export class VideoRadarAdapter implements ResearchAdapter {
	readonly id = "video-radar" as const;

	readonly #gates: VideoRadarAdapterGates;
	readonly #ledger: ProviderCallLedger;
	readonly #dispatch: VideoRadarDispatch | null;

	constructor(options: {
		gates: VideoRadarAdapterGates;
		ledger: ProviderCallLedger;
		dispatch?: VideoRadarDispatch;
	}) {
		this.#gates = options.gates;
		this.#ledger = options.ledger;
		this.#dispatch = options.dispatch ?? null;
	}

	async fetch(request: ResearchFetchRequest): Promise<ResearchFetchResult> {
		// Each gate is checked separately and reported with its own code, so a
		// test can prove any one of them alone keeps the adapter shut.
		if (!this.#gates.liveProviderEnabled) {
			throw new ContentResearchError("ADAPTER_DISABLED", "The live research provider is disabled");
		}
		if (typeof this.#gates.maxProviderCalls !== "number" || this.#gates.maxProviderCalls <= 0) {
			throw new ContentResearchError("PROVIDER_QUOTA_EXCEEDED", "No research provider call ceiling is configured");
		}
		if (!this.#gates.credentialPresent) {
			throw new ContentResearchError("PROVIDER_AUTH_FAILED", "No research provider credential is configured");
		}
		if (!this.#dispatch) {
			throw new ContentResearchError("PROVIDER_UNAVAILABLE", "No research provider transport is configured");
		}
		if (this.#ledger.count >= this.#gates.maxProviderCalls) {
			throw new ContentResearchError("PROVIDER_QUOTA_EXCEEDED", "The research provider call ceiling is exhausted");
		}

		this.#ledger.record(this.id, request.now);
		return this.#dispatch(request);
	}
}

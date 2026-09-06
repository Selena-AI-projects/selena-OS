/**
 * The creation adapter seam.
 *
 * Same shape as the research seam and for the same reason: the fixture adapter
 * is the acceptance adapter, and the Gemini adapter is code that must prove it
 * stays shut. Every gate is checked separately, before anything is dispatched,
 * and the adapter is never given a credential value — only the fact that one
 * exists — so there is no secret in it to leak.
 *
 * Gemini's own client (`server/gemini.ts` upstream, 48 KB of prompt assembly and
 * HTTP) is deliberately not transferred. What is transferred is the contract its
 * output had to satisfy; the transport is a later decision that needs a call
 * authorization and a budget, and code that cannot dispatch cannot be made to
 * dispatch by a configuration mistake.
 */

import { ProviderCallLedger } from "../provider-ledger";
import type {
	ContentFormat,
	EvidenceClaim,
	IdeaGenerationOutput,
	IdeaPackage,
	ResearchEvidenceContext,
	ScriptEvidenceContext,
	ScriptGenerationOutput,
	TargetAudience,
} from "./contracts";
import { ContentCreationError, IDEA_PACKAGE_COUNT } from "./contracts";

export { ProviderCallLedger };

export type CreationAdapterId = "fixture" | "gemini";

export interface IdeaGenerationRequest {
	evidence: ResearchEvidenceContext;
	/** The brand's own vocabulary, so fixture output is meaningful per brand. */
	projectSlug: string;
	profileHash: string;
	languages: string[];
	audience: TargetAudience;
	/** Supplied by the caller so a generation is reproducible rather than clock-dependent. */
	now: Date;
}

export interface ScriptGenerationRequest {
	evidence: ScriptEvidenceContext;
	projectSlug: string;
	profileHash: string;
	languages: string[];
	audience: TargetAudience;
	now: Date;
}

export interface CreationResult<Output> {
	output: Output;
	externalProviderCalls: number;
}

export interface CreationAdapter {
	readonly id: CreationAdapterId;
	generateIdeas(request: IdeaGenerationRequest): Promise<CreationResult<IdeaGenerationOutput>>;
	generateScript(request: ScriptGenerationRequest): Promise<CreationResult<ScriptGenerationOutput>>;
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

function pick<T>(seed: string, options: readonly T[]): T {
	return options[seedFrom(seed) % options.length];
}

const FIXTURE_FORMATS: readonly ContentFormat[] = ["LONG_FORM", "SHORT", "TUTORIAL", "REVIEW", "VLOG", "LONG_FORM"];

const FIXTURE_ANGLES = [
	"the step everyone skips",
	"what the numbers actually say",
	"the version that survives a slow week",
	"where this breaks first",
	"the shortest honest explanation",
	"what to do before you buy anything",
] as const;

/**
 * Deterministic ideas the acceptance path runs against.
 *
 * Every idea carries evidence drawn from the run's own claims: the fixture must
 * satisfy the same membership rule a live adapter would, or acceptance would be
 * proving a weaker property than production needs.
 */
export class FixtureCreationAdapter implements CreationAdapter {
	readonly id = "fixture" as const;

	async generateIdeas(request: IdeaGenerationRequest): Promise<CreationResult<IdeaGenerationOutput>> {
		const claims = request.evidence.evidenceClaims;
		const ideas: IdeaPackage[] = Array.from({ length: IDEA_PACKAGE_COUNT }, (_, index) => {
			const seed = `${request.profileHash}-${request.evidence.opportunityKey}-${index}`;
			const angle = FIXTURE_ANGLES[index];
			// Rotating through the claims keeps every idea evidence-bearing even when
			// the run produced fewer claims than there are ideas.
			const claim = claims[index % claims.length];
			return {
				title: `${request.projectSlug}: ${angle}`,
				description: `An angle on ${request.projectSlug} built from ${claim.claim}`,
				keywords: [request.projectSlug, angle.split(" ")[0]],
				format: FIXTURE_FORMATS[index],
				difficulty: pick(`${seed}-difficulty`, ["EASY", "MEDIUM", "HARD", "ADVANCED"] as const),
				honestPromise: `Explains ${angle} without promising a result the evidence does not support.`,
				discoverySurface: pick(`${seed}-surface`, ["SEARCH", "BROWSE", "SUGGESTED", "SHORTS_FEED", "MIXED"] as const),
				payoff: `The viewer leaves knowing ${angle}.`,
				thumbnailConcept: `A single frame naming ${angle}, no face, no arrow.`,
				studioMetric: "Average view duration against the channel's own median for this format.",
				experimentRule: "Change one variable per upload and compare against the previous three.",
				evidenceClaims: [claim],
			};
		});
		return { output: { ideas }, externalProviderCalls: 0 };
	}

	async generateScript(request: ScriptGenerationRequest): Promise<CreationResult<ScriptGenerationOutput>> {
		const idea = request.evidence.ideaPackage;
		const claims: EvidenceClaim[] = [...request.evidence.evidenceClaims, ...idea.evidenceClaims];
		const claimIds = [...new Set(claims.map((claim) => claim.id))];
		return {
			output: {
				titles: [idea.title, `${idea.title} — what changes`, `${idea.title}, briefly`],
				hook: `${idea.honestPromise}`,
				structure: [
					{ section: "Open", purpose: "State the promise and what it is not.", evidenceClaimIds: [] },
					{
						section: "Evidence",
						purpose: "Show what the research run actually observed.",
						evidenceClaimIds: claimIds.slice(0, 8),
					},
					{ section: "Payoff", purpose: idea.payoff, evidenceClaimIds: [] },
				],
				script: [
					idea.honestPromise,
					...claims.map((claim) => `${claim.claim} (${claim.evidenceClass.toLowerCase()}, ${claim.confidence})`),
					idea.payoff,
				].join("\n\n"),
				payoff: idea.payoff,
				primaryCta: "Ask for the one process you would automate first.",
				studioValidation: idea.studioMetric,
			},
			externalProviderCalls: 0,
		};
	}
}

/**
 * Gates that must all hold before the Gemini adapter may dispatch.
 * `credentialPresent` is a boolean on purpose.
 */
export interface GeminiAdapterGates {
	liveProviderEnabled: boolean;
	maxProviderCalls: number | null;
	credentialPresent: boolean;
}

export interface GeminiDispatch {
	generateIdeas(request: IdeaGenerationRequest): Promise<CreationResult<IdeaGenerationOutput>>;
	generateScript(request: ScriptGenerationRequest): Promise<CreationResult<ScriptGenerationOutput>>;
}

/**
 * The Gemini adapter behind its own independent gates, separate from research's.
 *
 * Stage 1 constructs it with the gates closed and no dispatcher, and the
 * acceptance evidence is that constructing it changes nothing: every path below
 * throws before touching the dispatcher, and the ledger stays empty.
 */
export class GeminiCreationAdapter implements CreationAdapter {
	readonly id = "gemini" as const;

	readonly #gates: GeminiAdapterGates;
	readonly #ledger: ProviderCallLedger;
	readonly #dispatch: GeminiDispatch | null;

	constructor(options: { gates: GeminiAdapterGates; ledger: ProviderCallLedger; dispatch?: GeminiDispatch }) {
		this.#gates = options.gates;
		this.#ledger = options.ledger;
		this.#dispatch = options.dispatch ?? null;
	}

	#assertOpen(): GeminiDispatch {
		// Each gate is checked separately and reported with its own code, so a test
		// can prove any one of them alone keeps the adapter shut.
		if (!this.#gates.liveProviderEnabled) {
			throw new ContentCreationError("ADAPTER_DISABLED", "The live creation provider is disabled");
		}
		if (typeof this.#gates.maxProviderCalls !== "number" || this.#gates.maxProviderCalls <= 0) {
			throw new ContentCreationError("PROVIDER_QUOTA_EXCEEDED", "No creation provider call ceiling is configured");
		}
		if (!this.#gates.credentialPresent) {
			throw new ContentCreationError("PROVIDER_AUTH_FAILED", "No creation provider credential is configured");
		}
		if (!this.#dispatch) {
			throw new ContentCreationError("PROVIDER_UNAVAILABLE", "No creation provider transport is configured");
		}
		if (this.#ledger.count >= this.#gates.maxProviderCalls) {
			throw new ContentCreationError("PROVIDER_QUOTA_EXCEEDED", "The creation provider call ceiling is exhausted");
		}
		return this.#dispatch;
	}

	async generateIdeas(request: IdeaGenerationRequest): Promise<CreationResult<IdeaGenerationOutput>> {
		const dispatch = this.#assertOpen();
		this.#ledger.record(this.id, request.now);
		return dispatch.generateIdeas(request);
	}

	async generateScript(request: ScriptGenerationRequest): Promise<CreationResult<ScriptGenerationOutput>> {
		const dispatch = this.#assertOpen();
		this.#ledger.record(this.id, request.now);
		return dispatch.generateScript(request);
	}
}

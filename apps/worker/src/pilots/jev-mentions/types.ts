import type { Brand, Competitor } from "@workspace/lib/db/schema";

/** One (brand-or-competitor) entity the pilot checks the answer text against. */
export interface MentionEntity {
	id: string;
	name: string;
	aliases: string[];
	domains: string[];
}

export interface MentionClassifyInput {
	/** The AI-engine answer text to check. */
	text: string;
	brand: Brand;
	competitors: Competitor[];
}

export type MentionVerdict = "yes" | "no" | "ambiguous";

export interface EntityVerdict {
	entityId: string;
	entityName: string;
	verdict: MentionVerdict;
	/** Probability of "yes" reported by Jev's Noul primitive; absent when the fallback path answered instead. */
	probability?: number;
}

export type ClassifyOutcome =
	| { status: "insufficient_data"; reason: string }
	| { status: "fallback"; reason: string; heuristic: { brandMentioned: boolean; competitorsMentioned: string[] } }
	| {
			status: "jev";
			model: string;
			usage: { inputTokens: number; outputTokens: number };
			entities: EntityVerdict[];
			/** From entities where verdict === "ambiguous" (probability inside the gate's dead zone). */
			ambiguousCount: number;
	  }
	| { status: "dry_run"; wouldSend: DryRunPayload };

export interface DryRunPayload {
	state: unknown;
	questions: Record<string, unknown>;
	model: string;
}

export interface ClassifyOptions {
	/** Master kill switch. When false, skips Jev entirely and returns the fallback heuristic. Default: reads JEV_PILOT_ENABLED env var. */
	enabled?: boolean;
	/** When true, builds the request and returns it without calling the network. Default: false. */
	dryRun?: boolean;
	/** Noul probability at/above which a mention counts as "yes". Default: 0.7. */
	yesThreshold?: number;
	/** Noul probability at/below which a mention counts as "no". Default: 0.3. Between the two thresholds is "ambiguous". */
	noThreshold?: number;
	/** Per-attempt request timeout in ms, forwarded to the SDK. Default: 8000. */
	timeoutMs?: number;
	/** Max retries after the initial attempt, forwarded to the SDK. Default: 1 (the SDK default is 2; the pilot is deliberately more conservative). */
	maxRetries?: number;
}

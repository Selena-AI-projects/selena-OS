import { APIError, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import type { Brand, Competitor } from "@workspace/lib/db/schema";
import type {
	ClassifyOptions,
	ClassifyOutcome,
	DryRunPayload,
	EntityVerdict,
	MentionClassifyInput,
	MentionEntity,
} from "./types";

const DEFAULT_YES_THRESHOLD = 0.7;
const DEFAULT_NO_THRESHOLD = 0.3;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_RETRIES = 1;

/**
 * Isolated copy of apps/worker/src/jobs/process-prompt.ts's `extractDomainFromUrl` /
 * `analyzeMentions`. Duplicated deliberately (pilot code must not import from or
 * modify the live job files) and must be kept in sync by hand if the original changes.
 */
function extractDomainFromUrl(urlOrDomain: string): string {
	try {
		const url = new URL(urlOrDomain.startsWith("http") ? urlOrDomain : `https://${urlOrDomain}`);
		return url.hostname.replace(/^www\./, "").toLowerCase();
	} catch {
		return urlOrDomain.replace(/^www\./, "").toLowerCase();
	}
}

export function heuristicMentions(
	text: string,
	brand: Brand,
	competitors: Competitor[],
): { brandMentioned: boolean; competitorsMentioned: string[] } {
	const contentLower = text.toLowerCase();

	const brandNames = [brand.name, ...(brand.aliases || [])].map((n) => n.toLowerCase());
	const brandDomains = [
		extractDomainFromUrl(brand.website),
		...(brand.additionalDomains || []).map(extractDomainFromUrl),
	];
	const brandMentioned =
		brandNames.some((n) => contentLower.includes(n)) || brandDomains.some((d) => contentLower.includes(d));

	const competitorsMentioned = competitors
		.filter((competitor) => {
			const names = [competitor.name, ...(competitor.aliases || [])].map((n) => n.toLowerCase());
			const nameMatch = names.some((n) => contentLower.includes(n));
			const domainMatch = (competitor.domains || []).some((d) => contentLower.includes(extractDomainFromUrl(d)));
			return nameMatch || domainMatch;
		})
		.map((c) => c.name);

	return { brandMentioned, competitorsMentioned };
}

function buildEntities(brand: Brand, competitors: Competitor[]): MentionEntity[] {
	const entities: MentionEntity[] = [
		{
			id: "brand",
			name: brand.name,
			aliases: brand.aliases || [],
			domains: [brand.website, ...(brand.additionalDomains || [])].filter(Boolean),
		},
	];
	for (const c of competitors) {
		entities.push({
			id: `competitor:${c.name}`,
			name: c.name,
			aliases: c.aliases || [],
			domains: c.domains || [],
		});
	}
	return entities;
}

function questionKey(index: number): string {
	return `entity_${index}`;
}

/**
 * One Noul (yes/no) question per entity: "is this entity referred to in the text,
 * directly, by alias, by domain, or by unambiguous paraphrase" — the semantic gap the
 * existing substring-match heuristic cannot close. All questions run in parallel over
 * the same state (per the TypeSafe skill's composition guidance): one request, not one
 * call per entity.
 */
function buildQuestions(text: string, entities: MentionEntity[]) {
	const state = {
		answer_text: text,
		entities: entities.map((e) => ({ name: e.name, aliases: e.aliases, domains: e.domains })),
	};
	const questions: Record<string, ReturnType<typeof noul>> = {};
	entities.forEach((entity, i) => {
		questions[questionKey(i)] = noul(
			`Does \`answer_text\` refer to the entity at \`entities[${i}]\` — by its name, an alias, a domain, or an unambiguous paraphrase (not a negated, hypothetical, or unrelated same-word mention)?`,
			{
				true: "The text clearly refers to this entity as a real, present subject.",
				false: "The text does not refer to this entity, or only negates/hypothesizes about it.",
			},
		);
	});
	return { state, questions };
}

export function describeDryRunPayload(input: MentionClassifyInput): DryRunPayload {
	const entities = buildEntities(input.brand, input.competitors);
	const { state, questions } = buildQuestions(input.text, entities);
	return { state, questions, model: process.env.TYPESAFE_DEFAULT_MODEL || "jev-latest" };
}

function isPilotEnabled(explicit: boolean | undefined): boolean {
	if (explicit !== undefined) return explicit;
	return process.env.JEV_PILOT_ENABLED === "true";
}

export async function classifyMentions(
	input: MentionClassifyInput,
	options: ClassifyOptions = {},
): Promise<ClassifyOutcome> {
	const text = input.text?.trim() ?? "";
	if (text.length === 0) {
		return { status: "insufficient_data", reason: "empty answer text" };
	}
	const entities = buildEntities(input.brand, input.competitors);
	if (!input.brand?.name) {
		return { status: "insufficient_data", reason: "brand has no name" };
	}

	if (!isPilotEnabled(options.enabled)) {
		return {
			status: "fallback",
			reason: "JEV_PILOT_ENABLED is not \"true\" (kill switch)",
			heuristic: heuristicMentions(input.text, input.brand, input.competitors),
		};
	}

	const { state, questions } = buildQuestions(text, entities);

	if (options.dryRun) {
		return { status: "dry_run", wouldSend: { state, questions, model: process.env.TYPESAFE_DEFAULT_MODEL || "jev-latest" } };
	}

	const yesThreshold = options.yesThreshold ?? DEFAULT_YES_THRESHOLD;
	const noThreshold = options.noThreshold ?? DEFAULT_NO_THRESHOLD;

	let client: TypeSafeClient;
	try {
		client = new TypeSafeClient({
			timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			retry: { maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES },
		});
	} catch (err) {
		// Missing/invalid TYPESAFE_API_KEY throws synchronously from the constructor.
		return {
			status: "fallback",
			reason: `client construction failed: ${err instanceof Error ? err.message : String(err)}`,
			heuristic: heuristicMentions(input.text, input.brand, input.competitors),
		};
	}

	try {
		const result = await client.systemOne({ state, questions });
		const entityVerdicts: EntityVerdict[] = entities.map((entity, i) => {
			const answer = result.answers[questionKey(i)];
			const probability = answer.noul;
			const verdict = probability >= yesThreshold ? "yes" : probability <= noThreshold ? "no" : "ambiguous";
			return { entityId: entity.id, entityName: entity.name, verdict, probability };
		});
		return {
			status: "jev",
			model: result.model,
			usage: { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens },
			entities: entityVerdicts,
			ambiguousCount: entityVerdicts.filter((e) => e.verdict === "ambiguous").length,
		};
	} catch (err) {
		const reason =
			err instanceof APIError
				? `API error ${err.status}: ${err.message}`
				: err instanceof Error
					? err.message
					: String(err);
		return {
			status: "fallback",
			reason: `Jev call failed, used fallback: ${reason}`,
			heuristic: heuristicMentions(input.text, input.brand, input.competitors),
		};
	}
}

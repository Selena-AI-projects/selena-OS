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
 * Isolated copy of the canonical baseline this pilot targets: `analyzeMentions` /
 * `extractDomainFromUrl` in apps/worker/src/jobs/process-prompt.ts:214-242 — chosen
 * over the second, separately-drifted copy in report-worker.ts:174-209, which lacks
 * alias support and takes a different Competitor shape (`.domain` singular vs
 * `.domains` array). process-prompt.ts's version is also the one driving the
 * recurring 24h tracking job, not just report generation.
 *
 * Duplicated on purpose rather than imported (pilot code must not import from or
 * modify the live job files) and NOT merged with report-worker.ts's variant.
 * classifier.test.ts pins this copy against process-prompt.ts's live source, so an
 * edit to the original there breaks the test instead of silently invalidating this
 * baseline.
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
 * One Noul (yes/no) question per entity, testing entity ATTRIBUTION only — is
 * `answer_text` talking about this specific real-world entity, as opposed to a
 * coincidental same-name/same-word match with something else (a different product, a
 * character, a common word, an unrelated person)? All questions run in parallel over
 * the same state (per the TypeSafe skill's composition guidance): one request, not one
 * call per entity.
 *
 * Deliberately excludes sentiment/stance/modality (negation, hypotheticals, tone) from
 * the criteria: this product's `brandMentioned` metric counts topical presence of the
 * correctly-attributed entity regardless of stance (see JEV-PILOT.md's metric-semantics
 * section) — an earlier version of this question asked the model to also exclude
 * negated/hypothetical mentions, which tested stance instead of attribution and
 * produced a mismatch against that corrected metric. This wording was fixed once,
 * before the collision benchmark was built, and is not iterated per-example.
 */
function buildQuestions(text: string, entities: MentionEntity[]) {
	const state = {
		answer_text: text,
		entities: entities.map((e) => ({ name: e.name, aliases: e.aliases, domains: e.domains })),
	};
	const questions: Record<string, ReturnType<typeof noul>> = {};
	entities.forEach((entity, i) => {
		questions[questionKey(i)] = noul(
			`Is \`answer_text\` talking about the specific entity at \`entities[${i}]\` — referring to it by name, an alias, a domain, or an unambiguous paraphrase — as opposed to a coincidental same-name or same-word match with a different real-world thing (e.g. a different product, a fictional character, a common word, an unrelated person)? Judge only which entity is being talked about. Ignore whether the text is positive, negative, a denial, or hypothetical about it — a negated or dismissive reference to the correct entity still counts as "true".`,
			{
				true: "The text is clearly discussing this specific, correctly-identified real-world entity — regardless of tone, sentiment, or whether it affirms or denies something about it.",
				false: "The text does not discuss this entity at all, or the same name/word there refers to something else.",
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
	// Checked before buildEntities: a null/undefined brand (not just a nameless one)
	// would otherwise throw inside buildEntities instead of failing closed here.
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

	if (options.dryRun) {
		return { status: "dry_run", wouldSend: describeDryRunPayload(input) };
	}

	const entities = buildEntities(input.brand, input.competitors);
	const { state, questions } = buildQuestions(text, entities);

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

	const startedAt = Date.now();
	try {
		const result = await client.systemOne({ state, questions });
		const latencyMs = Date.now() - startedAt;
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
			latencyMs,
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

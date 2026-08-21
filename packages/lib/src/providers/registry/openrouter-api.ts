import { WEB_QUERIES_UNAVAILABLE } from "../../constants";
import type { Citation } from "../../text-extraction";
import { warnIfOutputCapped } from "../config";
import type { Provider, ProviderOptions, ScrapeResult } from "../types";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_DEFAULT_MAX_TOKENS = 1200;
export const OPENROUTER_MIN_MAX_TOKENS = 1;
export const OPENROUTER_MAX_MAX_TOKENS = 4000;
export const OPENROUTER_API_MODELS = [
	"anthropic/claude-haiku-4.5",
	"deepseek/deepseek-v3.2",
	"qwen/qwen3.5-9b",
	"mistralai/mistral-small-2603",
	"x-ai/grok-4.5",
] as const;

type OpenRouterApiResponse = {
	model?: string;
	provider?: string;
	choices?: Array<{
		finish_reason?: string | null;
		message?: { content?: string | null; annotations?: unknown[]; reasoning?: unknown; reasoning_details?: unknown[] };
	}>;
	usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number | null };
	error?: unknown;
};

function extractCitations(data: OpenRouterApiResponse): Citation[] {
	const annotations = data.choices?.[0]?.message?.annotations ?? [];
	const seen = new Set<string>();
	return annotations.flatMap((annotation: unknown, index) => {
		const item = annotation as { url_citation?: { url?: unknown; title?: string }; url?: unknown; title?: string };
		const citation = item.url_citation ?? item;
		const url = citation?.url;
		if (typeof url !== "string" || !url.startsWith("http") || seen.has(url)) return [];
		seen.add(url);
		try {
			return [
				{ url, title: citation.title, domain: new URL(url).hostname.replace(/^www\./, ""), citationIndex: index },
			];
		} catch {
			return [];
		}
	});
}

function assertModel(model: string): void {
	if (!(OPENROUTER_API_MODELS as readonly string[]).includes(model)) {
		throw new Error(`openrouter-api requires one of the verified model IDs; received "${model}"`);
	}
}

export function getOpenRouterMaxTokens(env: Record<string, string | undefined> = process.env): number {
	const raw = env.OPENROUTER_MAX_TOKENS;
	if (raw === undefined || raw.trim() === "") return OPENROUTER_DEFAULT_MAX_TOKENS;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < OPENROUTER_MIN_MAX_TOKENS || parsed > OPENROUTER_MAX_MAX_TOKENS) {
		return OPENROUTER_DEFAULT_MAX_TOKENS;
	}
	return parsed;
}

export const openrouterApi: Provider = {
	id: "openrouter-api",
	name: "OpenRouter API View",
	access: "api",
	docsAnchor: "direct-model-apis",

	isConfigured() {
		return Boolean(process.env.OPENROUTER_API_KEY);
	},

	validateTarget(config) {
		if (config.webSearch) return "openrouter-api is API View and does not enable web search";
		if (!config.version) return "openrouter-api requires the full verified model ID as version";
		try {
			assertModel(config.version);
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
		return null;
	},

	async run(_model: string, prompt: string, options?: ProviderOptions): Promise<ScrapeResult> {
		const requestedModel = options?.version;
		if (!requestedModel) throw new Error("openrouter-api requires a full model ID in SCRAPE_TARGETS");
		assertModel(requestedModel);
		if (options?.webSearch)
			throw new Error("openrouter-api does not support web search; use API View with webSearch=false");
		const maxTokens = Math.min(getOpenRouterMaxTokens(), options?.maxOutputTokens ?? Number.POSITIVE_INFINITY);
		const response = await fetch(OPENROUTER_API_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
				"Content-Type": "application/json",
				"HTTP-Referer": process.env.APP_URL ?? "https://github.com/elmohq/elmo",
				"X-Title": "Elmo OpenRouter API View",
			},
			body: JSON.stringify({
				model: requestedModel,
				messages: [{ role: "user", content: prompt }],
				max_tokens: maxTokens,
				usage: { include: true },
				...(requestedModel === "qwen/qwen3.5-9b" ? { reasoning: { effort: "none" } } : {}),
			}),
		});
		if (!response.ok) throw new Error(`OpenRouter API error (${response.status}): ${await response.text()}`);
		const data = (await response.json()) as OpenRouterApiResponse;
		const choice = data.choices?.[0];
		const content = choice?.message?.content ?? "";
		const citations = extractCitations(data);
		warnIfOutputCapped("openrouter-api", requestedModel, choice?.finish_reason);
		return {
			rawOutput: {
				...data,
				channel: "API View",
				requested_model: requestedModel,
				response_model: data.model ?? null,
				content,
				provider: data.provider ?? null,
				prompt_tokens: data.usage?.prompt_tokens ?? null,
				completion_tokens: data.usage?.completion_tokens ?? null,
				total_tokens: data.usage?.total_tokens ?? null,
				usage_cost: data.usage?.cost ?? null,
				finish_reason: choice?.finish_reason ?? null,
				citations: choice?.message?.annotations ?? [],
				annotations: choice?.message?.annotations ?? [],
				web_search_enabled: false,
			},
			textContent: content,
			webQueries: citations.length > 0 ? [WEB_QUERIES_UNAVAILABLE] : [],
			citations,
			modelVersion: data.model ?? requestedModel,
		};
	},
};

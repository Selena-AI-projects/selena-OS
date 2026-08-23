import { createHash } from "node:crypto";
import {
	answerRetainUntil,
	apiModelIds,
	isApiViewWebSearchEnabled,
	type RunOutcome,
	runMeasurementSchema,
	runOutcomeSchema,
} from "@workspace/selena-visibility-contracts";
import { type ExtractionContext, extractMeasurement } from "../selena-answer-extraction";
import type { SelenaExecutablePermit, SelenaMeasurementAdapter, SelenaMeasurementPermit } from "../selena-measurement";
import { estimateRunCostUsd } from "../usage/cost";

// The provider seam for API View, and the only thing in this package that
// speaks HTTP to a model vendor. It stays selectable only by an owner code
// change: the execution contract's inert allowlist refuses "openrouter" even
// once it is registered in the worker, so importing this module cannot by
// itself turn spend on.

const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_API_VIEW_MODEL = "anthropic/claude-haiku-4.5";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 1200;
/** A measurement answer is prose; anything past this is a runaway response. */
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;

export type OpenRouterAdapterDeps = {
	apiKey: string;
	/** Full OpenRouter model id, e.g. one of the catalog's API View models. */
	model: string;
	/**
	 * Transport is injected rather than read off the global: it is what lets a
	 * test exercise this module without a network, and what keeps the single
	 * outbound call visible in the wiring instead of hidden in the module.
	 */
	fetchImpl: typeof fetch;
	/**
	 * A permit carries a scenario id, not the scenario text, and this module
	 * holds no database imports — the caller resolves the text for the tenant
	 * that owns the permit.
	 */
	resolveScenarioText: (permit: SelenaExecutablePermit) => Promise<string> | string;
	/**
	 * Brand, competitor and domain terms for extraction, resolved per permit
	 * like the scenario text. Optional: without it the run is stored with its
	 * raw response only, and extraction can be re-run from that later.
	 */
	resolveExtractionContext?: (permit: SelenaExecutablePermit) => Promise<ExtractionContext> | ExtractionContext;
	/** The sold system name this model answers for; defaults to the model id. */
	system?: string;
	now?: () => Date;
	referer?: string;
	title?: string;
	maxOutputTokens?: number;
	timeoutMs?: number;
	maxResponseBytes?: number;
};

type OpenRouterUsage = {
	prompt_tokens?: number | null;
	completion_tokens?: number | null;
	cost?: number | null;
};

type OpenRouterCompletionResponse = {
	id?: string | null;
	choices?: Array<{ message?: { content?: string | null } | null } | null> | null;
	usage?: OpenRouterUsage | null;
};

/** Whether a cost came from the provider or from the local estimate. */
export type OpenRouterCostBasis = "provider_reported" | "estimated";

class ResponseTooLargeError extends Error {}

export function resolveOpenRouterCost(usage?: OpenRouterUsage | null): {
	costUsd: number | null;
	basis: OpenRouterCostBasis;
} {
	const reported = usage?.cost;
	if (typeof reported === "number" && Number.isFinite(reported) && reported >= 0)
		return { costUsd: reported, basis: "provider_reported" };
	// API View never enables web search, so the estimate is taken at the
	// contract's setting instead of guessing a surcharge that cannot apply.
	return { costUsd: estimateRunCostUsd("openrouter", isApiViewWebSearchEnabled()), basis: "estimated" };
}

function tokenCount(value: number | null | undefined): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function tokenUsageFrom(usage?: OpenRouterUsage | null): { input: number; output: number } | undefined {
	const input = tokenCount(usage?.prompt_tokens);
	const output = tokenCount(usage?.completion_tokens);
	// A half-reported usage block is not evidence of anything; storing a zero
	// for the missing half would read as a measured value.
	return input === undefined || output === undefined ? undefined : { input, output };
}

/**
 * A handle, never the payload. The raw answer belongs in private storage, so
 * what the run row keeps is the provider's own generation id — which is how
 * the same call is looked up again on OpenRouter's side — or, when the response
 * carries none, a digest of the body that identifies it without revealing it.
 */
function rawResponseReference(id: string | null | undefined, rawBody: string): string {
	if (typeof id === "string" && id.trim() !== "") return `openrouter:${id.trim()}`;
	return `openrouter:sha256:${createHash("sha256").update(rawBody).digest("hex")}`;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

type CostFields = Pick<RunOutcome, "costUsd" | "costBasis" | "provider">;

/**
 * §10.2: once a request has been dispatched the charge may exist whether or
 * not a usable answer came back, so every post-dispatch outcome carries a
 * cost — the provider's reported figure when the payload names one, the
 * estimate otherwise. An unrecorded charge is how a cap alert reads $0 while
 * a broken cycle burns real budget.
 */
function costFields(usage?: OpenRouterUsage | null): CostFields {
	const { costUsd, basis } = resolveOpenRouterCost(usage);
	return costUsd === null
		? {}
		: {
				costUsd,
				costBasis: basis === "provider_reported" ? ("actual" as const) : ("estimated" as const),
				provider: "openrouter",
			};
}

function invalidOutcome(permit: SelenaExecutablePermit, reason: string, cost: CostFields = {}): RunOutcome {
	return { dispatchKey: permit.dispatchKey, status: "INVALID", validity: "INVALID", invalidReason: reason, ...cost };
}

function failedOutcome(permit: SelenaExecutablePermit, reason: string, cost: CostFields = {}): RunOutcome {
	return { dispatchKey: permit.dispatchKey, status: "FAILED", validity: "INVALID", invalidReason: reason, ...cost };
}

async function readBodyWithinLimit(response: Response, limitBytes: number): Promise<string> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > limitBytes) throw new ResponseTooLargeError();
	const body = response.body;
	if (!body) {
		const text = await response.text();
		if (new TextEncoder().encode(text).byteLength > limitBytes) throw new ResponseTooLargeError();
		return text;
	}
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let received = 0;
	let text = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		received += value.byteLength;
		// Stop pulling rather than buffer first and measure after: an oversized
		// body must not be able to exhaust the worker's memory.
		if (received > limitBytes) {
			await reader.cancel();
			throw new ResponseTooLargeError();
		}
		text += decoder.decode(value, { stream: true });
	}
	return text + decoder.decode();
}

/**
 * API View measurement over OpenRouter. One permit produces exactly one
 * request; every outcome path returns the permit's dispatch key, because the
 * executor refuses an outcome whose key does not match the permit it spent.
 */
/**
 * A run measures the model the customer bought, so only a catalog API View id
 * may be selected. Resolving it here keeps the caller free of the catalog and
 * turns a mistyped model into a refusal at startup rather than a measurement
 * of something nobody sold.
 */
export function resolveCatalogApiModel(value: string | undefined): string {
	const requested = value?.trim() || DEFAULT_API_VIEW_MODEL;
	if (!(apiModelIds as readonly string[]).includes(requested))
		throw new Error(`SELENA_OPENROUTER_MODEL must be a catalog API View model id, got "${requested}"`);
	return requested;
}

export function createOpenRouterAdapter(deps: OpenRouterAdapterDeps): SelenaMeasurementAdapter {
	if (deps.apiKey.trim() === "") throw new Error("OPENROUTER_API_KEY_MISSING");
	if (deps.model.trim() === "") throw new Error("OPENROUTER_MODEL_MISSING");
	const now = deps.now ?? (() => new Date());
	const maxOutputTokens = deps.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
	const maxResponseBytes = deps.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

	async function execute(permit: SelenaExecutablePermit): Promise<RunOutcome> {
		let scenarioText: string;
		try {
			scenarioText = (await deps.resolveScenarioText(permit)).trim();
		} catch {
			// Resolution failures are not the provider's; failing here means no
			// request is made, so the permit is spent without spend.
			return failedOutcome(permit, "SCENARIO_TEXT_UNAVAILABLE");
		}
		if (scenarioText === "") return failedOutcome(permit, "SCENARIO_TEXT_UNAVAILABLE");

		const controller = new AbortController();
		// The permit is the authorization window: a call that outlives it would
		// return an answer nothing is allowed to record any more.
		const budgetMs = permit.expiresAt.getTime() - now().getTime();
		const timeoutMs = Math.max(1, Math.min(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, budgetMs));
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			let response: Response;
			try {
				response = await deps.fetchImpl(OPENROUTER_CHAT_COMPLETIONS_URL, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${deps.apiKey}`,
						"Content-Type": "application/json",
						...(deps.referer ? { "HTTP-Referer": deps.referer } : {}),
						...(deps.title ? { "X-Title": deps.title } : {}),
					},
					body: JSON.stringify({
						model: deps.model,
						messages: [{ role: "user", content: scenarioText }],
						max_tokens: maxOutputTokens,
						// A measurement is a repeated observation of the same question:
						// sampling would make two runs of one scenario differ for reasons
						// that have nothing to do with what changed in the AI answer.
						temperature: 0,
						// Asks OpenRouter to report what the call actually cost, so the
						// run does not have to fall back to the local estimate.
						usage: { include: true },
						// No web-search plugin or parameter is sent, deliberately: API
						// View is the model's own knowledge by contract
						// (isApiViewWebSearchEnabled), and a search-backed answer would
						// be a different measurement sold under the same name.
					}),
					signal: controller.signal,
				});
			} catch (error) {
				// The provider error is classified, never quoted: a thrown request
				// error can carry the request headers, and this text is stored.
				return isAbortError(error) || controller.signal.aborted
					? invalidOutcome(permit, "TIMEOUT", costFields())
					: failedOutcome(permit, "TRANSPORT_ERROR", costFields());
			}
			if (!response.ok) {
				// The error body can echo request material back, so it is dropped
				// rather than read into the run row.
				await response.body?.cancel().catch(() => {});
				return failedOutcome(permit, `PROVIDER_HTTP_${response.status}`, costFields());
			}
			let raw: string;
			try {
				raw = await readBodyWithinLimit(response, maxResponseBytes);
			} catch (error) {
				if (error instanceof ResponseTooLargeError) return invalidOutcome(permit, "RESPONSE_TOO_LARGE", costFields());
				return isAbortError(error) || controller.signal.aborted
					? invalidOutcome(permit, "TIMEOUT", costFields())
					: failedOutcome(permit, "TRANSPORT_ERROR", costFields());
			}
			let data: OpenRouterCompletionResponse;
			try {
				data = JSON.parse(raw) as OpenRouterCompletionResponse;
			} catch {
				return invalidOutcome(permit, "MALFORMED_RESPONSE", costFields());
			}
			const rawContent = data.choices?.[0]?.message?.content;
			// The payload carries the real usage even when the answer is unusable:
			// bill what was reported, not the estimate.
			if (typeof rawContent !== "string" || rawContent.trim() === "")
				return invalidOutcome(permit, "EMPTY_RESPONSE", costFields(data.usage));
			// The stored answer text must never store the credential: a response
			// that echoes request material back would otherwise write the key
			// into a retained row.
			const content = rawContent.split(deps.apiKey).join("[redacted-credential]");
			// Extraction is an enrichment of a call that already succeeded and was
			// paid for: a context failure must not turn paid evidence into a
			// FAILED row. The raw response is stored either way, so a missing
			// measurement is recoverable offline rather than lost.
			let measurement: ReturnType<typeof extractMeasurement> | null = null;
			if (deps.resolveExtractionContext) {
				try {
					const extracted = extractMeasurement({
						answerText: content,
						// API View runs with web search off, so the answer carries no
						// source list; an empty one here is the truth, not a gap.
						sources: [],
						system: deps.system ?? deps.model,
						model: deps.model,
						// No search plugin is ever sent (isApiViewWebSearchEnabled), so
						// this answer is the model's own knowledge by construction.
						captureMode: "training_data",
						context: await deps.resolveExtractionContext(permit),
					});
					// Validated here, not in the executor: a context that produces a
					// contract-invalid measurement (an empty language, a blank term)
					// must cost the measurement, never the paid run.
					measurement = runMeasurementSchema.safeParse(extracted).success ? extracted : null;
				} catch {
					measurement = null;
				}
			}
			const usage = data.usage;
			const tokenUsage = tokenUsageFrom(usage);
			return {
				dispatchKey: permit.dispatchKey,
				status: "SUCCEEDED",
				validity: "VALID",
				rawResponseReference: rawResponseReference(data.id, raw),
				// Retained on purpose: competitor and citation analysis reads the
				// answer, and keeping it lets a metric be recomputed without buying
				// a second measurement of a different moment. Only the answer body
				// is kept — never a provider error body, which can echo the key.
				answer: { text: content, retainUntil: answerRetainUntil(now()) },
				...(tokenUsage ? { tokenUsage } : {}),
				...costFields(usage),
				...(measurement === null ? {} : { measurement }),
			};
		} finally {
			clearTimeout(timer);
		}
	}

	return {
		// OpenRouter is an API View provider; a visitor-surface permit routed here
		// would be measuring something other than what it was sold as.
		channel: "api_view",
		async measure(permit: SelenaMeasurementPermit) {
			if (permit.channel !== "api_view") throw new Error("MEASUREMENT_CHANNEL_MISMATCH");
			// Planning only. Transport happens in execute, behind the executor's
			// guards, so nothing can reach the provider through this method.
			return { dispatchKey: permit.dispatchKey, status: "queued" as const };
		},
		async execute(permit: SelenaExecutablePermit) {
			// Parsed here as well as in the executor: this module owns its own
			// contract, so a mapping bug surfaces as a refusal rather than as a
			// malformed row reaching storage.
			return runOutcomeSchema.parse(await execute(permit));
		},
	};
}

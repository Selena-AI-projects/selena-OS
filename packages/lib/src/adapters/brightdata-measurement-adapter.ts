import { createHash } from "node:crypto";
import {
	answerRetainUntil,
	type RunOutcome,
	runMeasurementSchema,
	runOutcomeSchema,
	type visitorSurfaces,
} from "@workspace/selena-visibility-contracts";
import { type ExtractionContext, extractMeasurement } from "../selena-answer-extraction";
import type { SelenaExecutablePermit, SelenaMeasurementAdapter, SelenaMeasurementPermit } from "../selena-measurement";
import { estimateRunCostUsd } from "../usage/cost";

// The provider seam for Visitor View: the answer a person is actually shown by
// ChatGPT, Gemini or Perplexity, which is what separates this channel from API
// View (the model queried directly, with no search). Bright Data is the
// transport that reaches those surfaces.
//
// It stays selectable only by an owner code change: the execution contract's
// inert allowlist refuses "brightdata" even once it is registered in the
// worker, so importing this module cannot by itself turn spend on.
//
// UNCONFIRMED RESPONSE SHAPE — READ BEFORE THE FIRST LIVE RUN.
// The request body and the response fields below are a starting point, not a
// verified contract: they follow the field names this repository's existing
// Bright Data collector reads (packages/lib/src/providers/registry/brightdata.ts),
// which were observed on the datasets/v3 flow rather than on the endpoint this
// adapter posts to. Both directions are therefore injectable — `buildRequestBody`
// and `parseAnswer` — so the owner can pin the real shape from one real
// response without editing this module. Until that response exists, treat the
// defaults as a hypothesis; an unrecognized payload is reported as
// MALFORMED_RESPONSE rather than guessed into an answer.

const DEFAULT_TIMEOUT_MS = 120_000;
/** A visitor answer is prose plus a source list; past this it is a runaway page. */
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

export const brightDataVisitorSystems = ["chatgpt", "gemini", "perplexity"] as const;
export type BrightDataVisitorSystem = (typeof brightDataVisitorSystems)[number];

/**
 * Which sold surface each collector key measures. The `satisfies` clause is the
 * point: a system this adapter can be pointed at has to be a surface the
 * catalog actually sells, so a run cannot be delivered under a name the
 * customer did not buy.
 */
export const brightDataVisitorSurface = {
	chatgpt: "ChatGPT",
	gemini: "Gemini",
	perplexity: "Perplexity",
} as const satisfies Record<BrightDataVisitorSystem, (typeof visitorSurfaces)[number]>;

/** A source the answer itself showed. Never inferred, never reconstructed. */
export type BrightDataSource = { url: string; domain: string; title?: string };

export type BrightDataAnswer = {
	/** The visible answer text. Empty string means the surface answered nothing. */
	answerText: string;
	/** Only links the payload carried; an answer without them yields []. */
	sources: BrightDataSource[];
	/** The provider's own handle for this call, when the payload names one. */
	providerRequestId?: string;
	/** What the provider says this call cost, when the payload reports it. */
	costUsd?: number;
};

export type BrightDataRequestInput = {
	system: BrightDataVisitorSystem;
	prompt: string;
};

/**
 * The page each collector is pointed at. Confirmed against the account's own
 * three scrapers on 2026-08-25; the collector requires the url even though the
 * prompt is what varies.
 */
export const brightDataSurfaceUrl = {
	chatgpt: "https://chatgpt.com/",
	gemini: "https://gemini.google.com/",
	perplexity: "https://www.perplexity.ai",
} as const satisfies Record<BrightDataVisitorSystem, string>;

export type BrightDataAdapterDeps = {
	apiKey: string;
	/** Full Bright Data endpoint URL. HTTPS only — the key travels in a header. */
	endpoint: string;
	/**
	 * The collector this call runs. Bright Data selects the surface by dataset
	 * id in the query string, not by a name in the body, so this is the value
	 * that decides what is actually measured.
	 */
	datasetId: string;
	/** Which visitor surface this adapter instance measures. */
	system: BrightDataVisitorSystem;
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
	now?: () => Date;
	timeoutMs?: number;
	maxResponseBytes?: number;
	/** Override once the real request shape is confirmed against the account. */
	buildRequestBody?: (input: BrightDataRequestInput) => unknown;
	/**
	 * Override once the real response shape is confirmed. Receives the parsed
	 * JSON payload, or the raw body string when the body was not JSON at all.
	 * Returning null (or throwing) means "this is not a shape I understand",
	 * which is recorded as MALFORMED_RESPONSE — never as an empty answer.
	 */
	parseAnswer?: (raw: unknown) => BrightDataAnswer | null;
};

/** Whether a cost came from the provider or from the local estimate. */
export type BrightDataCostBasis = "provider_reported" | "estimated";

class ResponseTooLargeError extends Error {}

export function resolveBrightDataCost(reportedCostUsd?: number | null): {
	costUsd: number | null;
	basis: BrightDataCostBasis;
} {
	if (typeof reportedCostUsd === "number" && Number.isFinite(reportedCostUsd) && reportedCostUsd >= 0)
		return { costUsd: reportedCostUsd, basis: "provider_reported" };
	// Visitor View is a search-backed surface by definition, so the estimate is
	// taken with web search on. (The current per-provider table applies a search
	// surcharge only to anthropic-api, so this flag documents the channel today
	// rather than changing the number.)
	return { costUsd: estimateRunCostUsd("brightdata", true), basis: "estimated" };
}

/**
 * The request body, taken from the account's own code examples on 2026-08-25.
 * The three collectors do not take the same input: Gemini carries an `index`
 * and a top-level `limit_per_input`, ChatGPT takes the search toggle, and
 * Perplexity takes neither.
 */
export function buildBrightDataRequestBody(input: BrightDataRequestInput): Record<string, unknown> {
	const url = brightDataSurfaceUrl[input.system];
	if (input.system === "gemini") {
		return { input: [{ url, prompt: input.prompt, index: 1 }], limit_per_input: null };
	}
	if (input.system === "chatgpt") {
		return {
			input: [
				{
					url,
					prompt: input.prompt,
					country: "",
					// The account's example sends false. Visitor View is the
					// search-backed answer a person is shown, so this channel sends
					// true — with false it would be another API View under a name
					// the customer did not buy.
					web_search: true,
				},
			],
		};
	}
	return { input: [{ url, prompt: input.prompt, country: "" }] };
}

const ANSWER_TEXT_FIELDS = [
	"answer_text_markdown",
	"answer_text",
	"answer",
	"response_text",
	"text",
	"content",
] as const;
const SOURCE_FIELDS = ["citations", "links_attached", "sources"] as const;
const REQUEST_ID_FIELDS = ["snapshot_id", "request_id", "response_id", "id"] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/**
 * The sources the payload showed, and only those. A link is kept when the
 * payload carries it as a usable http(s) URL; anything else is dropped rather
 * than repaired, because a citation is evidence that the answer displayed a
 * source — inventing or reconstructing one would fabricate that evidence.
 */
export function extractBrightDataSources(record: Record<string, unknown>): BrightDataSource[] {
	const sources: BrightDataSource[] = [];
	const seen = new Set<string>();
	for (const field of SOURCE_FIELDS) {
		const values = record[field];
		if (!Array.isArray(values)) continue;
		for (const item of values) {
			const entry = asRecord(item);
			const url = typeof item === "string" ? item : typeof entry?.url === "string" ? entry.url : null;
			if (url === null || seen.has(url)) continue;
			let parsed: URL;
			try {
				parsed = new URL(url);
			} catch {
				continue;
			}
			if (parsed.protocol !== "https:" && parsed.protocol !== "http:") continue;
			seen.add(url);
			const title = typeof entry?.title === "string" && entry.title.trim() !== "" ? entry.title.trim() : undefined;
			sources.push({ url, domain: parsed.hostname.replace(/^www\./, ""), ...(title ? { title } : {}) });
		}
	}
	return sources;
}

/**
 * Default reading of a Bright Data payload, by the field names the existing
 * collector in this repository observes. Deliberately stricter than that
 * collector: it never falls back to stringifying an unknown record into an
 * "answer", because that would store a measurement of something nobody read.
 *
 * Exported so the owner's shape-pinning path (parseAnswer injection) can wrap
 * or replace it without editing the adapter.
 */
export function parseBrightDataAnswer(raw: unknown): BrightDataAnswer | null {
	// Snapshot-style payloads arrive as a single-record array.
	const record = asRecord(Array.isArray(raw) ? raw[0] : raw);
	if (!record) return null;

	let answerText: string | null = null;
	for (const field of ANSWER_TEXT_FIELDS) {
		const value = record[field];
		if (typeof value !== "string") continue;
		answerText = value.trim();
		if (answerText !== "") break;
	}
	// A payload with no answer field of any known name is not an empty answer:
	// it is a shape this parser does not understand, and the two must not be
	// recorded as the same thing.
	if (answerText === null) return null;

	let providerRequestId: string | undefined;
	for (const field of REQUEST_ID_FIELDS) {
		const value = record[field];
		if (typeof value === "string" && value.trim() !== "") {
			providerRequestId = value.trim();
			break;
		}
	}

	const reportedCost = record.cost;
	return {
		answerText,
		sources: extractBrightDataSources(record),
		...(providerRequestId ? { providerRequestId } : {}),
		...(typeof reportedCost === "number" && Number.isFinite(reportedCost) && reportedCost >= 0
			? { costUsd: reportedCost }
			: {}),
	};
}

/**
 * A handle, never the payload. The visitor answer belongs in private storage,
 * so what the run row keeps is the provider's own request id — which is how the
 * same call is looked up again on Bright Data's side — or, when the response
 * carries none, a digest of the body that identifies it without revealing it.
 */
function rawResponseReference(providerRequestId: string | undefined, rawBody: string): string {
	if (providerRequestId && providerRequestId.trim() !== "") return `brightdata:${providerRequestId.trim()}`;
	return `brightdata:sha256:${createHash("sha256").update(rawBody).digest("hex")}`;
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
function costFields(reportedCostUsd?: number | null): CostFields {
	const { costUsd, basis } = resolveBrightDataCost(reportedCostUsd);
	return costUsd === null
		? {}
		: {
				costUsd,
				costBasis: basis === "provider_reported" ? ("actual" as const) : ("estimated" as const),
				provider: "brightdata",
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
 * Visitor View measurement over Bright Data. One permit produces exactly one
 * request; every outcome path returns the permit's dispatch key, because the
 * executor refuses an outcome whose key does not match the permit it spent.
 */
export function createBrightDataAdapter(deps: BrightDataAdapterDeps): SelenaMeasurementAdapter {
	if (deps.apiKey.trim() === "") throw new Error("BRIGHTDATA_API_KEY_MISSING");
	if (deps.endpoint.trim() === "") throw new Error("BRIGHTDATA_ENDPOINT_MISSING");
	// The credential travels in a request header, so a plaintext endpoint would
	// put it on the wire; a mock transport needs no URL scheme to be relaxed.
	if (!/^https:\/\//i.test(deps.endpoint.trim())) throw new Error("BRIGHTDATA_ENDPOINT_INSECURE");
	if (deps.datasetId.trim() === "") throw new Error("BRIGHTDATA_DATASET_ID_MISSING");
	if (!(brightDataVisitorSystems as readonly string[]).includes(deps.system))
		throw new Error("BRIGHTDATA_SYSTEM_UNSUPPORTED");

	// The collector is chosen in the query string, so the dataset id belongs to
	// the URL rather than the body — and appending it here keeps every call for
	// this instance pointed at the surface the instance was built for.
	const endpoint = (() => {
		const url = new URL(deps.endpoint.trim());
		url.searchParams.set("dataset_id", deps.datasetId.trim());
		url.searchParams.set("notify", "false");
		return url.toString();
	})();
	const now = deps.now ?? (() => new Date());
	const maxResponseBytes = deps.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
	const buildRequestBody = deps.buildRequestBody ?? buildBrightDataRequestBody;
	const parseAnswer = deps.parseAnswer ?? parseBrightDataAnswer;

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
				response = await deps.fetchImpl(endpoint, {
					method: "POST",
					headers: {
						// The only place the credential appears. It is never put in
						// the body, the URL, an outcome or an error.
						Authorization: `Bearer ${deps.apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(buildRequestBody({ system: deps.system, prompt: scenarioText })),
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
			// A non-JSON body is handed to the parser as the raw string rather
			// than refused here: the confirmed shape may not be JSON, and the
			// default parser reports anything it does not recognize as malformed.
			let payload: unknown;
			try {
				payload = JSON.parse(raw);
			} catch {
				payload = raw;
			}
			let answer: BrightDataAnswer | null;
			try {
				answer = parseAnswer(payload);
			} catch {
				answer = null;
			}
			if (!answer) return invalidOutcome(permit, "MALFORMED_RESPONSE", costFields());
			// Storing the answer text (CABINET_MODEL §4a) must never store the
			// credential: a surface that echoes request material back would
			// otherwise write the key into a row read by more people than hold
			// it. Everything destined for the run row is scrubbed.
			const scrub = (value: string) => value.split(deps.apiKey).join("[redacted-credential]");
			answer = {
				...answer,
				answerText: scrub(answer.answerText),
				sources: answer.sources.map((source) => ({
					...source,
					url: scrub(source.url),
					...(source.title ? { title: scrub(source.title) } : {}),
				})),
			};
			// A parsed payload may name its own charge even when the answer is
			// unusable: bill what was reported, not the estimate.
			if (answer.answerText.trim() === "") return invalidOutcome(permit, "EMPTY_RESPONSE", costFields(answer.costUsd));
			// Extraction is an enrichment of a call that already succeeded and was
			// paid for: a context failure must not turn paid evidence into a
			// FAILED row. The raw response is stored either way, so a missing
			// measurement is recoverable offline rather than lost.
			let measurement: ReturnType<typeof extractMeasurement> | null = null;
			if (deps.resolveExtractionContext) {
				try {
					const extracted = extractMeasurement({
						answerText: answer.answerText,
						sources: answer.sources,
						// The sold surface, not the collector key: the executor refuses
						// evidence attributed to a system the permit did not authorize,
						// and a permit carries the catalog's name for it.
						system: brightDataVisitorSurface[deps.system],
						// Visitor View is the public surface answering a live query, so
						// what it returned is a live-search observation.
						captureMode: "live_search",
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
			return {
				dispatchKey: permit.dispatchKey,
				status: "SUCCEEDED",
				validity: "VALID",
				rawResponseReference: rawResponseReference(answer.providerRequestId, raw),
				// CABINET_MODEL §4a: the answer text is retained with the run for
				// the owner's window so findings can be recomputed without buying
				// a second measurement; the reference stays for provider-side
				// lookup after the text expires. Only the answer body — an error
				// body is never stored (see the !response.ok path above).
				answer: { text: answer.answerText, retainUntil: answerRetainUntil(now()) },
				// Displayed-source evidence survives independently of extraction:
				// a run whose context failed to resolve still keeps what the
				// surface showed, so the citation record is recoverable offline.
				...(answer.sources.length > 0 ? { sources: answer.sources } : {}),
				// No tokenUsage: a scraped visitor surface reports no token
				// accounting, and a zero would read as a measured value.
				...costFields(answer.costUsd),
				...(measurement === null ? {} : { measurement }),
			};
		} finally {
			clearTimeout(timer);
		}
	}

	return {
		// Bright Data is a Visitor View provider; an API View permit routed here
		// would be measuring something other than what it was sold as.
		channel: "visitor_view",
		async measure(permit: SelenaMeasurementPermit) {
			if (permit.channel !== "visitor_view") throw new Error("MEASUREMENT_CHANNEL_MISMATCH");
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

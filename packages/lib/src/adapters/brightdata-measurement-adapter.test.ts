import {
	assertAdapterAllowed,
	inertMeasurementAdapters,
	type RunOutcome,
	runOutcomeSchema,
	visitorSurfaces,
} from "@workspace/selena-visibility-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SelenaExecutablePermit } from "../selena-measurement";
import { estimateRunCostUsd } from "../usage/cost";
import {
	type BrightDataVisitorSystem,
	brightDataVisitorSurface,
	createBrightDataAdapter,
	extractBrightDataSources,
	parseBrightDataAnswer,
	resolveBrightDataCost,
} from "./brightdata-measurement-adapter";

const API_KEY = "brd-secret-owner-token";
const ENDPOINT = "https://api.brightdata.com/request";
const ZONE = "selena_visitor_view";
const SCENARIO_TEXT = "Which spa in Canggu is best for a deep tissue massage?";

function permitFor(overrides: Partial<SelenaExecutablePermit> = {}): SelenaExecutablePermit {
	return {
		id: "permit-1",
		organizationId: "org-1",
		cycleId: "cycle-1",
		scenarioId: "scenario-1",
		systemId: "chatgpt",
		channel: "VISITOR",
		dispatchKey: "order-1:scenario-1:ChatGPT:0:1",
		expiresAt: new Date("2026-08-19T11:00:00.000Z"),
		consumedAt: null,
		...overrides,
	};
}

const now = () => new Date("2026-08-19T10:00:00.000Z");

function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function respondWith(response: Response | (() => Response)) {
	return vi.fn(
		async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
			typeof response === "function" ? response() : response,
	);
}

function adapterWith(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
	return createBrightDataAdapter({
		apiKey: API_KEY,
		endpoint: ENDPOINT,
		zone: ZONE,
		system: "chatgpt",
		fetchImpl,
		resolveScenarioText: () => SCENARIO_TEXT,
		now,
		...overrides,
	});
}

function successPayload(overrides: Record<string, unknown> = {}) {
	return {
		snapshot_id: "s_01HZY",
		answer_text_markdown: "Answer text mentioning two studios.",
		citations: [{ url: "https://example.test/spa", title: "Spa guide" }],
		...overrides,
	};
}

// Nothing in these tests may reach a network: the global is replaced with a
// throwing stub so an accidental use of ambient fetch fails loudly instead of
// quietly billing the owner's Bright Data account.
let globalFetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
	globalFetch = vi.fn(() => {
		throw new Error("NETWORK_FORBIDDEN_IN_TESTS");
	});
	vi.stubGlobal("fetch", globalFetch);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Bright Data measurement adapter", () => {
	it("sends one Visitor View request carrying the zone, the surface and the question", async () => {
		const fetchImpl = respondWith(jsonResponse(successPayload()));
		const permit = permitFor();

		const outcome = await adapterWith(fetchImpl).execute(permit);

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(globalFetch).not.toHaveBeenCalled();
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe(ENDPOINT);
		expect(init?.method).toBe("POST");
		const headers = init?.headers as Record<string, string>;
		expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
		expect(headers["Content-Type"]).toBe("application/json");

		const rawBody = String(init?.body);
		const body = JSON.parse(rawBody);
		expect(body.zone).toBe(ZONE);
		expect(body.system).toBe("chatgpt");
		expect(body.prompt).toBe(SCENARIO_TEXT);
		// Visitor View is the search-backed surface a person sees; that is the
		// whole difference from API View.
		expect(body.web_search).toBe(true);
		// The credential belongs in the header and nowhere else.
		expect(rawBody).not.toContain(API_KEY);

		expect(outcome).toEqual({
			dispatchKey: permit.dispatchKey,
			status: "SUCCEEDED",
			validity: "VALID",
			rawResponseReference: "brightdata:s_01HZY",
			costUsd: estimateRunCostUsd("brightdata", true),
			costBasis: "estimated",
			provider: "brightdata",
		});
		// A scraped surface reports no token accounting, so none is claimed.
		expect(outcome.tokenUsage).toBeUndefined();
		expect(() => runOutcomeSchema.parse(outcome)).not.toThrow();
	});

	it("prefers a provider-reported cost and falls back to the local estimate", async () => {
		const reported = await adapterWith(respondWith(jsonResponse(successPayload({ cost: 0.12 })))).execute(permitFor());
		expect(reported.costUsd).toBe(0.12);

		const estimated = await adapterWith(respondWith(jsonResponse(successPayload()))).execute(permitFor());
		expect(estimated.costUsd).toBe(estimateRunCostUsd("brightdata", true));

		expect(resolveBrightDataCost(0.12)).toEqual({ costUsd: 0.12, basis: "provider_reported" });
		expect(resolveBrightDataCost(undefined).basis).toBe("estimated");
		expect(resolveBrightDataCost(-1).basis).toBe("estimated");
	});

	it("references the response instead of storing it, and digests it when there is no request id", async () => {
		const outcome = await adapterWith(respondWith(jsonResponse(successPayload({ snapshot_id: null })))).execute(
			permitFor(),
		);

		expect(outcome.rawResponseReference).toMatch(/^brightdata:sha256:[0-9a-f]{64}$/);
		expect(outcome.rawResponseReference).not.toContain("Answer text");
		expect(outcome.rawResponseReference).not.toContain("example.test");
	});

	it("records an answered-nothing response as empty and an unrecognized one as malformed", async () => {
		for (const payload of [{ answer_text: "   " }, { answer: "" }]) {
			const outcome = await adapterWith(respondWith(jsonResponse(payload))).execute(permitFor());
			expect(outcome).toMatchObject({ status: "INVALID", validity: "INVALID", invalidReason: "EMPTY_RESPONSE" });
			expect(() => runOutcomeSchema.parse(outcome)).not.toThrow();
		}

		// A shape with no answer field, an empty snapshot array, and a body that
		// is not JSON at all are all "not understood" — never an empty answer,
		// and never stringified into one.
		for (const response of [
			jsonResponse({ status: "unexpected shape" }),
			jsonResponse([]),
			new Response("<html>gateway error page</html>", { status: 200 }),
		]) {
			const outcome = await adapterWith(respondWith(response)).execute(permitFor());
			expect(outcome).toMatchObject({ status: "INVALID", validity: "INVALID", invalidReason: "MALFORMED_RESPONSE" });
			expect(() => runOutcomeSchema.parse(outcome)).not.toThrow();
		}
	});

	it("keeps only the sources the payload actually showed", () => {
		const sources = extractBrightDataSources({
			citations: [
				{ url: "https://example.test/spa", title: " Spa guide " },
				{ url: "https://example.test/spa" },
				{ title: "no url here" },
				{ url: "javascript:alert(1)" },
				{ url: "not a url" },
			],
			links_attached: ["https://www.other.test/list"],
			sources: "not an array",
		});

		expect(sources).toEqual([
			{ url: "https://example.test/spa", domain: "example.test", title: "Spa guide" },
			{ url: "https://www.other.test/list", domain: "other.test" },
		]);
		// An answer that showed no sources yields none — nothing is inferred from
		// the answer text.
		expect(parseBrightDataAnswer({ answer_text: "Two studios stand out." })?.sources).toEqual([]);
		expect(parseBrightDataAnswer({ answer_text: "x" })?.providerRequestId).toBeUndefined();
		expect(parseBrightDataAnswer({ nothing: "known" })).toBeNull();
	});

	it("lets the owner pin the confirmed request and response shape without editing the adapter", async () => {
		const fetchImpl = respondWith(
			new Response(JSON.stringify({ visible_answer: "Confirmed answer." }), { status: 200 }),
		);

		const outcome = await adapterWith(fetchImpl, {
			buildRequestBody: (input: { zone: string; system: string; prompt: string }) => ({
				zone: input.zone,
				collector: input.system,
				query: input.prompt,
			}),
			parseAnswer: (raw: unknown) => ({
				answerText: (raw as { visible_answer: string }).visible_answer,
				sources: [],
				providerRequestId: "req-42",
			}),
		}).execute(permitFor());

		const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
		expect(body).toEqual({ zone: ZONE, collector: "chatgpt", query: SCENARIO_TEXT });
		expect(outcome).toMatchObject({ status: "SUCCEEDED", rawResponseReference: "brightdata:req-42" });

		// A parser that throws on an unfamiliar payload is a refusal, not a crash.
		const thrown = await adapterWith(respondWith(jsonResponse(successPayload())), {
			parseAnswer: () => {
				throw new Error("unfamiliar payload");
			},
		}).execute(permitFor());
		expect(thrown).toMatchObject({ status: "INVALID", invalidReason: "MALFORMED_RESPONSE" });
	});

	it("maps provider HTTP errors to a failed outcome carrying only the status code", async () => {
		for (const status of [429, 500]) {
			const fetchImpl = respondWith(() => jsonResponse({ error: `boom ${API_KEY}` }, status));
			const outcome = await adapterWith(fetchImpl).execute(permitFor());

			// §10.2: the request was dispatched, so a worst-case estimated charge
			// is recorded rather than letting a broken cycle ledger as $0.
			expect(outcome).toEqual({
				dispatchKey: permitFor().dispatchKey,
				status: "FAILED",
				validity: "INVALID",
				invalidReason: `PROVIDER_HTTP_${status}`,
				costUsd: estimateRunCostUsd("brightdata", true),
				costBasis: "estimated",
				provider: "brightdata",
			});
			// The provider's error body is never read into the run row.
			expect(JSON.stringify(outcome)).not.toContain(API_KEY);
			expect(JSON.stringify(outcome)).not.toContain("boom");
		}
	});

	it("aborts a request that outlives its timeout and records it as invalid", async () => {
		const fetchImpl = vi.fn(
			(_input: RequestInfo | URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						const error = new Error("The operation was aborted");
						error.name = "AbortError";
						reject(error);
					});
				}),
		);

		const outcome = await adapterWith(fetchImpl, { timeoutMs: 5 }).execute(permitFor());

		expect(outcome).toMatchObject({ status: "INVALID", validity: "INVALID", invalidReason: "TIMEOUT" });
		expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true);
	});

	it("caps the timeout at the permit's remaining lifetime", async () => {
		const fetchImpl = vi.fn(
			(_input: RequestInfo | URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						const error = new Error("aborted");
						error.name = "AbortError";
						reject(error);
					});
				}),
		);
		const permit = permitFor({ expiresAt: new Date(now().getTime() + 3) });

		// The adapter's own timeout is far longer than the permit; the permit wins.
		const outcome = await adapterWith(fetchImpl, { timeoutMs: 600_000 }).execute(permit);

		expect(outcome).toMatchObject({ invalidReason: "TIMEOUT" });
	});

	it("maps a transport failure to a failed outcome without quoting the error", async () => {
		const fetchImpl = vi.fn(async (): Promise<Response> => {
			throw new Error(`socket hang up while sending Authorization: Bearer ${API_KEY}`);
		});

		const outcome = await adapterWith(fetchImpl).execute(permitFor());

		expect(outcome).toEqual({
			dispatchKey: permitFor().dispatchKey,
			status: "FAILED",
			validity: "INVALID",
			invalidReason: "TRANSPORT_ERROR",
			costUsd: estimateRunCostUsd("brightdata", true),
			costBasis: "estimated",
			provider: "brightdata",
		});
	});

	it("stops reading a response that exceeds the size limit", async () => {
		const payload = successPayload({ answer_text_markdown: "x".repeat(4000) });
		const outcome = await adapterWith(respondWith(jsonResponse(payload)), { maxResponseBytes: 128 }).execute(
			permitFor(),
		);

		expect(outcome).toMatchObject({ status: "INVALID", invalidReason: "RESPONSE_TOO_LARGE" });
	});

	it("does not contact the provider when the scenario text cannot be resolved", async () => {
		const fetchImpl = respondWith(jsonResponse(successPayload()));
		const outcome = await adapterWith(fetchImpl, {
			resolveScenarioText: () => {
				throw new Error("Not found: scenario is outside AuthContext tenant");
			},
		}).execute(permitFor());

		expect(fetchImpl).not.toHaveBeenCalled();
		expect(outcome).toMatchObject({ status: "FAILED", invalidReason: "SCENARIO_TEXT_UNAVAILABLE" });
		const empty = await adapterWith(fetchImpl, { resolveScenarioText: () => "  " }).execute(permitFor());
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(empty).toMatchObject({ status: "FAILED", invalidReason: "SCENARIO_TEXT_UNAVAILABLE" });
	});

	it("plans without transport and refuses a permit from another channel", async () => {
		const fetchImpl = respondWith(jsonResponse(successPayload()));
		const adapter = adapterWith(fetchImpl);

		expect(adapter.channel).toBe("visitor_view");
		await expect(
			adapter.measure({
				cycleId: "cycle-1",
				organizationId: "org-1",
				scenarioId: "scenario-1",
				channel: "visitor_view",
				dispatchKey: "k1",
			}),
		).resolves.toEqual({ dispatchKey: "k1", status: "queued" });
		await expect(
			adapter.measure({
				cycleId: "cycle-1",
				organizationId: "org-1",
				scenarioId: "scenario-1",
				channel: "api_view",
				dispatchKey: "k1",
			}),
		).rejects.toThrow("MEASUREMENT_CHANNEL_MISMATCH");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("measures only surfaces the catalog sells, over a transport that cannot leak the key", () => {
		expect(Object.values(brightDataVisitorSurface).every((surface) => visitorSurfaces.includes(surface))).toBe(true);

		const fetchImpl = respondWith(jsonResponse(successPayload()));
		expect(() => adapterWith(fetchImpl, { apiKey: " " })).toThrow("BRIGHTDATA_API_KEY_MISSING");
		expect(() => adapterWith(fetchImpl, { endpoint: "" })).toThrow("BRIGHTDATA_ENDPOINT_MISSING");
		// A plaintext endpoint would put the credential on the wire.
		expect(() => adapterWith(fetchImpl, { endpoint: "http://api.brightdata.com/request" })).toThrow(
			"BRIGHTDATA_ENDPOINT_INSECURE",
		);
		expect(() => adapterWith(fetchImpl, { zone: "  " })).toThrow("BRIGHTDATA_ZONE_MISSING");
		expect(() => adapterWith(fetchImpl, { system: "claude" as BrightDataVisitorSystem })).toThrow(
			"BRIGHTDATA_SYSTEM_UNSUPPORTED",
		);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("keeps the API token out of every outcome and every error it raises", async () => {
		const outcomes: RunOutcome[] = [];
		const failures: string[] = [];
		const cases: Array<typeof fetch> = [
			respondWith(jsonResponse(successPayload())),
			respondWith(() => jsonResponse({ error: `token was ${API_KEY}` }, 401)),
			respondWith(() => new Response(`not json ${API_KEY}`, { status: 200 })),
			respondWith(() => jsonResponse({ answer_text: `echoed request with ${API_KEY}` })),
			vi.fn(async (): Promise<Response> => {
				throw new Error(`ECONNRESET with Bearer ${API_KEY}`);
			}),
		];
		for (const fetchImpl of cases) {
			try {
				outcomes.push(await adapterWith(fetchImpl).execute(permitFor()));
			} catch (error) {
				failures.push(error instanceof Error ? error.message : String(error));
			}
		}

		expect(outcomes).toHaveLength(cases.length);
		// Even an answer that quotes the token back is stored only as a digest.
		expect(`${JSON.stringify(outcomes)}${failures.join("|")}`).not.toContain(API_KEY);
	});

	it("stays behind the owner gate: the adapter cannot be selected by configuration", () => {
		expect(inertMeasurementAdapters as readonly string[]).not.toContain("brightdata");
		expect(() => assertAdapterAllowed("brightdata", ["noop"])).toThrow("SELENA_ADAPTER_NOT_REGISTERED");
		// Registering it in the worker is still not enough to select it.
		expect(() => assertAdapterAllowed("brightdata", ["noop", "brightdata"])).toThrow(
			"SELENA_LIVE_ADAPTER_REQUIRES_OWNER_GO",
		);
	});

	it("attaches a measurement when an extraction context is supplied, and stays silent without one", async () => {
		const payload = successPayload({
			answer_text_markdown: "1. KORA Food Hall\n2. Rival Cafe",
			citations: [{ url: "https://korafoodhall.com/menu", title: "Menu" }],
		});
		const extraction = {
			brandTerms: ["KORA Food Hall"],
			ownedDomains: ["korafoodhall.com"],
			competitors: [{ name: "Rival Cafe", terms: ["Rival Cafe"] }],
			language: "en",
			region: "ID",
		};

		const withContext = await adapterWith(respondWith(jsonResponse(payload)), {
			resolveExtractionContext: () => extraction,
		}).execute(permitFor());
		expect(() => runOutcomeSchema.parse(withContext)).not.toThrow();
		expect(withContext.measurement).toEqual({
			system: "chatgpt",
			language: "en",
			region: "ID",
			mention: true,
			position: 1,
			ownedCitation: true,
			citations: [{ url: "https://korafoodhall.com/menu", domain: "korafoodhall.com" }],
			competitors: ["Rival Cafe"],
			factualErrors: [],
		});

		const withoutContext = await adapterWith(respondWith(jsonResponse(payload))).execute(permitFor());
		expect(withoutContext.measurement).toBeUndefined();
	});

	it("keeps a paid answer VALID when the extraction context cannot be resolved", async () => {
		const outcome = await adapterWith(respondWith(jsonResponse(successPayload())), {
			resolveExtractionContext: () => {
				throw new Error("LOCK_UNREACHABLE");
			},
		}).execute(permitFor());
		expect(outcome.status).toBe("SUCCEEDED");
		expect(outcome.validity).toBe("VALID");
		expect(outcome.measurement).toBeUndefined();
	});

	it("records a charge for an empty or malformed answer instead of a $0 ledger row", async () => {
		const empty = await adapterWith(respondWith(jsonResponse(successPayload({ answer_text_markdown: "  " })))).execute(
			permitFor(),
		);
		expect(empty.invalidReason).toBe("EMPTY_RESPONSE");
		expect(empty.costUsd).toBe(estimateRunCostUsd("brightdata", true));
		expect(empty.costBasis).toBe("estimated");
		expect(empty.provider).toBe("brightdata");

		const malformed = await adapterWith(respondWith(jsonResponse({ unexpected: true }))).execute(permitFor());
		expect(malformed.invalidReason).toBe("MALFORMED_RESPONSE");
		expect(malformed.costUsd).toBe(estimateRunCostUsd("brightdata", true));
		expect(malformed.provider).toBe("brightdata");
	});

	it("drops a contract-invalid extraction instead of failing the paid run", async () => {
		const outcome = await adapterWith(respondWith(jsonResponse(successPayload())), {
			resolveExtractionContext: () => ({
				brandTerms: ["KORA"],
				ownedDomains: [],
				competitors: [],
				language: "",
			}),
		}).execute(permitFor());
		expect(outcome.status).toBe("SUCCEEDED");
		expect(outcome.validity).toBe("VALID");
		expect(outcome.measurement).toBeUndefined();
	});
});

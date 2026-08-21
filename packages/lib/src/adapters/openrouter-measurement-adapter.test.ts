import {
	assertAdapterAllowed,
	inertMeasurementAdapters,
	type RunOutcome,
	runOutcomeSchema,
} from "@workspace/selena-visibility-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SelenaExecutablePermit } from "../selena-measurement";
import { estimateRunCostUsd } from "../usage/cost";
import { createOpenRouterAdapter, resolveOpenRouterCost } from "./openrouter-measurement-adapter";

const API_KEY = "sk-or-v1-secret-owner-key";
const SCENARIO_TEXT = "Which spa in Canggu is best for a deep tissue massage?";

function permitFor(overrides: Partial<SelenaExecutablePermit> = {}): SelenaExecutablePermit {
	return {
		id: "permit-1",
		organizationId: "org-1",
		cycleId: "cycle-1",
		scenarioId: "scenario-1",
		channel: "API",
		dispatchKey: "order-1:scenario-1:anthropic/claude-haiku-4.5:0:1",
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
	return createOpenRouterAdapter({
		apiKey: API_KEY,
		model: "anthropic/claude-haiku-4.5",
		fetchImpl,
		resolveScenarioText: () => SCENARIO_TEXT,
		now,
		referer: "https://example.test",
		title: "Selena API View",
		...overrides,
	});
}

function successPayload(overrides: Record<string, unknown> = {}) {
	return {
		id: "gen-01HZY",
		choices: [{ message: { content: "Answer text mentioning two studios." } }],
		usage: { prompt_tokens: 12, completion_tokens: 34, cost: 0.0042 },
		...overrides,
	};
}

// Nothing in these tests may reach a network: the global is replaced with a
// throwing stub so an accidental use of ambient fetch fails loudly instead of
// quietly billing the owner's OpenRouter account.
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

describe("OpenRouter measurement adapter", () => {
	it("sends one API View request and maps a completed answer to a valid outcome", async () => {
		const fetchImpl = respondWith(jsonResponse(successPayload()));
		const permit = permitFor();

		const outcome = await adapterWith(fetchImpl).execute(permit);

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(globalFetch).not.toHaveBeenCalled();
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
		expect(init?.method).toBe("POST");
		const headers = init?.headers as Record<string, string>;
		expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
		expect(headers["Content-Type"]).toBe("application/json");
		expect(headers["HTTP-Referer"]).toBe("https://example.test");

		const rawBody = String(init?.body);
		const body = JSON.parse(rawBody);
		expect(body.model).toBe("anthropic/claude-haiku-4.5");
		expect(body.messages).toEqual([{ role: "user", content: SCENARIO_TEXT }]);
		expect(body.temperature).toBe(0);
		expect(body.max_tokens).toBeGreaterThan(0);
		// API View is the model's own knowledge: no search plugin, no online
		// model suffix, no search options may be sent.
		expect(rawBody).not.toContain("plugins");
		expect(rawBody).not.toContain("web_search");
		expect(body.model).not.toContain(":online");

		expect(outcome).toEqual({
			dispatchKey: permit.dispatchKey,
			status: "SUCCEEDED",
			validity: "VALID",
			rawResponseReference: "openrouter:gen-01HZY",
			tokenUsage: { input: 12, output: 34 },
			costUsd: 0.0042,
			costBasis: "actual",
			provider: "openrouter",
		});
		expect(() => runOutcomeSchema.parse(outcome)).not.toThrow();
	});

	it("falls back to the local estimate when the provider reports no cost", async () => {
		const payload = successPayload({ usage: { prompt_tokens: 5, completion_tokens: 6 } });
		const outcome = await adapterWith(respondWith(jsonResponse(payload))).execute(permitFor());

		expect(outcome.costUsd).toBe(estimateRunCostUsd("openrouter", false));
		expect(resolveOpenRouterCost({ prompt_tokens: 5, completion_tokens: 6 }).basis).toBe("estimated");
		expect(resolveOpenRouterCost({ cost: 0.0042 })).toEqual({ costUsd: 0.0042, basis: "provider_reported" });
	});

	it("omits token usage the provider only half-reported", async () => {
		const payload = successPayload({ usage: { prompt_tokens: 5 } });
		const outcome = await adapterWith(respondWith(jsonResponse(payload))).execute(permitFor());

		expect(outcome.tokenUsage).toBeUndefined();
		expect(outcome.status).toBe("SUCCEEDED");
	});

	it("references the response instead of storing it, and digests it when there is no generation id", async () => {
		const payload = successPayload({ id: null });
		const outcome = await adapterWith(respondWith(jsonResponse(payload))).execute(permitFor());

		expect(outcome.rawResponseReference).toMatch(/^openrouter:sha256:[0-9a-f]{64}$/);
		expect(outcome.rawResponseReference).not.toContain("Answer text");
	});

	it("records an empty or contentless answer as invalid rather than as a measurement", async () => {
		for (const payload of [
			successPayload({ choices: [{ message: { content: "   " } }] }),
			successPayload({ choices: [] }),
			successPayload({ choices: [{ message: {} }] }),
		]) {
			const outcome = await adapterWith(respondWith(jsonResponse(payload))).execute(permitFor());
			expect(outcome).toMatchObject({ status: "INVALID", validity: "INVALID", invalidReason: "EMPTY_RESPONSE" });
			expect(() => runOutcomeSchema.parse(outcome)).not.toThrow();
		}
	});

	it("maps provider HTTP errors to a failed outcome carrying only the status code", async () => {
		for (const status of [429, 500]) {
			const fetchImpl = respondWith(() => jsonResponse({ error: { message: `boom ${API_KEY}` } }, status));
			const outcome = await adapterWith(fetchImpl).execute(permitFor());

			// §10.2: the request was dispatched, so a worst-case estimated charge
			// is recorded rather than letting a broken cycle ledger as $0.
			expect(outcome).toEqual({
				dispatchKey: permitFor().dispatchKey,
				status: "FAILED",
				validity: "INVALID",
				invalidReason: `PROVIDER_HTTP_${status}`,
				costUsd: estimateRunCostUsd("openrouter", false),
				costBasis: "estimated",
				provider: "openrouter",
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

		const outcome = await adapterWith(fetchImpl, { timeoutMs: 60_000 }).execute(permit);

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
			costUsd: estimateRunCostUsd("openrouter", false),
			costBasis: "estimated",
			provider: "openrouter",
		});
	});

	it("stops reading a response that exceeds the size limit", async () => {
		const payload = successPayload({ choices: [{ message: { content: "x".repeat(4000) } }] });
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

		await expect(
			adapter.measure({
				cycleId: "cycle-1",
				organizationId: "org-1",
				scenarioId: "scenario-1",
				channel: "api_view",
				dispatchKey: "k1",
			}),
		).resolves.toEqual({ dispatchKey: "k1", status: "queued" });
		await expect(
			adapter.measure({
				cycleId: "cycle-1",
				organizationId: "org-1",
				scenarioId: "scenario-1",
				channel: "visitor_view",
				dispatchKey: "k1",
			}),
		).rejects.toThrow("MEASUREMENT_CHANNEL_MISMATCH");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("keeps the API key out of every outcome and every error it raises", async () => {
		const outcomes: RunOutcome[] = [];
		const failures: string[] = [];
		const cases: Array<typeof fetch> = [
			respondWith(jsonResponse(successPayload())),
			respondWith(() => jsonResponse({ error: `key was ${API_KEY}` }, 401)),
			respondWith(() => new Response(`not json ${API_KEY}`, { status: 200 })),
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
		expect(`${JSON.stringify(outcomes)}${failures.join("|")}`).not.toContain(API_KEY);
		// A missing credential is refused at construction, and the message that
		// says so cannot echo a key either.
		expect(() => adapterWith(respondWith(jsonResponse(successPayload())), { apiKey: " " })).toThrow(
			"OPENROUTER_API_KEY_MISSING",
		);
	});

	it("stays behind the owner gate: the adapter cannot be selected by configuration", () => {
		expect(inertMeasurementAdapters as readonly string[]).not.toContain("openrouter");
		expect(() => assertAdapterAllowed("openrouter", ["noop"])).toThrow("SELENA_ADAPTER_NOT_REGISTERED");
		// Registering it in the worker is still not enough to select it.
		expect(() => assertAdapterAllowed("openrouter", ["noop", "openrouter"])).toThrow(
			"SELENA_LIVE_ADAPTER_REQUIRES_OWNER_GO",
		);
	});

	it("attaches a measurement under the sold system name, with no sources on API View", async () => {
		const payload = successPayload({
			choices: [{ message: { content: "KORA Food Hall is worth a visit; Rival Cafe is louder." } }],
		});
		const outcome = await adapterWith(respondWith(jsonResponse(payload)), {
			system: "claude",
			resolveExtractionContext: () => ({
				brandTerms: ["KORA Food Hall"],
				ownedDomains: ["korafoodhall.com"],
				competitors: [{ name: "Rival Cafe", terms: ["Rival Cafe"] }],
				language: "en",
			}),
		}).execute(permitFor());
		expect(() => runOutcomeSchema.parse(outcome)).not.toThrow();
		expect(outcome.measurement).toEqual({
			system: "claude",
			model: "anthropic/claude-haiku-4.5",
			language: "en",
			mention: true,
			position: null,
			ownedCitation: false,
			citations: [],
			competitors: ["Rival Cafe"],
			factualErrors: [],
		});
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

	it("records the provider's reported charge even when the answer is empty", async () => {
		const payload = successPayload({ choices: [{ message: { content: "  " } }] });
		const outcome = await adapterWith(respondWith(jsonResponse(payload))).execute(permitFor());
		expect(outcome.status).toBe("INVALID");
		expect(outcome.invalidReason).toBe("EMPTY_RESPONSE");
		// Tokens were consumed and billed; a $0 ledger row here is how a broken
		// cycle burns budget invisibly.
		expect(outcome.costUsd).toBe(0.0042);
		expect(outcome.costBasis).toBe("actual");
		expect(outcome.provider).toBe("openrouter");
	});

	it("drops a contract-invalid extraction instead of failing the paid run", async () => {
		const outcome = await adapterWith(respondWith(jsonResponse(successPayload())), {
			// language is required non-empty by the measurement contract.
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

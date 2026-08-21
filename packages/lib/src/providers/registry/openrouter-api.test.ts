import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getOpenRouterMaxTokens,
	OPENROUTER_API_MODELS,
	OPENROUTER_DEFAULT_MAX_TOKENS,
	openrouterApi,
} from "./openrouter-api";

const originalKey = process.env.OPENROUTER_API_KEY;
const originalMaxTokens = process.env.OPENROUTER_MAX_TOKENS;
type StoredOutput = { channel?: string; usage_cost?: number | null; finish_reason?: string | null; content?: string };

function mockResponse(body: unknown, ok = true, status = 200) {
	const fetchMock = vi.fn().mockResolvedValue({
		ok,
		status,
		text: async () => JSON.stringify(body),
		json: async () => body,
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

afterEach(() => {
	if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
	else process.env.OPENROUTER_API_KEY = originalKey;
	if (originalMaxTokens === undefined) delete process.env.OPENROUTER_MAX_TOKENS;
	else process.env.OPENROUTER_MAX_TOKENS = originalMaxTokens;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("openrouter-api", () => {
	it("supports the five verified models and returns API View metadata", async () => {
		process.env.OPENROUTER_API_KEY = "test-key";
		const fetchMock = mockResponse({
			model: OPENROUTER_API_MODELS[0],
			provider: "mock-provider",
			choices: [{ finish_reason: "stop", message: { content: "CONTROL_OK", annotations: [] } }],
			usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, cost: 0.01 },
		});
		const result = await openrouterApi.run("claude", "prompt", { version: OPENROUTER_API_MODELS[0], webSearch: false });
		const body = JSON.parse(fetchMock.mock.calls[0][1].body);
		expect(body.model).toBe(OPENROUTER_API_MODELS[0]);
		expect(body.max_tokens).toBe(OPENROUTER_DEFAULT_MAX_TOKENS);
		expect(body.messages).toEqual([{ role: "user", content: "prompt" }]);
		expect(result.textContent).toBe("CONTROL_OK");
		const stored = result.rawOutput as StoredOutput;
		expect(stored.channel).toBe("API View");
		expect(stored.usage_cost).toBe(0.01);
	});

	it("uses the valid environment override", () => {
		expect(getOpenRouterMaxTokens({ OPENROUTER_MAX_TOKENS: "64" })).toBe(64);
	});

	it.each(["0", "-1", "4001", "not-a-number", "1.5"])("falls back for invalid limit %s", (value) => {
		expect(getOpenRouterMaxTokens({ OPENROUTER_MAX_TOKENS: value })).toBe(OPENROUTER_DEFAULT_MAX_TOKENS);
	});

	it("uses the smaller per-request Elmo limit", async () => {
		process.env.OPENROUTER_API_KEY = "test-key";
		process.env.OPENROUTER_MAX_TOKENS = "1200";
		const fetchMock = mockResponse({ model: OPENROUTER_API_MODELS[0], choices: [{ message: { content: "ok" } }] });
		await openrouterApi.run("claude", "prompt", { version: OPENROUTER_API_MODELS[0], maxOutputTokens: 64 });
		expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_tokens).toBe(64);
	});

	it("never sends the historical 8000-token provider cap by default", async () => {
		process.env.OPENROUTER_API_KEY = "test-key";
		const fetchMock = mockResponse({ model: OPENROUTER_API_MODELS[0], choices: [{ message: { content: "ok" } }] });
		await openrouterApi.run("claude", "prompt", { version: OPENROUTER_API_MODELS[0] });
		expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_tokens).toBe(1200);
	});

	it("disables reasoning for Qwen", async () => {
		process.env.OPENROUTER_API_KEY = "test-key";
		const fetchMock = mockResponse({
			model: OPENROUTER_API_MODELS[2],
			choices: [{ message: { content: "CONTROL_OK" } }],
		});
		await openrouterApi.run("qwen", "prompt", { version: OPENROUTER_API_MODELS[2] });
		expect(JSON.parse(fetchMock.mock.calls[0][1].body).reasoning).toEqual({ effort: "none" });
	});

	it("preserves a Qwen clipped/null-content response without inventing content", async () => {
		process.env.OPENROUTER_API_KEY = "test-key";
		mockResponse({
			model: OPENROUTER_API_MODELS[2],
			choices: [{ finish_reason: "length", message: { content: null, reasoning: "thinking" } }],
		});
		const result = await openrouterApi.run("qwen", "prompt", { version: OPENROUTER_API_MODELS[2] });
		expect(result.textContent).toBe("");
		const stored = result.rawOutput as StoredOutput;
		expect(stored.finish_reason).toBe("length");
		expect(stored.content).toBe("");
	});

	it("surfaces HTTP/provider errors", async () => {
		process.env.OPENROUTER_API_KEY = "test-key";
		mockResponse({ error: { message: "provider failed" } }, false, 502);
		await expect(openrouterApi.run("claude", "prompt", { version: OPENROUTER_API_MODELS[0] })).rejects.toThrow("502");
	});

	it("reports missing environment key without reading or storing a value", () => {
		delete process.env.OPENROUTER_API_KEY;
		expect(openrouterApi.isConfigured()).toBe(false);
	});

	it("preserves missing usage.cost as null", async () => {
		process.env.OPENROUTER_API_KEY = "test-key";
		mockResponse({
			model: OPENROUTER_API_MODELS[4],
			choices: [{ message: { content: "CONTROL_OK" } }],
			usage: { total_tokens: 3 },
		});
		const result = await openrouterApi.run("grok", "prompt", { version: OPENROUTER_API_MODELS[4] });
		expect((result.rawOutput as StoredOutput).usage_cost).toBeNull();
	});
});

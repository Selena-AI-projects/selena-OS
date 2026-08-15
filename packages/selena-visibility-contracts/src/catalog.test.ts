import { describe, expect, it } from "vitest";
import { apiModelIds, assertDispatchModes, assertExpertVerified, assertHardCaps, createOrderLock, getPlan, isApiViewWebSearchEnabled, orderLockHash, plannedAnswers, validateCatalogScope } from "./catalog";

const systems = ["ChatGPT", "Gemini", "Perplexity"];
const apiSystems = [...systems, ...apiModelIds];
const base = (planId: "visitor-local" | "full-ai-landscape" | "expert-verified" | "growth-90-days", overrides = {}) => ({ planId, languages: ["en"], languageScenarios: 100, repeats: 1, systems, providerCostCap: 100, laborCapHours: 0, adminApproved: true, growthScopeLocked: true, ...overrides });

describe("Selena RC6 catalog", () => {
	it("Visitor Local is 100 × 3 × 1", () => expect(plannedAnswers(base("visitor-local"))).toBe(300));
	it("Full AI Landscape keeps 100 total scenarios across two languages", () => {
		const scope = base("full-ai-landscape", { languages: ["en", "id"], systems: apiSystems });
		expect(plannedAnswers(scope)).toBe(800);
		expect(() => validateCatalogScope({ ...scope, languageScenarios: 101 })).toThrow("SCENARIO_LIMIT_EXCEEDED");
	});
	it("Expert Verified is 10 families × 2 languages × 8 × 5", () => expect(plannedAnswers({ ...base("expert-verified", { languages: ["en", "id"], systems: apiSystems, languageScenarios: 20, repeats: 5 }) })).toBe(800));
	it("keeps Visitor and API channels distinct and API web search off", () => {
		expect(getPlan("full-ai-landscape").channelScope).toEqual(["VISITOR_VIEW", "API_VIEW"]);
		expect(isApiViewWebSearchEnabled()).toBe(false);
	});
	it("enforces model allowlist, caps, dispatch conflict, and QC", () => {
		expect(() => validateCatalogScope(base("full-ai-landscape", { systems: [...apiSystems, "unknown"] }))).toThrow("SYSTEM_SCOPE_MISMATCH");
		expect(() => assertDispatchModes(true, true)).toThrow("DISPATCH_MODE_CONFLICT");
		expect(() => assertExpertVerified(false)).toThrow("EXPERT_QC_REQUIRED");
	});
	it("locks quote/order inputs immutably and hashes the snapshot", () => {
		const scope = base("visitor-local");
		const lock = createOrderLock(scope, { amount: 49, currency: "USD", taxMode: "owner-defined", refundPolicyVersion: "pending-owner-input" }, "config-v1");
		expect(lock.plannedAnswers).toBe(300);
		expect(orderLockHash(lock)).toBe(orderLockHash(lock));
		lock.scope.languages.push("id");
		expect(orderLockHash(lock)).not.toBe(orderLockHash(createOrderLock(scope, { amount: 49, currency: "USD", taxMode: "owner-defined", refundPolicyVersion: "pending-owner-input" }, "config-v1")));
	});
	it("requires a locked custom scope and approval for Growth", () => {
		expect(() => validateCatalogScope(base("growth-90-days", { systems: apiSystems, providerCostCap: 0, growthScopeLocked: false }))).toThrow("GROWTH_SCOPE_REQUIRED");
	});
	it("blocks overflow, caps and a second technical-invalid retry", () => {
		expect(() => assertHardCaps({ createdRuns: 300, expectedRuns: 300, estimatedCost: 1, providerCostCap: 10, orderCap: 10, retryUsed: 0, retryReserve: 1 })).toThrow("CARDINALITY_BLOCKED");
		expect(() => assertHardCaps({ createdRuns: 1, expectedRuns: 2, estimatedCost: 11, providerCostCap: 10, orderCap: 20, retryUsed: 0, retryReserve: 1 })).toThrow("PROVIDER_CAP_BLOCKED");
		expect(() => assertHardCaps({ createdRuns: 1, expectedRuns: 2, estimatedCost: 1, providerCostCap: 10, orderCap: 10, retryUsed: 2, retryReserve: 1 })).toThrow("RETRY_RESERVE_EXCEEDED");
	});
});

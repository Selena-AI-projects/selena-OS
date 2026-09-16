import { describe, expect, it, vi } from "vitest";
import { localDraftInput, localPrepaymentEnabled, prepareLocalOrder } from "../lib/selena-local-prepayment";
import { createLocalPrepaymentApi, type LocalPrepaymentStore } from "./selena-local-prepayment-api";

const id = "10000000-0000-4000-8000-000000000001";
const restaurant = {
	name: "Test restaurant",
	countryCode: "ID",
	latitude: -8.8,
	longitude: 115.1,
	mapsUrl: "https://www.google.com/maps?cid=123",
	identity: { cid: "123" },
	confirmed: true as const,
};
const input = { restaurantId: id, queries: ["dinner", "lunch"], language: "en", gridSize: 3 as const };
function setup(role: "owner" | "viewer" = "owner", authType: "session" | "api_key" = "session") {
	const store: LocalPrepaymentStore = {
		list: vi.fn(async () => []),
		createRestaurant: vi.fn(async () => ({})),
		createOrder: vi.fn(async () => ({})),
		readOrder: vi.fn(async () => null),
		readReport: vi.fn(async () => new Response()),
	};
	const authenticate = vi.fn(async () => ({
		tenantId: "tenant-a",
		actorId: "user-a",
		role,
		authType,
		permissions: [],
	}));
	return { store, authenticate, handler: createLocalPrepaymentApi({ enabled: () => true, authenticate, store }) };
}
function post(value: unknown, origin = "https://app.example.test") {
	return new Request("https://app.example.test/api/orders", {
		method: "POST",
		headers: {
			Origin: origin,
			"Content-Type": "application/json",
			"Idempotency-Key": id,
		},
		body: JSON.stringify(value),
	});
}
describe("Local Visibility before payments", () => {
	it("fails closed for missing and malformed flags", () => {
		for (const value of [undefined, "false", "TRUE", "1", " true "])
			expect(localPrepaymentEnabled({ SELENA_LOCAL_PREPAYMENT_ENABLED: value })).toBe(false);
		expect(localPrepaymentEnabled({ SELENA_LOCAL_PREPAYMENT_ENABLED: "true" })).toBe(true);
	});
	it("prepares the advertised cardinality with no execution policy", () => {
		for (const size of [3, 5] as const) {
			const order = prepareLocalOrder({ ...input, gridSize: size }, restaurant);
			expect(order.expectedObservations).toBe(2 * size * size);
			expect(order.grid.points).toHaveLength(size * size);
			expect(order).toMatchObject({
				priceAmount: "49.00",
				currency: "USD",
				paymentMode: "DISABLED",
				executionMode: "DISABLED",
				status: "PREPARED",
			});
		}
	});
	it("rejects repeated queries and client-supplied pricing or tenant scope", () => {
		expect(localDraftInput.safeParse({ ...input, queries: ["Dinner", "dinner"] }).success).toBe(false);
		for (const extra of [{ priceAmount: "1" }, { organizationId: "tenant-b" }, { executionMode: "FIXTURE" }])
			expect(localDraftInput.safeParse({ ...input, ...extra }).success).toBe(false);
	});
	it("blocks payment/start operations before any store call", async () => {
		const { handler, store } = setup();
		expect((await handler(post({}), "blocked", id)).status).toBe(403);
		for (const operation of Object.values(store)) expect(operation).not.toHaveBeenCalled();
	});
	it("blocks foreign origins, viewers and API keys", async () => {
		for (const [role, type, origin] of [
			["owner", "session", "https://foreign.test"],
			["viewer", "session", "https://app.example.test"],
			["owner", "api_key", "https://app.example.test"],
		] as const) {
			const { handler, store } = setup(role, type);
			expect((await handler(post(input, origin), "orders")).status).toBe(403);
			expect(store.createOrder).not.toHaveBeenCalled();
		}
	});
	it("saves only parsed input in the authenticated tenant", async () => {
		const { handler, store } = setup();
		expect((await handler(post(input), "orders")).status).toBe(201);
		expect(store.createOrder).toHaveBeenCalledWith(
			expect.objectContaining({ tenantId: "tenant-a", actorId: "user-a" }),
			input,
			id,
		);
	});
	it("does not mask inaccessible orders as empty successful records", async () => {
		const { handler } = setup();
		const response = await handler(new Request("https://app.example.test/order"), "order", id);
		expect(response.status).toBe(404);
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
	});
	it("rejects oversized bodies and invalid idempotency keys", async () => {
		const { handler, store } = setup();
		expect((await handler(post({ value: "a".repeat(33000) }), "orders")).status).toBe(413);
		const request = post(input);
		request.headers.delete("Idempotency-Key");
		expect((await handler(request, "orders")).status).toBe(400);
		expect(store.createOrder).not.toHaveBeenCalled();
	});
});

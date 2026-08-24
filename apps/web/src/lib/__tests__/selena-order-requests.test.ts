import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("../../server/selena-order-requests.ts", import.meta.url)), "utf8");

describe("plan request layer zero invariant", () => {
	// A request is a lead. Turning one into a paid measurement stays the
	// operator's explicit act on the order desk, so this module must not be
	// able to create money objects, mint permits or queue work.
	const forbidden = ["svOrders", "svQuotes", "svRunPermits", "createPermits", "enqueue", "boss", "fetch("];

	it("keeps the request module free of the order and dispatch path", () => {
		for (const marker of forbidden) {
			expect(source.includes(marker), `selena-order-requests.ts must not contain "${marker}"`).toBe(false);
		}
	});

	it("decides free passage on the server, never from the submitted form", () => {
		expect(source).toContain("promoCodeApplies(data.promoCode, process.env)");
	});

	it("keeps reading and closing requests behind the admin gate", () => {
		const listing = source.slice(source.indexOf("listSelenaOrderRequestsFn"));
		expect(listing).toContain("requireAdmin()");
		const updating = source.slice(source.indexOf("updateSelenaOrderRequestStatusFn"));
		expect(updating).toContain("requireAdmin()");
	});
});

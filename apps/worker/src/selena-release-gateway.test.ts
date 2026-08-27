import { describe, expect, it } from "vitest";
import { isGatewayAuthorizationValid } from "./selena-release-gateway";

describe("Selena Release Gateway authentication boundary", () => {
	it("rejects requests without the isolated Gateway token", () => {
		expect(isGatewayAuthorizationValid("gateway-test-token", undefined)).toBe(false);
		expect(isGatewayAuthorizationValid("gateway-test-token", "wrong-token")).toBe(false);
		expect(isGatewayAuthorizationValid("gateway-test-token", "gateway-test-token-extra")).toBe(false);
	});

	it("accepts only the exact internal Gateway token", () => {
		expect(isGatewayAuthorizationValid("gateway-test-token", "gateway-test-token")).toBe(true);
	});
});

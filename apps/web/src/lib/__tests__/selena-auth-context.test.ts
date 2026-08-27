import { describe, expect, it } from "vitest";
import { assertTenantContext, canWrite } from "../selena-authz";

const context = {
	actorId: "user-a",
	tenantId: "tenant-a",
	role: "member" as const,
	authType: "session" as const,
	permissions: ["client:read", "client:write"],
};

describe("Selena AuthContext isolation", () => {
	it("rejects tenant_id supplied by a caller when it differs from context", () => {
		expect(() => assertTenantContext(context, "tenant-b")).toThrow("tenant_id is controlled by AuthContext");
		expect(() => assertTenantContext(context, "tenant-a")).not.toThrow();
	});

	it("makes viewer read-only", () => {
		expect(canWrite(context)).toBe(true);
		expect(canWrite({ ...context, role: "viewer" })).toBe(false);
	});

	it("requires explicit write permission for machine keys", () => {
		const apiKey = { ...context, authType: "api_key" as const, permissions: ["client:read"] };
		expect(canWrite(apiKey)).toBe(false);
		expect(canWrite({ ...apiKey, permissions: ["client:read", "client:write"] })).toBe(true);
	});
});

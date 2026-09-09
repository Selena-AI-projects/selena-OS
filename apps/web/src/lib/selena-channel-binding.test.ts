import { describe, expect, it } from "vitest";
import { resolveBoundEnvironment } from "./selena-channel-binding";

describe("which contour a channel binding may target", () => {
	it("is unknown before the connection has ever been checked", () => {
		expect(resolveBoundEnvironment(null)).toBeNull();
	});

	it("is unknown when the runtime has no publishing key configured", () => {
		expect(resolveBoundEnvironment({ state: "NOT_CONFIGURED" })).toBeNull();
	});

	it("is the runtime's own contour once a key is configured, even if the account is misconfigured", () => {
		expect(resolveBoundEnvironment({ environment: "DRY_RUN", state: "MISCONFIGURED" })).toBe("DRY_RUN");
	});

	it("is the runtime's own contour when the connection is healthy", () => {
		expect(resolveBoundEnvironment({ environment: "PRODUCTION", state: "CONNECTED" })).toBe("PRODUCTION");
	});
});

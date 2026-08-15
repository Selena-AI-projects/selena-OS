import { describe, expect, it } from "vitest";
import { assertPublicScanUrl } from "../selena-public-scan-policy";

describe("zero-login public scan URL policy", () => {
	it("accepts public HTTP(S) URLs", () =>
		expect(assertPublicScanUrl("https://example.com")).toBe("https://example.com/"));
	it("rejects private, local, and non-http targets", () => {
		for (const value of [
			"http://localhost:3000",
			"http://127.0.0.1",
			"http://172.20.1.2",
			"http://192.168.1.2",
			"http://[fd00::1]",
			"http://app.local",
			"ftp://example.com",
		]) {
			expect(() => assertPublicScanUrl(value)).toThrow();
		}
	});
});

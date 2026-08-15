import { describe, expect, it } from "vitest";
import {
	assertRedirectBudget,
	assertResolvedWebsiteHost,
	assertResponseSize,
	assertWebsiteMime,
	isBlockedWebsiteIp,
} from "./website-security";

describe("website security boundary", () => {
	it("blocks private, metadata, reserved and IPv6 local/link-local ranges", () => {
		for (const ip of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.1", "fc00::1", "fe80::1", "2001:db8::1"])
			expect(isBlockedWebsiteIp(ip)).toBe(true);
		expect(() => assertResolvedWebsiteHost("https://example.test", ["127.0.0.1"])).toThrow(
			"WEBSITE_PRIVATE_OR_INVALID_URL",
		);
	});
	it("enforces MIME, response and redirect caps", () => {
		expect(() => assertWebsiteMime("application/javascript")).toThrow("WEBSITE_MIME_NOT_ALLOWED");
		expect(() => assertResponseSize("x".repeat(1_000_001))).toThrow("WEBSITE_RESPONSE_TOO_LARGE");
		expect(() => assertRedirectBudget(["a", "b", "c", "d", "e"])).toThrow("WEBSITE_REDIRECT_LIMIT");
	});
});

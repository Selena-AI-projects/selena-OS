import { describe, expect, it } from "vitest";
import {
	assertPublicWebsiteTarget,
	assertRedirectBudget,
	assertResolvedWebsiteHost,
	assertResponseSize,
	assertWebsiteMime,
	assertWebsiteUrl,
	isBlockedWebsiteIp,
	normalizeWebsiteUrl,
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

describe("one boundary for every caller", () => {
	it("refuses credentials in the url and port zero", () => {
		expect(() => assertWebsiteUrl("https://user:pass@example.com/")).toThrow("WEBSITE_PRIVATE_OR_INVALID_URL");
		expect(() => assertWebsiteUrl("https://example.com:0/")).toThrow("WEBSITE_PRIVATE_OR_INVALID_URL");
	});

	it("refuses every private suffix a network resolves internally, not only the metadata host", () => {
		expect(() => assertWebsiteUrl("http://metadata.google.internal/")).toThrow("WEBSITE_PRIVATE_OR_INVALID_URL");
		expect(() => assertWebsiteUrl("http://db.svc.internal/")).toThrow("WEBSITE_PRIVATE_OR_INVALID_URL");
	});

	it("refuses multicast and the reserved top of the address space", () => {
		expect(isBlockedWebsiteIp("224.0.0.1")).toBe(true);
		expect(isBlockedWebsiteIp("255.255.255.255")).toBe(true);
		expect(isBlockedWebsiteIp("ff02::1")).toBe(true);
		expect(isBlockedWebsiteIp("93.184.216.34")).toBe(false);
	});

	it("normalizes what a crawler compares, so a loop cannot look like progress", () => {
		const url = normalizeWebsiteUrl("https://Example.COM/a#section");
		expect(url.hostname).toBe("example.com");
		expect(url.hash).toBe("");
		expect(() => normalizeWebsiteUrl("https://user@example.com/")).toThrow("WEBSITE_PRIVATE_OR_INVALID_URL");
	});
});

describe("assertPublicWebsiteTarget", () => {
	it("refuses a literal private address before any network call", async () => {
		await expect(assertPublicWebsiteTarget("http://169.254.169.254/latest/meta-data")).rejects.toThrow(
			"WEBSITE_PRIVATE_OR_INVALID_URL",
		);
		await expect(assertPublicWebsiteTarget("http://10.0.0.5/")).rejects.toThrow("WEBSITE_PRIVATE_OR_INVALID_URL");
		await expect(assertPublicWebsiteTarget("http://localhost/")).rejects.toThrow("WEBSITE_PRIVATE_OR_INVALID_URL");
	});

	it("refuses a non-http scheme", async () => {
		await expect(assertPublicWebsiteTarget("file:///etc/passwd")).rejects.toThrow();
	});

	it("refuses the cloud metadata hostname", async () => {
		await expect(assertPublicWebsiteTarget("http://metadata.google.internal/")).rejects.toThrow(
			"WEBSITE_PRIVATE_OR_INVALID_URL",
		);
	});
});

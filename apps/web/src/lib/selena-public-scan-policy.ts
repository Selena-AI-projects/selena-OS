import { isIP } from "node:net";
import { cleanOnboardingUrl } from "@workspace/lib/onboarding";

function isPrivateIp(hostname: string): boolean {
	const ipHost = hostname.replace(/^\[|\]$/g, "");
	const version = isIP(ipHost);
	if (version === 4) {
		const octets = ipHost.split(".").map(Number);
		return (
			octets[0] === 10 ||
			octets[0] === 127 ||
			octets[0] === 0 ||
			(octets[0] === 169 && octets[1] === 254) ||
			(octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
			(octets[0] === 192 && octets[1] === 168)
		);
	}
	if (version === 6) {
		const normalized = ipHost.toLowerCase();
		return (
			normalized === "::1" ||
			normalized.startsWith("fc") ||
			normalized.startsWith("fd") ||
			normalized.startsWith("fe8") ||
			normalized.startsWith("fe9") ||
			normalized.startsWith("fea") ||
			normalized.startsWith("feb")
		);
	}
	return false;
}

export function assertPublicScanUrl(value: string): string {
	const url = cleanOnboardingUrl(value);
	if (!url) throw new Error("A valid public http(s) URL is required");
	const parsed = new URL(url);
	if (!(parsed.protocol === "http:" || parsed.protocol === "https:"))
		throw new Error("Only public http(s) URLs are allowed");
	if (["localhost"].includes(parsed.hostname) || parsed.hostname.endsWith(".local") || isPrivateIp(parsed.hostname))
		throw new Error("Private hosts are not allowed");
	return url;
}

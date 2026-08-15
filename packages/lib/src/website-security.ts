import { isIP } from "node:net";

export const WEBSITE_MAX_REDIRECTS = 3;
export const WEBSITE_MAX_RESPONSE_BYTES = 1_000_000;
export const WEBSITE_ALLOWED_MIME = new Set([
	"text/html",
	"application/xhtml+xml",
	"text/plain",
	"application/xml",
	"text/xml",
]);

export function isBlockedWebsiteIp(value: string): boolean {
	const ip = value.replace(/^\[|\]$/g, "").toLowerCase();
	if (isIP(ip) === 4) {
		const [a, b] = ip.split(".").map(Number);
		return (
			a === 0 ||
			a === 10 ||
			(a === 100 && b >= 64 && b <= 127) ||
			a === 127 ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 192 && b === 0) ||
			(a === 198 && (b === 18 || b === 19 || b === 51)) ||
			(a === 203 && b === 0)
		);
	}
	if (isIP(ip) === 6)
		return (
			ip === "::" ||
			ip === "::1" ||
			ip.startsWith("fc") ||
			ip.startsWith("fd") ||
			ip.startsWith("fe8") ||
			ip.startsWith("fe9") ||
			ip.startsWith("fea") ||
			ip.startsWith("feb") ||
			ip.startsWith("2001:db8")
		);
	return false;
}

export function assertWebsiteUrl(value: string): URL {
	const url = new URL(value);
	if (
		!/^https?:$/.test(url.protocol) ||
		url.hostname === "localhost" ||
		url.hostname.endsWith(".local") ||
		url.hostname === "metadata.google.internal" ||
		isBlockedWebsiteIp(url.hostname)
	)
		throw new Error("WEBSITE_PRIVATE_OR_INVALID_URL");
	return url;
}

export function assertResolvedWebsiteHost(value: string, addresses: string[]): URL {
	const url = assertWebsiteUrl(value);
	if (addresses.some(isBlockedWebsiteIp)) throw new Error("WEBSITE_PRIVATE_OR_INVALID_URL");
	return url;
}

export function assertWebsiteMime(contentType: string | null): void {
	const mime = contentType?.split(";", 1)[0]?.trim().toLowerCase();
	if (mime && !WEBSITE_ALLOWED_MIME.has(mime)) throw new Error("WEBSITE_MIME_NOT_ALLOWED");
}

export function assertRedirectBudget(chain: string[]): void {
	if (chain.length - 1 > WEBSITE_MAX_REDIRECTS) throw new Error("WEBSITE_REDIRECT_LIMIT");
}

export function assertResponseSize(body: string): void {
	if (new TextEncoder().encode(body).byteLength > WEBSITE_MAX_RESPONSE_BYTES)
		throw new Error("WEBSITE_RESPONSE_TOO_LARGE");
}

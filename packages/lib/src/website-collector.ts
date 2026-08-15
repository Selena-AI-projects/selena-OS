import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
	type ActionPlan,
	actionPlanSchema,
	type EvidenceItem,
	type InputManifest,
	type RecommendationFinding,
	stableId,
} from "@workspace/selena-visibility-contracts";

const MAX_HTML_BYTES = 1_000_000;
const MAX_REDIRECTS = 3;
const MAX_PAGES = 10;
const MAX_DEPTH = 1;
const MAX_LINKS = 200;
const MAX_TEXT = 100_000;
const ALLOWED_MIME = new Set(["text/html", "application/xhtml+xml", "text/plain"]);
const PRIVATE_IPV4 =
	/^(0\.|10\.|127\.|169\.254\.|192\.0\.0\.|192\.0\.2\.|192\.168\.|198\.18\.|198\.19\.|198\.51\.100\.|203\.0\.113\.|22[4-9]\.|23\d\.|24\d\.|25[0-5]\.)/;

export type WebsiteSnapshot = {
	id: string;
	tenantId: string;
	url: string;
	finalUrl: string;
	capturedAt: string;
	contentHash: string;
	immutable: true;
	html: string;
	status: number;
	redirectChain: string[];
	robots: string | null;
	canonical: string | null;
	metadata: Record<string, string>;
	hreflang: Array<{ lang: string; href: string }>;
	headings: string[];
	visibleText: string;
	jsonLd: unknown[];
	microdata: string[];
	contacts: string[];
	services: string[];
	internalLinks: string[];
	sitemapReferences: string[];
	images: Array<{ src: string; alt: string | null }>;
	pageCount: number;
	depth: number;
};
export type WebsiteCollection = {
	snapshot: WebsiteSnapshot;
	evidence: EvidenceItem[];
	manifest: InputManifest;
	rulepack: "WEB-v1";
};
export type WebsiteFetcher = (url: string) => Promise<{ status: number; headers: Headers; body: string }>;
export type WebsiteCollectionOptions = {
	capturedAt?: string;
	fetcher?: WebsiteFetcher;
	maxPages?: number;
	maxDepth?: number;
	userAgent?: string;
};

function normalizeUrl(value: string): URL {
	const url = new URL(value);
	url.hash = "";
	url.hostname = url.hostname.toLowerCase();
	if (!/^https?:$/.test(url.protocol)) throw new Error("WEBSITE_PRIVATE_OR_INVALID_URL");
	if (url.username || url.password || url.port === "0") throw new Error("WEBSITE_PRIVATE_OR_INVALID_URL");
	return url;
}
function unsafeIp(ip: string): boolean {
	ip = ip.replace(/^\[|\]$/g, "");
	if (isIP(ip) === 4) return PRIVATE_IPV4.test(ip);
	if (isIP(ip) === 6) {
		const value = ip.toLowerCase();
		return (
			value === "::1" ||
			value === "::" ||
			value.startsWith("fc") ||
			value.startsWith("fd") ||
			value.startsWith("fe8") ||
			value.startsWith("fe9") ||
			value.startsWith("fea") ||
			value.startsWith("feb") ||
			value.startsWith("2001:db8:") ||
			value.startsWith("ff")
		);
	}
	return false;
}
async function assertPublicUrl(value: string): Promise<URL> {
	const url = normalizeUrl(value);
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	assertSyntacticallyPublic(url);
	const addresses = await lookup(hostname, { all: true, verbatim: true }).catch(() => []);
	if (!addresses.length) throw new Error("WEBSITE_DNS_FAILED");
	if (addresses.some(({ address }) => unsafeIp(address))) throw new Error("WEBSITE_PRIVATE_OR_INVALID_URL");
	return url;
}
function assertSyntacticallyPublic(url: URL): void {
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	if (hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal") || unsafeIp(hostname))
		throw new Error("WEBSITE_PRIVATE_OR_INVALID_URL");
}
function decodeEntities(value: string): string {
	return value.replaceAll(
		/&(?:amp|lt|gt|quot|#39|nbsp);/g,
		(entity) =>
			({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " })[entity] ?? entity,
	);
}
function visible(value: string): string {
	return decodeEntities(
		value
			.replaceAll(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<[^>]+>/gi, " ")
			.replaceAll(/\s+/g, " ")
			.trim(),
	).slice(0, MAX_TEXT);
}
function attr(tag: string, name: string): string | null {
	return tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1]?.trim() || null;
}
function parseHtml(html: string, base: URL) {
	const metadata: Record<string, string> = {};
	for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
		const tag = match[0];
		const key = attr(tag, "name") ?? attr(tag, "property");
		const value = attr(tag, "content");
		if (key && value) metadata[key.toLowerCase()] = decodeEntities(value);
	}
	const canonicalTag = html.match(/<link\b[^>]*rel=["'][^"']*canonical[^"']*["'][^>]*>/i)?.[0];
	let canonical: string | null = null;
	try {
		canonical = canonicalTag ? new URL(attr(canonicalTag, "href") ?? base.href, base).href : null;
	} catch {
		canonical = null;
	}
	const hreflang = [...html.matchAll(/<link\b[^>]*hreflang=["']([^"']+)["'][^>]*>/gi)]
		.map((match) => {
			try {
				return { lang: match[1] ?? "", href: new URL(attr(match[0], "href") ?? "", base).href };
			} catch {
				return null;
			}
		})
		.filter((item): item is { lang: string; href: string } => item !== null);
	const headings = [...html.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)]
		.map((match) => visible(match[2] ?? ""))
		.filter(Boolean);
	const jsonLd: unknown[] = [];
	for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
		try {
			jsonLd.push(JSON.parse(match[1] ?? ""));
		} catch {
			jsonLd.push({ invalid: true });
		}
	}
	const links = [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)]
		.map((match) => {
			try {
				const href = new URL(match[1] ?? "", base);
				return href.origin === base.origin && ["http:", "https:"].includes(href.protocol)
					? href.href.split("#")[0]
					: null;
			} catch {
				return null;
			}
		})
		.filter((href): href is string => typeof href === "string");
	const images = [...html.matchAll(/<img\b[^>]*>/gi)]
		.map((match) => ({ src: attr(match[0], "src") ?? "", alt: attr(match[0], "alt") }))
		.filter((item) => item.src)
		.slice(0, MAX_LINKS);
	const contacts = [...new Set((html.match(/(?:mailto:|tel:)[^"'\s<>]+/gi) ?? []).map((value) => value.trim()))];
	const services = [
		...new Set(
			[...html.matchAll(/<(?:h[1-3]|li|p)\b[^>]*>([\s\S]*?)<\/(?:h[1-3]|li|p)>/gi)]
				.map((match) => visible(match[1] ?? ""))
				.filter((value) => /service|solution|offer|menu|pricing|booking|contact|location/i.test(value))
				.slice(0, 50),
		),
	];
	const sitemapReferences = [...html.matchAll(/(?:sitemap(?:\.xml)?|robots\.txt)/gi)].map((match) => match[0]);
	const microdata = [...html.matchAll(/(?:itemprop|itemscope|itemtype)=["'][^"']+["']/gi)].map((match) => match[0]);
	return {
		canonical,
		metadata,
		hreflang,
		headings,
		visibleText: visible(html),
		jsonLd,
		microdata,
		contacts,
		services,
		internalLinks: [...new Set(links)].slice(0, MAX_LINKS),
		sitemapReferences,
		images,
	};
}

async function fetchDefault(
	url: URL,
	userAgent: string,
): Promise<{ status: number; headers: Headers; body: string; finalUrl: URL; redirectChain: string[] }> {
	let current = url;
	const redirectChain = [url.href];
	for (let i = 0; i <= MAX_REDIRECTS; i++) {
		await assertPublicUrl(current.href);
		const response = await fetch(current, {
			redirect: "manual",
			headers: { "user-agent": userAgent, accept: "text/html,application/xhtml+xml,text/plain;q=0.8" },
			signal: AbortSignal.timeout(10_000),
		});
		if (response.status < 300 || response.status >= 400) {
			const mime = (response.headers.get("content-type") ?? "").split(";", 1)[0].toLowerCase();
			if (mime && !ALLOWED_MIME.has(mime)) throw new Error("WEBSITE_MIME_NOT_ALLOWED");
			const length = Number(response.headers.get("content-length") ?? "0");
			if (length > MAX_HTML_BYTES) throw new Error("WEBSITE_RESPONSE_TOO_LARGE");
			const body = await response.text();
			if (new TextEncoder().encode(body).byteLength > MAX_HTML_BYTES) throw new Error("WEBSITE_RESPONSE_TOO_LARGE");
			return { status: response.status, headers: response.headers, body, finalUrl: current, redirectChain };
		}
		const location = response.headers.get("location");
		if (!location || i === MAX_REDIRECTS) throw new Error("WEBSITE_REDIRECT_LIMIT");
		current = await assertPublicUrl(new URL(location, current).href);
		if (redirectChain.includes(current.href)) throw new Error("WEBSITE_REDIRECT_LOOP");
		redirectChain.push(current.href);
	}
	throw new Error("WEBSITE_REDIRECT_LIMIT");
}
async function fetchWithPolicy(url: URL, fetcher: WebsiteFetcher | undefined, userAgent: string) {
	if (!fetcher) return fetchDefault(url, userAgent);
	let current = url;
	const redirectChain = [url.href];
	for (let i = 0; i <= MAX_REDIRECTS; i++) {
		assertSyntacticallyPublic(current);
		const page = await fetcher(current.href);
		if (page.status < 300 || page.status >= 400) return { ...page, finalUrl: current, redirectChain };
		const location = page.headers.get("location");
		if (!location || i === MAX_REDIRECTS) throw new Error("WEBSITE_REDIRECT_LIMIT");
		current = normalizeUrl(new URL(location, current).href);
		if (redirectChain.includes(current.href)) throw new Error("WEBSITE_REDIRECT_LOOP");
		redirectChain.push(current.href);
	}
	throw new Error("WEBSITE_REDIRECT_LIMIT");
}
function evidence(
	tenantId: string,
	snapshotId: string,
	source: string,
	subject: string,
	value: unknown,
	capturedAt: string,
): EvidenceItem {
	return {
		id: stableId("web_evidence", `${snapshotId}:${source}:${subject}`),
		tenantId,
		snapshotId,
		kind: "WEBSITE",
		accessClass: "PUBLIC",
		sourceRef: source,
		capturedAt,
		subject,
		text: typeof value === "string" ? value : JSON.stringify(value),
		metadata: { rulepack: "WEB-v1" },
	};
}

export async function collectWebsite(
	tenantId: string,
	website: string,
	options: WebsiteCollectionOptions = {},
): Promise<WebsiteCollection> {
	const maxPages = options.maxPages ?? MAX_PAGES;
	const maxDepth = options.maxDepth ?? MAX_DEPTH;
	if (maxPages < 1 || maxDepth < 0) throw new Error("WEBSITE_CRAWL_POLICY_INVALID");
	const url = options.fetcher ? normalizeUrl(website) : await assertPublicUrl(website);
	const userAgent = options.userAgent ?? "SelenaWebsiteCollector/1.0 (+https://selenasystems.com/ai-visibility)";
	const page = await fetchWithPolicy(url, options.fetcher, userAgent);
	if (page.status < 200 || page.status >= 400) throw new Error(`WEBSITE_HTTP_${page.status}`);
	const mime = (page.headers.get("content-type") ?? "").split(";", 1)[0].toLowerCase();
	if (mime && !ALLOWED_MIME.has(mime)) throw new Error("WEBSITE_MIME_NOT_ALLOWED");
	if (new TextEncoder().encode(page.body).byteLength > MAX_HTML_BYTES) throw new Error("WEBSITE_RESPONSE_TOO_LARGE");
	let robots: string | null = null;
	try {
		const robotsPage = await fetchWithPolicy(new URL("/robots.txt", page.finalUrl), options.fetcher, userAgent);
		if (robotsPage.status >= 200 && robotsPage.status < 300) robots = robotsPage.body.slice(0, 100_000);
	} catch {
		robots = null;
	}
	const capturedAt = options.capturedAt ?? new Date().toISOString();
	const parsed = parseHtml(page.body, page.finalUrl);
	const normalized = JSON.stringify({
		finalUrl: page.finalUrl.href,
		status: page.status,
		redirects: page.redirectChain,
		html: page.body,
		robots,
		parsed,
	});
	const contentHash = createHash("sha256").update(normalized).digest("hex");
	const snapshotId = stableId("website_snapshot", `${tenantId}:${page.finalUrl.href}:${contentHash}`);
	const snapshot: WebsiteSnapshot = {
		id: snapshotId,
		tenantId,
		url: url.href,
		finalUrl: page.finalUrl.href,
		capturedAt,
		contentHash,
		immutable: true,
		html: page.body,
		status: page.status,
		redirectChain: page.redirectChain,
		robots,
		pageCount: 1,
		depth: 0,
		...parsed,
	};
	const values: Array<[string, unknown]> = [
		["http-status", page.status],
		["redirect-chain", page.redirectChain],
		["title", parsed.metadata.title ?? "UNKNOWN"],
		["meta-description", parsed.metadata.description ?? "UNKNOWN"],
		["meta-robots", parsed.metadata.robots ?? "UNKNOWN"],
		["canonical", parsed.canonical ?? "UNKNOWN"],
		["hreflang", parsed.hreflang],
		["headings", parsed.headings],
		["visible-text", parsed.visibleText],
		["internal-links", parsed.internalLinks],
		["sitemap-references", parsed.sitemapReferences],
		["json-ld", parsed.jsonLd],
		["microdata", parsed.microdata],
		["contacts", parsed.contacts],
		["services", parsed.services],
		["images", parsed.images],
		["robots", robots ?? "UNKNOWN"],
	];
	const items = values.map(([subject, value]) =>
		evidence(tenantId, snapshotId, `${page.finalUrl.href}#${subject}`, subject, value, capturedAt),
	);
	const manifest: InputManifest = {
		id: stableId("manifest", `${tenantId}:${snapshotId}:WEB-v1`),
		tenantId,
		datasetId: snapshotId,
		evidenceIds: items.map((item) => item.id),
		snapshotIds: [snapshotId],
		rulepackVersion: "WEB-v1",
		createdAt: capturedAt,
		immutable: true,
	};
	return { snapshot, evidence: items, manifest, rulepack: "WEB-v1" };
}

export function buildWebsiteActionPlan(collection: WebsiteCollection): ActionPlan {
	const bySubject = new Map(collection.evidence.map((item) => [item.subject, item]));
	const rules: Array<[string, string, string, "HIGH" | "MEDIUM" | "LOW"]> = [
		["title", "WEB-001", "Add a descriptive page title that identifies the brand and offer.", "MEDIUM"],
		["meta-description", "WEB-002", "Add a concise meta description describing the confirmed offer.", "MEDIUM"],
		["meta-robots", "WEB-003", "Publish an explicit reviewable robots policy.", "LOW"],
		["canonical", "WEB-004", "Add a valid canonical URL to the confirmed website.", "MEDIUM"],
		["hreflang", "WEB-005", "Add language alternates only where supported by the site.", "LOW"],
		["headings", "WEB-006", "Organize the website with descriptive H1-H3 headings.", "MEDIUM"],
		["visible-text", "WEB-007", "Publish crawlable visible text for the confirmed offer.", "HIGH"],
		["internal-links", "WEB-008", "Connect service, location and contact pages with internal links.", "MEDIUM"],
		["json-ld", "WEB-009", "Add valid JSON-LD for the confirmed organization or service.", "MEDIUM"],
		["microdata", "WEB-010", "Review structured data only where it is actually present.", "LOW"],
		["contacts", "WEB-011", "Publish a clear public contact path.", "MEDIUM"],
		["services", "WEB-012", "Describe services, menu, booking or location information in crawlable content.", "HIGH"],
		["images", "WEB-013", "Add useful alt text to important images.", "LOW"],
		["robots", "WEB-014", "Keep robots evidence available for future verification.", "LOW"],
	];
	const findings: RecommendationFinding[] = [];
	for (const [subject, ruleId, _action, severity] of rules) {
		const item = bySubject.get(subject);
		if (!item) continue;
		const missing = item.text === "UNKNOWN" || item.text === "[]" || item.text === "{}" || item.text === "";
		if (!missing) continue;
		findings.push({
			id: stableId("finding", `${collection.manifest.id}:${ruleId}`),
			tenantId: collection.manifest.tenantId,
			manifestId: collection.manifest.id,
			category: "WEBSITE_FOUNDATION",
			statement: `Website signal ${subject} is missing or unknown.`,
			evidenceIds: [item.id],
			confidence: item.text === "UNKNOWN" ? "UNKNOWN" : "MEDIUM",
			confidenceScore: item.text === "UNKNOWN" ? 0 : 0.8,
			severity,
			unknown: item.text === "UNKNOWN",
			ruleId,
		});
	}
	const recommendations = findings.map((finding) => {
		const rule = rules.find((item) => item[1] === finding.ruleId);
		return {
			id: stableId("recommendation", finding.id),
			tenantId: finding.tenantId,
			findingId: finding.id,
			manifestId: finding.manifestId,
			title: `Improve ${finding.ruleId}`,
			action: rule?.[2] ?? "Improve the website evidence.",
			rationale: finding.statement,
			evidenceIds: finding.evidenceIds,
			priority: finding.severity === "HIGH" ? ("NOW" as const) : ("NEXT" as const),
			effort: "S" as const,
			confidence: finding.confidence,
			blocked: false,
		};
	});
	const tasks = recommendations.map((item) => ({
		id: stableId("task", item.id),
		recommendationId: item.id,
		title: item.title,
		horizon: "0_30_DAYS" as const,
		owner: "Website owner",
		steps: [item.action],
		evidenceIds: item.evidenceIds,
		verificationPlan: [
			"Recollect the confirmed website into a new immutable snapshot.",
			"Compare the same evidence subject in the new snapshot.",
		],
	}));
	return actionPlanSchema.parse({
		tenantId: collection.manifest.tenantId,
		manifestId: collection.manifest.id,
		findings,
		recommendations,
		tasks,
	});
}

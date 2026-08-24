import { createHash } from "node:crypto";
import {
	type ActionPlan,
	actionPlanSchema,
	type EvidenceItem,
	type InputManifest,
	type RecommendationFinding,
	stableId,
} from "@workspace/selena-visibility-contracts";
import { type GoogleMapsLocationSnapshot, isGoogleMapsLink } from "./google-maps-location";
import {
	assertPublicWebsiteTarget,
	assertWebsiteUrl,
	normalizeWebsiteUrl,
	WEBSITE_MAX_REDIRECTS,
	WEBSITE_MAX_RESPONSE_BYTES,
} from "./website-security";

const MAX_PAGES = 10;
const MAX_DEPTH = 1;
const MAX_LINKS = 200;
const MAX_TEXT = 100_000;
const ALLOWED_MIME = new Set(["text/html", "application/xhtml+xml", "text/plain"]);

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
	mapsLinks: string[];
	sitemapReferences: string[];
	images: Array<{ src: string; alt: string | null }>;
	pageCount: number;
	depth: number;
};
export type WebsiteCollection = {
	snapshot: WebsiteSnapshot;
	evidence: EvidenceItem[];
	manifest: InputManifest;
	rulepack: "WEB-v2";
};
export type WebsiteFetcher = (url: string) => Promise<{ status: number; headers: Headers; body: string }>;
export type WebsiteCollectionOptions = {
	capturedAt?: string;
	fetcher?: WebsiteFetcher;
	maxPages?: number;
	maxDepth?: number;
	userAgent?: string;
};

/**
 * The crawler follows redirects itself so it can revalidate every hop, but the
 * rule it validates against is the shared one — a second copy of "which hosts
 * are public" is a second copy that drifts.
 */
async function assertPublicUrl(value: string): Promise<URL> {
	const url = normalizeWebsiteUrl(value);
	await assertPublicWebsiteTarget(url.href);
	return url;
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
	const anchors = [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)]
		.map((match) => {
			try {
				return new URL(match[1] ?? "", base);
			} catch {
				return null;
			}
		})
		.filter((href): href is URL => href !== null);
	const links = anchors
		.map((href) =>
			href.origin === base.origin && ["http:", "https:"].includes(href.protocol) ? href.href.split("#")[0] : null,
		)
		.filter((href): href is string => typeof href === "string");
	// External by definition (the internal-link list drops them), and the signal
	// the local-presence rules read: whether the site points at its own listing.
	const mapsLinks = [...new Set(anchors.map((href) => href.href).filter((href) => isGoogleMapsLink(href)))].slice(
		0,
		MAX_LINKS,
	);
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
		mapsLinks,
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
	for (let i = 0; i <= WEBSITE_MAX_REDIRECTS; i++) {
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
			if (length > WEBSITE_MAX_RESPONSE_BYTES) throw new Error("WEBSITE_RESPONSE_TOO_LARGE");
			const body = await response.text();
			if (new TextEncoder().encode(body).byteLength > WEBSITE_MAX_RESPONSE_BYTES)
				throw new Error("WEBSITE_RESPONSE_TOO_LARGE");
			return { status: response.status, headers: response.headers, body, finalUrl: current, redirectChain };
		}
		const location = response.headers.get("location");
		if (!location || i === WEBSITE_MAX_REDIRECTS) throw new Error("WEBSITE_REDIRECT_LIMIT");
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
	for (let i = 0; i <= WEBSITE_MAX_REDIRECTS; i++) {
		assertWebsiteUrl(current.href);
		const page = await fetcher(current.href);
		if (page.status < 300 || page.status >= 400) return { ...page, finalUrl: current, redirectChain };
		const location = page.headers.get("location");
		if (!location || i === WEBSITE_MAX_REDIRECTS) throw new Error("WEBSITE_REDIRECT_LIMIT");
		current = normalizeWebsiteUrl(new URL(location, current).href);
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
		metadata: { rulepack: "WEB-v2" },
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
	const url = options.fetcher ? normalizeWebsiteUrl(website) : await assertPublicUrl(website);
	const userAgent = options.userAgent ?? "SelenaWebsiteCollector/1.0 (+https://selenasystems.com/ai-visibility)";
	const page = await fetchWithPolicy(url, options.fetcher, userAgent);
	if (page.status < 200 || page.status >= 400) throw new Error(`WEBSITE_HTTP_${page.status}`);
	const mime = (page.headers.get("content-type") ?? "").split(";", 1)[0].toLowerCase();
	if (mime && !ALLOWED_MIME.has(mime)) throw new Error("WEBSITE_MIME_NOT_ALLOWED");
	if (new TextEncoder().encode(page.body).byteLength > WEBSITE_MAX_RESPONSE_BYTES)
		throw new Error("WEBSITE_RESPONSE_TOO_LARGE");
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
		["maps-links", parsed.mapsLinks],
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
		id: stableId("manifest", `${tenantId}:${snapshotId}:WEB-v2`),
		tenantId,
		datasetId: snapshotId,
		evidenceIds: items.map((item) => item.id),
		snapshotIds: [snapshotId],
		rulepackVersion: "WEB-v2",
		createdAt: capturedAt,
		immutable: true,
	};
	return { snapshot, evidence: items, manifest, rulepack: "WEB-v2" };
}

export type WebsiteActionPlanContext = {
	/** The project's confirmed Google Maps listing, when the profile has one. */
	mapsLocation?: Pick<GoogleMapsLocationSnapshot, "url" | "placeName"> | null;
};

function safeJsonParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** True when any JSON-LD node (including @graph members) declares an address. */
function declaresAddress(value: unknown, depth = 0): boolean {
	if (depth > 4 || value === null || typeof value !== "object") return false;
	if (Array.isArray(value)) return value.some((item) => declaresAddress(item, depth + 1));
	const record = value as Record<string, unknown>;
	if (record.address !== null && record.address !== undefined && record.address !== "") return true;
	return Object.values(record).some((item) => declaresAddress(item, depth + 1));
}

/**
 * The free audit's rule table, exported so the customer-facing report can
 * render every check — the passing ones included — instead of only the
 * failures the action plan keeps.
 */
export const WEBSITE_SIGNAL_RULES: ReadonlyArray<readonly [string, string, string, "HIGH" | "MEDIUM" | "LOW"]> = [
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

export function buildWebsiteActionPlan(
	collection: WebsiteCollection,
	context: WebsiteActionPlanContext = {},
): ActionPlan {
	const bySubject = new Map(collection.evidence.map((item) => [item.subject, item]));
	const rules = WEBSITE_SIGNAL_RULES;
	
	const actionByRuleId = new Map<string, string>(rules.map(([, ruleId, action]) => [ruleId, action]));
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
	// Local-presence rules run only against a confirmed Google Maps listing:
	// without one, "no maps link" is not a defect, and each check must state an
	// observed mismatch between the site and the listing, never a folk rule.
	const location = context.mapsLocation;
	if (location) {
		const placeName = location.placeName;
		const localRules: Array<{
			ruleId: string;
			subject: string;
			failed: (text: string) => boolean;
			statement: string;
			action: string;
		}> = [
			{
				ruleId: "WEB-015",
				subject: "maps-links",
				failed: (text) => text === "[]",
				statement: "The website does not link to any Google Maps listing.",
				action: "Link the confirmed Google Maps listing from the website's contact or location section.",
			},
			{
				ruleId: "WEB-016",
				subject: "json-ld",
				// A page with no JSON-LD at all is already WEB-009's finding.
				failed: (text) => text !== "[]" && !declaresAddress(safeJsonParse(text)),
				statement: "Structured data on the website does not declare a business address.",
				action: "Add LocalBusiness JSON-LD whose name and address match the Google Maps listing.",
			},
			...(placeName
				? [
						{
							ruleId: "WEB-017",
							subject: "visible-text",
							failed: (text: string) => !text.toLowerCase().includes(placeName.toLowerCase()),
							statement: `The Google Maps listing name "${placeName}" does not appear in the website's visible text.`,
							action: "Use the exact listing name on the website so the site and the listing confirm each other.",
						},
					]
				: []),
		];
		for (const rule of localRules) {
			const item = bySubject.get(rule.subject);
			if (!item || !rule.failed(item.text)) continue;
			actionByRuleId.set(rule.ruleId, rule.action);
			findings.push({
				id: stableId("finding", `${collection.manifest.id}:${rule.ruleId}`),
				tenantId: collection.manifest.tenantId,
				manifestId: collection.manifest.id,
				category: "LOCAL_PRESENCE",
				statement: rule.statement,
				evidenceIds: [item.id],
				confidence: "MEDIUM",
				confidenceScore: 0.8,
				severity: "MEDIUM",
				unknown: false,
				ruleId: rule.ruleId,
			});
		}
	}
	const recommendations = findings.map((finding) => {
		return {
			id: stableId("recommendation", finding.id),
			tenantId: finding.tenantId,
			findingId: finding.id,
			manifestId: finding.manifestId,
			title: `Improve ${finding.ruleId}`,
			action: actionByRuleId.get(finding.ruleId) ?? "Improve the website evidence.",
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

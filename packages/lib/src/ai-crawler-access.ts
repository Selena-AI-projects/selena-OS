/**
 * Whether a site lets the crawlers behind AI answers fetch it.
 *
 * A robots.txt rule is the one AI-visibility signal a site owner controls
 * outright and can get exactly backwards: a page nothing may fetch cannot be
 * quoted, however good it is. So this reads the site's own robots.txt as
 * evidence rather than assuming anything.
 *
 * Crawlers are kept apart by what blocking one actually costs, because the
 * three classes are different decisions:
 *
 * - `search` — builds the index an answer engine cites from. Blocking it
 *   removes the site from that engine's answers.
 * - `user_fetch` — fetches a page because a person asked the assistant to
 *   open it. Blocking it means a customer who pastes the link gets nothing.
 * - `training` — collects data to train a model. Blocking it is a legitimate
 *   business decision about one's own content, not a defect, so nothing here
 *   treats it as one.
 *
 * Access is not citation: a crawler that may fetch a page still decides on
 * its own whether to use it. This module reports permission, never outcome.
 */

export type CrawlerClass = "search" | "user_fetch" | "training";

export type AiCrawler = {
	/** The user-agent token as it is written in robots.txt. */
	token: string;
	/** The product a site owner would recognise. */
	product: string;
	crawlerClass: CrawlerClass;
};

/**
 * Only crawlers whose operator documents both the token and its purpose. An
 * agent missing here is left unclassified rather than guessed at, so a wrong
 * guess never becomes a finding.
 */
export const AI_CRAWLERS: readonly AiCrawler[] = [
	{ token: "OAI-SearchBot", product: "ChatGPT Search", crawlerClass: "search" },
	{ token: "PerplexityBot", product: "Perplexity", crawlerClass: "search" },
	{ token: "Claude-SearchBot", product: "Claude web search", crawlerClass: "search" },
	// Google AI Overviews and AI Mode read Google's own search index, and
	// Copilot reads Bing's, so these two carry AI answers as well as search.
	{ token: "Googlebot", product: "Google Search and AI Overviews", crawlerClass: "search" },
	{ token: "Bingbot", product: "Bing and Copilot", crawlerClass: "search" },
	{ token: "ChatGPT-User", product: "ChatGPT when a person opens a link", crawlerClass: "user_fetch" },
	{ token: "Perplexity-User", product: "Perplexity when a person opens a link", crawlerClass: "user_fetch" },
	{ token: "Claude-User", product: "Claude when a person opens a link", crawlerClass: "user_fetch" },
	{ token: "GPTBot", product: "OpenAI model training", crawlerClass: "training" },
	{ token: "ClaudeBot", product: "Anthropic model training", crawlerClass: "training" },
	{ token: "Google-Extended", product: "Gemini model training and grounding", crawlerClass: "training" },
	{ token: "Applebot-Extended", product: "Apple model training", crawlerClass: "training" },
	{ token: "CCBot", product: "Common Crawl", crawlerClass: "training" },
];

type RobotsGroup = { agents: string[]; rules: Array<{ allow: boolean; path: string }> };

/**
 * robots.txt as the crawlers read it: consecutive `User-agent` lines share the
 * rules that follow them, comments and unknown fields are ignored, and a
 * malformed file yields no groups rather than an exception.
 */
export function parseRobotsTxt(text: string): RobotsGroup[] {
	const groups: RobotsGroup[] = [];
	let current: RobotsGroup | null = null;
	let agentRunOpen = false;
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.split("#", 1)[0].trim();
		if (!line) continue;
		const separator = line.indexOf(":");
		if (separator === -1) continue;
		const field = line.slice(0, separator).trim().toLowerCase();
		const value = line.slice(separator + 1).trim();
		if (field === "user-agent") {
			if (!current || !agentRunOpen) {
				current = { agents: [], rules: [] };
				groups.push(current);
				agentRunOpen = true;
			}
			current.agents.push(value.toLowerCase());
			continue;
		}
		if (field !== "allow" && field !== "disallow") continue;
		if (!current) continue;
		agentRunOpen = false;
		current.rules.push({ allow: field === "allow", path: value });
	}
	return groups.filter((group) => group.agents.length > 0);
}

/**
 * The group that governs one agent: an exact user-agent match wins over `*`,
 * which is the precedence every major crawler documents.
 */
function groupFor(groups: RobotsGroup[], token: string): RobotsGroup | null {
	const wanted = token.toLowerCase();
	const exact = groups.filter((group) => group.agents.includes(wanted));
	if (exact.length > 0) return { agents: [wanted], rules: exact.flatMap((group) => group.rules) };
	const wildcard = groups.filter((group) => group.agents.includes("*"));
	if (wildcard.length > 0) return { agents: ["*"], rules: wildcard.flatMap((group) => group.rules) };
	return null;
}

/**
 * Whether one agent may fetch one path. Longest matching rule wins and Allow
 * breaks a tie, as the robots exclusion protocol specifies; an empty
 * `Disallow:` allows everything, which is why rule length is what decides.
 */
export function robotsAllows(robotsTxt: string, token: string, path = "/"): boolean {
	const group = groupFor(parseRobotsTxt(robotsTxt), token);
	if (!group) return true;
	let decision = true;
	let matched = -1;
	for (const rule of group.rules) {
		if (rule.path === "") continue;
		const pattern = rule.path.replace(/\*+$/, "");
		if (!path.startsWith(pattern)) continue;
		if (pattern.length > matched || (pattern.length === matched && rule.allow)) {
			matched = pattern.length;
			decision = rule.allow;
		}
	}
	return decision;
}

export type BlockedCrawler = AiCrawler & { path: string };

/**
 * Every catalogued crawler the site refuses at `path`. `UNKNOWN` robots
 * evidence — no robots.txt served, or the fetch failed — blocks nothing: an
 * absent file permits crawling, and a failed read is not evidence of refusal.
 */
export function blockedAiCrawlers(robotsTxt: string | null | undefined, path = "/"): BlockedCrawler[] {
	if (!robotsTxt || robotsTxt === "UNKNOWN") return [];
	return AI_CRAWLERS.filter((crawler) => !robotsAllows(robotsTxt, crawler.token, path)).map((crawler) => ({
		...crawler,
		path,
	}));
}

/**
 * Robots directives that stop an engine using the page it just fetched.
 * `noindex` keeps it out of the index entirely; `nosnippet` and
 * `max-snippet:0` forbid quoting from it, and a quote is what an AI answer
 * is made of.
 */
export function restrictiveMetaRobots(value: string | null | undefined): string[] {
	if (!value || value === "UNKNOWN") return [];
	const directives = value
		.toLowerCase()
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	const found = directives.filter(
		(directive) =>
			directive === "noindex" ||
			directive === "none" ||
			directive === "nosnippet" ||
			directive === "max-snippet:0" ||
			/^max-snippet\s*:\s*0$/.test(directive),
	);
	return [...new Set(found)];
}

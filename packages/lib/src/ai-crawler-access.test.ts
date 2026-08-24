import { describe, expect, it } from "vitest";
import { blockedAiCrawlers, restrictiveMetaRobots, robotsAllows } from "./ai-crawler-access";

describe("robots.txt access", () => {
	it("applies the group whose user-agent matches, preferring the exact one over the wildcard", () => {
		const robots = ["User-agent: *", "Disallow: /", "", "User-agent: OAI-SearchBot", "Disallow:"].join("\n");
		expect(robotsAllows(robots, "OAI-SearchBot")).toBe(true);
		expect(robotsAllows(robots, "PerplexityBot")).toBe(false);
	});

	it("lets the longest matching rule decide, with Allow breaking a tie", () => {
		const robots = ["User-agent: *", "Disallow: /private", "Allow: /private/public"].join("\n");
		expect(robotsAllows(robots, "GPTBot", "/private/notes")).toBe(false);
		expect(robotsAllows(robots, "GPTBot", "/private/public/page")).toBe(true);
		expect(robotsAllows(robots, "GPTBot", "/")).toBe(true);
	});

	it("shares one rule block between the user-agents listed together above it", () => {
		const robots = ["User-agent: GPTBot", "User-agent: ClaudeBot", "Disallow: /"].join("\n");
		expect(robotsAllows(robots, "GPTBot")).toBe(false);
		expect(robotsAllows(robots, "ClaudeBot")).toBe(false);
		expect(robotsAllows(robots, "OAI-SearchBot")).toBe(true);
	});

	it("ignores comments and unreadable lines instead of throwing", () => {
		const robots = ["# nothing to see", "Sitemap: https://example.com/sitemap.xml", "garbage"].join("\n");
		expect(robotsAllows(robots, "Googlebot")).toBe(true);
		expect(blockedAiCrawlers(robots)).toEqual([]);
	});

	it("treats a missing robots.txt as permission, never as refusal", () => {
		expect(blockedAiCrawlers(null)).toEqual([]);
		expect(blockedAiCrawlers("UNKNOWN")).toEqual([]);
		expect(blockedAiCrawlers("")).toEqual([]);
	});

	it("separates crawlers by what blocking one costs", () => {
		const robots = [
			"User-agent: GPTBot",
			"Disallow: /",
			"",
			"User-agent: OAI-SearchBot",
			"Disallow: /",
			"",
			"User-agent: ChatGPT-User",
			"Disallow: /",
		].join("\n");
		const blocked = blockedAiCrawlers(robots);
		const byClass = (name: string) => blocked.filter((crawler) => crawler.crawlerClass === name).map((c) => c.token);
		expect(byClass("search")).toEqual(["OAI-SearchBot"]);
		expect(byClass("user_fetch")).toEqual(["ChatGPT-User"]);
		expect(byClass("training")).toEqual(["GPTBot"]);
	});

	it("reports a site that refuses everything for every catalogued crawler", () => {
		const blocked = blockedAiCrawlers(["User-agent: *", "Disallow: /"].join("\n"));
		expect(blocked.some((crawler) => crawler.token === "Googlebot")).toBe(true);
		expect(blocked.some((crawler) => crawler.token === "PerplexityBot")).toBe(true);
	});
});

describe("meta robots directives", () => {
	it("finds the directives that stop an engine using the page", () => {
		expect(restrictiveMetaRobots("index, follow")).toEqual([]);
		expect(restrictiveMetaRobots("noindex, follow")).toEqual(["noindex"]);
		expect(restrictiveMetaRobots("NoSnippet")).toEqual(["nosnippet"]);
		expect(restrictiveMetaRobots("max-snippet:0")).toEqual(["max-snippet:0"]);
		expect(restrictiveMetaRobots("none")).toEqual(["none"]);
	});

	it("says nothing when the page declares no policy", () => {
		expect(restrictiveMetaRobots("UNKNOWN")).toEqual([]);
		expect(restrictiveMetaRobots(null)).toEqual([]);
	});
});

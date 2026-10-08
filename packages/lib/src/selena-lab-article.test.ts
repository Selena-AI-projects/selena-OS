import { describe, expect, it } from "vitest";
import { LabArticleRefused, labArticleFile, labArticleRefusal } from "./selena-lab-article";

const PROVENANCE = {
	contentHash: "a".repeat(64),
	contentVersionId: "11111111-1111-1111-1111-111111111111",
	manifestHash: "b".repeat(64),
	releaseIntentId: "33333333-3333-3333-3333-333333333333",
};

const DESCRIPTION =
	"Why a restaurant that ranks on Google can still be missing from AI recommendations, and the three checks that show where it drops out.";

function disclosure(overrides: Record<string, unknown> = {}, language = "en") {
	return {
		language,
		metadata: {
			meta_description: DESCRIPTION,
			meta_title: "Missing from AI recommendations",
			slug: "ai-recommendations-check",
			...overrides,
		},
		origin: { project_id: "p", system: "aether" },
	};
}

const ARTICLE = `# Why AI assistants skip a restaurant that ranks on Google

A restaurant can rank first on Google and still be absent from **AI answers**.

## What the assistants read

They repeat what a few pages already say, as [Google explains](https://developers.google.com/search/docs/appearance/ai-features).

## Three checks

Start with the listings.

### Listings [EXTRACTED]

- Maps
- Review sites

1. Open the assistant
2. Ask for a table for two

The order matters. See the [methodology](/methodology).

## Next step

Run the free check on your own site.

- [Run Public Readiness](/check)
- [Explore AI Visibility](/visibility)

## Sources

- [AI features and your website](https://developers.google.com/search/docs/appearance/ai-features) — Google Search Central

## Related reading

- [Methodology](/methodology)
`;

function convert(body = ARTICLE, metadata: Record<string, unknown> = {}, language = "en") {
	return labArticleFile({
		body,
		disclosure: disclosure(metadata, language),
		provenance: PROVENANCE,
		publishedOn: "2026-10-07",
	});
}

function refusalOf(body: string, metadata: Record<string, unknown> = {}, language = "en"): string {
	try {
		convert(body, metadata, language);
	} catch (error) {
		if (error instanceof LabArticleRefused) return error.message;
		throw error;
	}
	throw new Error("expected the article to be refused");
}

describe("labArticleFile", () => {
	it("turns an approved English article into the site's Lab entry, in the order it was written", () => {
		const file = convert();
		expect(file).toMatchObject({
			labPath: "/lab/articles/ai-recommendations-check",
			locale: "en",
			path: "data/lab/articles/ai-recommendations-check.en.json",
			slug: "ai-recommendations-check",
			title: "Why AI assistants skip a restaurant that ranks on Google",
		});
		expect(file.content.endsWith("}\n")).toBe(true);
		expect(JSON.parse(file.content)).toEqual({
			section: "articles",
			slug: "ai-recommendations-check",
			title: "Why AI assistants skip a restaurant that ranks on Google",
			summary: DESCRIPTION,
			label: "Article",
			readingTime: "1 min",
			publishedAt: "2026-10-07",
			updatedAt: "2026-10-07",
			metaTitle: "Missing from AI recommendations",
			intro: ["A restaurant can rank first on Google and still be absent from AI answers."],
			blocks: [
				{
					heading: "What the assistants read",
					paragraphs: ["They repeat what a few pages already say, as Google explains."],
				},
				{
					heading: "Three checks",
					paragraphs: ["Start with the listings."],
					flow: [
						{ subheading: "Listings", tag: "EXTRACTED" },
						{ points: ["Maps", "Review sites"] },
						{ steps: ["Open the assistant", "Ask for a table for two"] },
						{ paragraph: "The order matters. See the methodology." },
					],
				},
			],
			cta: {
				paragraphs: ["Run the free check on your own site."],
				primary: { href: "/check", title: "Run Public Readiness" },
				secondary: { href: "/visibility", title: "Explore AI Visibility" },
			},
			sources: [
				{
					href: "https://developers.google.com/search/docs/appearance/ai-features",
					publisher: "Google Search Central",
					title: "AI features and your website",
				},
			],
			related: [{ href: "/methodology", title: "Methodology" }],
			provenance: PROVENANCE,
		});
	});

	it("keeps a Russian edition on Russian pages and labels it in Russian", () => {
		const russian = `# Почему ИИ-помощники не советуют ресторан

Ресторан может быть первым в Google и отсутствовать в ответах ИИ.

## Что читают помощники

Они повторяют то, что уже написано на нескольких страницах.

### Справочники [EXTRACTED]

- Карты

## Что дальше

Проверьте свой сайт: [запустить проверку](/ru/check).

## Источники

- [AI features and your website](https://developers.google.com/search/docs/appearance/ai-features) — Google
`;
		const file = convert(russian, {}, "ru-RU");
		const entry = JSON.parse(file.content);
		expect(file.path).toBe("data/lab/articles/ai-recommendations-check.ru.json");
		expect(file.labPath).toBe("/ru/lab/articles/ai-recommendations-check");
		expect(entry.label).toBe("Статья");
		expect(entry.readingTime).toBe("1 минута");
		expect(entry.blocks[0].flow[0]).toEqual({ subheading: "Справочники", tag: "ИЗВЛЕЧЕНО" });
		expect(entry.cta).toEqual({
			paragraphs: ["Проверьте свой сайт: запустить проверку."],
			primary: { href: "/ru/check", title: "запустить проверку" },
		});

		expect(refusalOf(russian.replace("/ru/check", "/check"), {}, "ru")).toMatch(/stay in the article's language/);
	});

	it("keeps the first publication date on a revision", () => {
		const file = labArticleFile({
			body: ARTICLE,
			disclosure: disclosure(),
			provenance: PROVENANCE,
			publishedOn: "2026-10-07",
			updatedOn: "2026-11-02",
		});
		expect(JSON.parse(file.content)).toMatchObject({ publishedAt: "2026-10-07", updatedAt: "2026-11-02" });
		expect(() =>
			labArticleFile({
				body: ARTICLE,
				disclosure: disclosure(),
				provenance: PROVENANCE,
				publishedOn: "2026-10-07",
				updatedOn: "2026-10-01",
			}),
		).toThrow(/cannot be dated before/);
	});

	it("estimates reading time from the words a reader sees, in the edition's language", () => {
		const readingTime = (words: number, language: string) =>
			JSON.parse(convert(`# Title\n\n## Section\n\n${"word ".repeat(words).trim()}\n`, {}, language).content)
				.readingTime;
		expect(readingTime(1000, "en")).toBe("6 min");
		expect(readingTime(1000, "ru")).toBe("6 минут");
		expect(readingTime(250, "ru")).toBe("2 минуты");
		expect(readingTime(2100, "ru")).toBe("11 минут");
		expect(readingTime(4100, "ru")).toBe("21 минута");
	});

	it("refuses what the Lab page cannot show instead of dropping it", () => {
		const cases: Array<[string, RegExp]> = [
			[ARTICLE.replace("Start with the listings.", "```\ncode\n```"), /Code blocks/],
			[ARTICLE.replace("Start with the listings.", "    indented code"), /Code blocks/],
			[ARTICLE.replace("Start with the listings.", "> a quote"), /Quotes/],
			[ARTICLE.replace("Start with the listings.", "| a | b |\n|---|---|\n| 1 | 2 |"), /Tables/],
			[ARTICLE.replace("Start with the listings.", "a | b\n--- | ---\n1 | 2"), /Tables/],
			[ARTICLE.replace("Start with the listings.", "![chart](https://example.com/chart.png)"), /Images/],
			[ARTICLE.replace("Start with the listings.", "#### Too deep"), /below level 3/],
			[ARTICLE.replace("Start with the listings.", "Claim.[^1]"), /Footnotes/],
			[ARTICLE.replace("Start with the listings.", "Text <br> more"), /HTML/],
			[
				ARTICLE.replace("Start with the listings.", "See [a blog](https://example.com/post)."),
				/not listed under Sources/,
			],
			[ARTICLE.replace("# Why AI", "Opening.\n\n# Why AI"), /title must come first/],
			[ARTICLE.replace("# Why AI assistants skip a restaurant that ranks on Google\n", ""), /needs a title/],
			[`${ARTICLE}\n# A second title\n`, /exactly one title/],
			[ARTICLE.replace("## Three checks", "## What the assistants read"), /headings must be unique/],
			[ARTICLE.replace("## Next step", "## Empty\n\n## Next step"), /has nothing under it/],
			[`${ARTICLE}\n## Sources\n\n- [Again](https://example.com) — Ex\n`, /appears more than once/],
			[
				ARTICLE.replace(
					"- [AI features and your website](https://developers.google.com/search/docs/appearance/ai-features) — Google Search Central",
					"- [Plain](http://example.com) — Ex",
				),
				/must read "\[Title\]\(https/,
			],
			[
				ARTICLE.replace("- [Methodology](/methodology)", "- [Elsewhere](https://example.com/methodology)"),
				/page on this site/,
			],
			[
				ARTICLE.replace(
					"- [Explore AI Visibility](/visibility)",
					"- [Explore AI Visibility](/visibility)\n- [Third](/lab)",
				),
				/at most two links/,
			],
			[ARTICLE.replace("Run the free check on your own site.\n\n", ""), /needs a sentence before its link/],
			[
				ARTICLE.replace("- [Run Public Readiness](/check)", "- [Run Public Readiness](https://example.com/check)"),
				/page on this site/,
			],
		];
		for (const [body, reason] of cases) {
			expect(refusalOf(body), reason.source).toMatch(reason);
		}
	});

	it("refuses an article whose search fields break the owner's rules", () => {
		expect(refusalOf(ARTICLE, { slug: "Not A Slug" })).toMatch(/slug/);
		expect(refusalOf(ARTICLE, { meta_title: "Short" })).toMatch(/search title must be 13–43 characters; it is 5/);
		expect(refusalOf(ARTICLE, { meta_title: "x".repeat(44) })).toMatch(/it is 44/);
		expect(refusalOf(ARTICLE, { meta_description: "Too short." })).toMatch(/search description must be 120–160/);
		expect(refusalOf(ARTICLE, {}, "de")).toMatch(/English and Russian/);
		expect(() =>
			labArticleFile({ body: ARTICLE, disclosure: disclosure(), provenance: PROVENANCE, publishedOn: "2026-02-30" }),
		).toThrow(/not a real date/);
	});
});

describe("labArticleRefusal", () => {
	it("lets only an Aether article that converts cleanly through", () => {
		expect(labArticleRefusal({ body: ARTICLE, disclosure: disclosure(), materialKind: "ARTICLE" })).toBeNull();
		expect(labArticleRefusal({ body: ARTICLE, disclosure: disclosure(), materialKind: "SOCIAL_ADAPTATION" })).toMatch(
			/only an article/i,
		);
		expect(labArticleRefusal({ body: ARTICLE, disclosure: disclosure(), materialKind: null })).toMatch(/from Aether/);
		expect(
			labArticleRefusal({ body: ARTICLE, disclosure: disclosure({ meta_title: "Short" }), materialKind: "ARTICLE" }),
		).toMatch(/search title/);
	});
});

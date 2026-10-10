/**
 * An approved article as the Selena Lab site stores it: one JSON file,
 * `data/lab/articles/<slug>.<en|ru>.json`, in the site repository.
 *
 * The conversion is deterministic and refuses rather than guesses: the site
 * renders plain text in fixed slots, so Markdown it cannot show (tables,
 * images, quotes, code, inline links to pages the article does not cite) stops
 * the release with a reason instead of being silently dropped. The checks here
 * mirror the ones the site's own build applies (SELENA-AI-COMPANY
 * `lib/lab/files.ts`), so a pull request is not opened for a file the site
 * would refuse.
 */

export class LabArticleRefused extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LabArticleRefused";
	}
}

export type LabLocale = "en" | "ru";

export type LabArticleProvenance = {
	contentHash: string;
	contentVersionId: string;
	manifestHash: string;
	releaseIntentId: string;
};

export type LabArticleFile = {
	/** JSON text as it is committed, ending in a newline. */
	content: string;
	/** The page address the article will have on the site. */
	labPath: string;
	locale: LabLocale;
	/** Path of the file inside the site repository. */
	path: string;
	slug: string;
	title: string;
};

export type LabEdition = Pick<LabArticleFile, "labPath" | "locale" | "path" | "slug">;

type Link = { href: string; title: string };
type Source = { href: string; publisher: string; title: string };
type FlowItem =
	| { paragraph: string }
	| { points: string[] }
	| { steps: string[] }
	| { subheading: string; tag?: string };
type Block = { flow?: FlowItem[]; heading: string; paragraphs: string[] };

const SITE_HOSTS = new Set(["www.selenasystems.com", "selenasystems.com"]);
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// The site appends " — Selena Systems" and the owner's rule is 30–60
// characters for the whole title.
const SITE_SUFFIX_LENGTH = " — Selena Systems".length;
const META_TITLE = { max: 60 - SITE_SUFFIX_LENGTH, min: 30 - SITE_SUFFIX_LENGTH };
const SUMMARY = { max: 160, min: 120 };
const WORDS_PER_MINUTE = 200;

const RESERVED = {
	cta: new Set(["next step", "что дальше"]),
	related: new Set(["related reading", "related", "смежное", "читайте также"]),
	sources: new Set(["sources", "источники"]),
};

// The site shows an evidence tag in the article's own language, whichever
// language the author tagged the claim in.
const EVIDENCE_TAGS: Record<string, Record<LabLocale, string>> = {
	EXTRACTED: { en: "EXTRACTED", ru: "ИЗВЛЕЧЕНО" },
	INTERPRETED: { en: "INTERPRETED", ru: "ИНТЕРПРЕТИРОВАНО" },
	ИЗВЛЕЧЕНО: { en: "EXTRACTED", ru: "ИЗВЛЕЧЕНО" },
	ИНТЕРПРЕТИРОВАНО: { en: "INTERPRETED", ru: "ИНТЕРПРЕТИРОВАНО" },
};

type Element =
	| { kind: "paragraph"; text: string }
	| { items: string[]; kind: "points" | "steps" }
	| { kind: "subheading"; text: string };

type Section = { elements: Element[]; heading: string };

function localeOf(language: string): LabLocale | null {
	return /^en\b/.test(language) ? "en" : /^ru\b/.test(language) ? "ru" : null;
}

function edition(slug: string, locale: LabLocale): LabEdition {
	return {
		labPath: `${locale === "ru" ? "/ru/lab" : "/lab"}/articles/${slug}`,
		locale,
		path: `data/lab/articles/${slug}.${locale}.json`,
		slug,
	};
}

function refuse(message: string): never {
	throw new LabArticleRefused(message);
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stripEmphasis(text: string): string {
	return text
		.replace(/(\*\*|__)(?=\S)(.*?\S)\1/g, "$2")
		.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1$2")
		.replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, "$1$2")
		.replace(/~~(?=\S)([^~\n]*?\S)~~/g, "$1")
		.replace(/`([^`\n]+)`/g, "$1")
		.replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, "$1")
		.trim();
}

const LINK = /\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
const HAS_LINK = new RegExp(LINK.source);
const AUTOLINK = /<(https?:\/\/[^>\s]+)>/g;
const HTML_TAG = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?\/?>/;

/** A link on the site, as the path the site uses, or null for anywhere else. */
function sitePath(href: string): string | null {
	if (href.startsWith("/") && !href.startsWith("//")) {
		if (/[?#]/.test(href)) return null;
		return href.replace(/\/+$/, "") || "/";
	}
	try {
		const url = new URL(href);
		if (url.protocol !== "https:" || !SITE_HOSTS.has(url.hostname) || url.search || url.hash) return null;
		return url.pathname.replace(/\/+$/, "") || "/";
	} catch {
		return null;
	}
}

function inLocale(path: string, locale: LabLocale): boolean {
	const russian = path === "/ru" || path.startsWith("/ru/");
	return russian === (locale === "ru");
}

function isRealDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const parsed = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Splits the Markdown into the opening, its title and the `##` sections, refusing what the site cannot show. */
function parse(markdown: string): { intro: Element[]; sections: Section[]; title: string } {
	let title: string | null = null;
	const intro: Element[] = [];
	const sections: Section[] = [];
	let target = intro;
	let paragraph: string[] = [];
	let list: { items: string[]; kind: "points" | "steps" } | null = null;

	const flushParagraph = () => {
		if (paragraph.length > 0) target.push({ kind: "paragraph", text: paragraph.join(" ") });
		paragraph = [];
	};
	const flushList = () => {
		if (list) target.push(list);
		list = null;
	};
	const flush = () => {
		flushParagraph();
		flushList();
	};

	for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
		const line = raw.trim();
		if (/^(```|~~~)/.test(line) || (/^( {4}|\t)\S/.test(raw) && !list && paragraph.length === 0))
			refuse("Code blocks cannot be shown on a Lab page");
		if (/^#{4,6}\s/.test(line)) refuse("Headings below level 3 cannot be shown on a Lab page");
		if (line.startsWith(">")) refuse("Quotes cannot be shown on a Lab page");
		if (line.startsWith("|") || /^:?-{3,}:?(\s*\|\s*:?-{3,}:?)+\s*\|?$/.test(line))
			refuse("Tables cannot be shown on a Lab page");
		if (/!\[[^\]]*\]\(/.test(line)) refuse("Images cannot be shown on a Lab page");
		if (/\[\^[^\]]+\]/.test(line)) refuse("Footnotes cannot be shown on a Lab page; cite the source under Sources");
		if (/^\[[^\]]+\]:\s*\S/.test(line)) refuse("Reference-style links cannot be shown; write each link inline");
		if (!line) {
			// A blank line ends a paragraph but not a list: items of one list may
			// be separated by blank lines.
			flushParagraph();
			continue;
		}
		if (/^([-*_])(?:\s*\1){2,}$/.test(line)) {
			flush();
			continue;
		}
		const h1 = /^#\s+(.+?)(?:\s+#+)?$/.exec(line);
		if (h1) {
			if (title !== null) refuse("An article has exactly one title (one # heading)");
			if (sections.length > 0 || intro.length > 0 || paragraph.length > 0 || list)
				refuse("The # title must come first");
			if (HAS_LINK.test(h1[1])) refuse("The title cannot hold a link");
			title = stripEmphasis(h1[1]);
			continue;
		}
		const h2 = /^##\s+(.+?)(?:\s+#+)?$/.exec(line);
		if (h2) {
			flush();
			const section: Section = { elements: [], heading: stripEmphasis(h2[1]) };
			sections.push(section);
			target = section.elements;
			continue;
		}
		const h3 = /^###\s+(.+?)(?:\s+#+)?$/.exec(line);
		if (h3) {
			flush();
			target.push({ kind: "subheading", text: h3[1].trim() });
			continue;
		}
		const bullet = /^[-*+]\s+(.+)$/.exec(line);
		const numbered = /^\d+[.)]\s+(.+)$/.exec(line);
		if (bullet || numbered) {
			flushParagraph();
			const kind = bullet ? "points" : "steps";
			if (list && list.kind !== kind) flushList();
			list ??= { items: [], kind };
			list.items.push((bullet ?? numbered)?.[1] ?? "");
			continue;
		}
		// An indented line under a list item continues that item.
		if (list && /^\s/.test(raw)) {
			list.items[list.items.length - 1] += ` ${line}`;
			continue;
		}
		flushList();
		paragraph.push(line.replace(/\\$/, "").trim());
	}
	flush();
	if (title === null) refuse("An article needs a title: one # heading at the top");
	return { intro, sections, title };
}

function sourceFrom(item: string): Source {
	const match = /^\[([^\]]+)\]\(\s*(https:\/\/[^)\s]+)\s*\)\s*(?:[—–-]\s*(.+))?$/.exec(item.trim());
	if (!match) refuse(`A source must read "[Title](https://…) — Publisher": ${item}`);
	const [, title, href, publisher] = match;
	return {
		href,
		publisher: publisher ? stripEmphasis(publisher) : new URL(href).hostname.replace(/^www\./, ""),
		title: stripEmphasis(title),
	};
}

function onlyItems(section: Section, name: string): string[] {
	const items: string[] = [];
	for (const element of section.elements) {
		if (element.kind !== "points" && element.kind !== "steps") refuse(`${name} must be a list of links`);
		items.push(...element.items);
	}
	if (items.length === 0) refuse(`${name} is empty`);
	return items;
}

/** Replaces each inline link with its words, allowed only for pages the article lists, and strips emphasis. */
function plain(text: string, allowed: ReadonlySet<string>): string {
	const check = (href: string) => {
		const path = sitePath(href);
		if (!allowed.has(href) && !(path && allowed.has(path)))
			refuse(`The inline link to ${href} is not listed under Sources or Related; the Lab page cannot show it`);
	};
	const withoutLinks = text
		.replace(LINK, (_match, label: string, href: string) => {
			check(href);
			return label;
		})
		.replace(AUTOLINK, (_match, href: string) => {
			check(href);
			return href;
		});
	if (HTML_TAG.test(withoutLinks.replace(/`[^`\n]+`/g, ""))) refuse("HTML cannot be shown on a Lab page");
	return stripEmphasis(withoutLinks);
}

function subheading(text: string, allowed: ReadonlySet<string>, locale: LabLocale): FlowItem {
	const tagged = /^(.*?)\s*\[([^\]]+)\]\s*$/.exec(text);
	const tag = tagged ? EVIDENCE_TAGS[tagged[2].trim().toUpperCase()]?.[locale] : undefined;
	const words = plain(tag && tagged ? tagged[1] : text, allowed);
	return tag ? { subheading: words, tag } : { subheading: words };
}

function block(section: Section, allowed: ReadonlySet<string>, locale: LabLocale): Block {
	const paragraphs: string[] = [];
	const flow: FlowItem[] = [];
	for (const element of section.elements) {
		if (element.kind === "paragraph" && flow.length === 0) paragraphs.push(plain(element.text, allowed));
		else if (element.kind === "paragraph") flow.push({ paragraph: plain(element.text, allowed) });
		else if (element.kind === "subheading") flow.push(subheading(element.text, allowed, locale));
		else {
			const items = element.items.map((item) => plain(item, allowed));
			flow.push(element.kind === "points" ? { points: items } : { steps: items });
		}
	}
	if (paragraphs.length === 0 && flow.length === 0) refuse(`The section "${section.heading}" has nothing under it`);
	const heading = plain(section.heading, allowed);
	return flow.length > 0 ? { flow, heading, paragraphs } : { heading, paragraphs };
}

/**
 * The Next step section: its sentences, then one or two buttons. The buttons
 * are the links of a list in the section, or else the links in its sentences,
 * the first being the main one.
 */
function callToAction(
	section: Section,
	allowed: Set<string>,
	locale: LabLocale,
): { paragraphs: string[]; primary: Link; secondary?: Link } {
	const linksIn = (texts: string[]) =>
		texts.flatMap((text) => [...text.matchAll(LINK)].map((match) => ({ href: match[2], title: match[1] })));
	const listed = section.elements.flatMap((element) =>
		element.kind === "subheading"
			? refuse("The Next step section cannot hold a subheading")
			: element.kind === "paragraph"
				? []
				: element.items,
	);
	const sentences = section.elements.flatMap((element) => (element.kind === "paragraph" ? [element.text] : []));
	const candidates = listed.length > 0 ? linksIn(listed) : linksIn(sentences);
	if (listed.length > 0 && candidates.length !== listed.length)
		refuse("Each item in the Next step list must be a link");
	if (candidates.length === 0) refuse("The Next step section needs a link to a page on this site");
	if (candidates.length > 2) refuse("The Next step section takes at most two links");
	const buttons = candidates.map((candidate) => {
		const path = sitePath(candidate.href);
		if (!path) refuse(`The Next step link must point to a page on this site: ${candidate.href}`);
		if (!inLocale(path, locale)) refuse(`The Next step link must stay in the article's language: ${path}`);
		allowed.add(path);
		return { href: path, title: stripEmphasis(candidate.title) };
	});
	// A sentence that is nothing but a button's link would only repeat the button.
	const paragraphs = sentences
		.filter((text) => text.replace(LINK, "").replace(/[\s.,;:!?—–-]/g, "") !== "")
		.map((text) => plain(text, allowed));
	if (paragraphs.length === 0) refuse("The Next step section needs a sentence before its link");
	const [primary, secondary] = buttons;
	return secondary ? { paragraphs, primary, secondary } : { paragraphs, primary };
}

function wordCount(texts: readonly string[]): number {
	return texts.join(" ").split(/\s+/).filter(Boolean).length;
}

function readingTime(minutes: number, locale: LabLocale): string {
	if (locale === "en") return `${minutes} min`;
	const lastTwo = minutes % 100;
	const last = minutes % 10;
	const form =
		last === 1 && lastTwo !== 11
			? "минута"
			: last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)
				? "минуты"
				: "минут";
	return `${minutes} ${form}`;
}

function blockTexts(entry: Block): string[] {
	return [
		entry.heading,
		...entry.paragraphs,
		...(entry.flow ?? []).flatMap((item) =>
			"paragraph" in item
				? [item.paragraph]
				: "points" in item
					? item.points
					: "steps" in item
						? item.steps
						: [item.subheading],
		),
	];
}

/**
 * The site file for an approved article, or a refusal saying what to fix.
 *
 * `disclosure` is the version's disclosure as Aether delivered it: its
 * `language` decides the edition and its `metadata` carries the slug, search
 * title and description the site requires. `publishedOn` and `updatedOn` are
 * calendar dates; a revision keeps the date the article first came out.
 */
export function labArticleFile(input: {
	body: string;
	disclosure: unknown;
	provenance: LabArticleProvenance;
	publishedOn: string;
	updatedOn?: string;
}): LabArticleFile {
	const disclosure = record(input.disclosure);
	const metadata = record(disclosure.metadata);
	const language = typeof disclosure.language === "string" ? disclosure.language.toLowerCase() : "";
	const locale = localeOf(language);
	if (!locale)
		refuse(`Selena Lab publishes English and Russian; this article is "${language || "of no stated language"}"`);

	const slug = typeof metadata.slug === "string" ? metadata.slug : "";
	if (!SLUG.test(slug)) refuse("The article needs a slug in lowercase Latin words joined by hyphens");
	const metaTitle = typeof metadata.meta_title === "string" ? metadata.meta_title.trim() : "";
	if (metaTitle.length < META_TITLE.min || metaTitle.length > META_TITLE.max)
		refuse(`The search title must be ${META_TITLE.min}–${META_TITLE.max} characters; it is ${metaTitle.length}`);
	const summary = typeof metadata.meta_description === "string" ? metadata.meta_description.trim() : "";
	if (summary.length < SUMMARY.min || summary.length > SUMMARY.max)
		refuse(`The search description must be ${SUMMARY.min}–${SUMMARY.max} characters; it is ${summary.length}`);
	const updatedOn = input.updatedOn ?? input.publishedOn;
	if (!isRealDate(input.publishedOn) || !isRealDate(updatedOn)) refuse("The publication date is not a real date");
	if (updatedOn < input.publishedOn) refuse("An update cannot be dated before the first publication");

	const parsed = parse(input.body);
	const reserved = (names: ReadonlySet<string>) => {
		const found = parsed.sections.filter((section) =>
			names.has(
				section.heading
					.toLowerCase()
					.replace(/[:.]\s*$/, "")
					.trim(),
			),
		);
		if (found.length > 1) refuse(`The section "${found[0].heading}" appears more than once`);
		return found[0] ?? null;
	};
	const sourcesSection = reserved(RESERVED.sources);
	const relatedSection = reserved(RESERVED.related);
	const ctaSection = reserved(RESERVED.cta);

	const sources = sourcesSection ? onlyItems(sourcesSection, "Sources").map(sourceFrom) : [];
	const related: Link[] = relatedSection
		? onlyItems(relatedSection, "Related").map((item) => {
				const match = /^\[([^\]]+)\]\(\s*([^)\s]+)\s*\)$/.exec(item.trim());
				const path = match ? sitePath(match[2]) : null;
				if (!match || !path) refuse(`A related link must point to a page on this site: ${item}`);
				if (!inLocale(path, locale)) refuse(`A related link must stay in the article's language: ${path}`);
				return { href: path, title: stripEmphasis(match[1]) };
			})
		: [];
	const allowed = new Set<string>([...sources.map((source) => source.href), ...related.map((link) => link.href)]);
	const cta = ctaSection ? callToAction(ctaSection, allowed, locale) : null;

	if (parsed.intro.some((element) => element.kind !== "paragraph"))
		refuse("The opening under the title holds paragraphs only; put lists and subheadings under a section");
	const intro = parsed.intro.flatMap((element) => (element.kind === "paragraph" ? [plain(element.text, allowed)] : []));
	const isReserved = (section: Section) =>
		section === sourcesSection || section === relatedSection || section === ctaSection;
	const blocks = parsed.sections
		.filter((section) => !isReserved(section))
		.map((section) => block(section, allowed, locale));
	if (blocks.length === 0) refuse("An article needs at least one ## section");
	const headings = blocks.map((entry) => entry.heading);
	if (new Set(headings).size !== headings.length) refuse("Section headings must be unique");

	const minutes = Math.max(
		1,
		Math.ceil(wordCount([parsed.title, ...intro, ...blocks.flatMap(blockTexts)]) / WORDS_PER_MINUTE),
	);

	const entry = {
		section: "articles",
		slug,
		title: parsed.title,
		summary,
		label: locale === "en" ? "Article" : "Статья",
		readingTime: readingTime(minutes, locale),
		publishedAt: input.publishedOn,
		updatedAt: updatedOn,
		metaTitle,
		...(intro.length > 0 ? { intro } : {}),
		blocks,
		...(cta ? { cta } : {}),
		sources,
		...(related.length > 0 ? { related } : {}),
		provenance: input.provenance,
	};
	return { content: `${JSON.stringify(entry, null, 2)}\n`, ...edition(slug, locale), title: parsed.title };
}

/**
 * Where the edition a disclosure names lives on the site, or null when it does
 * not name one Selena Lab can hold.
 */
export function labEditionOf(input: unknown): LabEdition | null {
	const disclosure = record(input);
	const locale = localeOf(typeof disclosure.language === "string" ? disclosure.language.toLowerCase() : "");
	const slug = record(disclosure.metadata).slug;
	return locale && typeof slug === "string" && SLUG.test(slug) ? edition(slug, locale) : null;
}

/**
 * The article as a revision of the file already on the site: it keeps the
 * date it first came out, and only `updatedAt` moves.
 */
export function asRevisionOf(file: LabArticleFile, previousContent: string): LabArticleFile {
	let previous: unknown;
	try {
		previous = JSON.parse(previousContent);
	} catch {
		return file;
	}
	const publishedAt = record(previous).publishedAt;
	const entry = JSON.parse(file.content) as Record<string, unknown>;
	if (typeof publishedAt !== "string" || !isRealDate(publishedAt) || publishedAt > String(entry.updatedAt)) return file;
	return { ...file, content: `${JSON.stringify({ ...entry, publishedAt }, null, 2)}\n` };
}

/** Why an approved material cannot become a Lab article, or null when it can. */
export function labArticleRefusal(input: {
	body: string;
	disclosure: unknown;
	materialKind?: string | null;
}): string | null {
	if (input.materialKind !== "ARTICLE") {
		return input.materialKind
			? `Only an article can be published to Selena Lab; this material is ${input.materialKind}`
			: "Only an article from Aether can be published to Selena Lab";
	}
	try {
		labArticleFile({
			body: input.body,
			disclosure: input.disclosure,
			provenance: { contentHash: "-", contentVersionId: "-", manifestHash: "-", releaseIntentId: "-" },
			publishedOn: "2000-01-01",
		});
		return null;
	} catch (error) {
		if (error instanceof LabArticleRefused) return error.message;
		throw error;
	}
}

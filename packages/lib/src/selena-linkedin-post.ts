/**
 * What reaches a LinkedIn Page, and what may.
 *
 * LinkedIn shows a post as plain text, so Markdown arrives as literal hashes and
 * asterisks, and a post over its character limit is refused by LinkedIn only
 * after the provider has already accepted the submission. The text is shaped
 * here, once, so the Control Room can refuse an unfit post at approval and the
 * provider adapter sends exactly what was checked.
 */

/** LinkedIn's limit for the text of a single post. */
export const LINKEDIN_POST_MAX_CHARACTERS = 3000;

/**
 * Aether material kinds written to be a LinkedIn post. The others — an article,
 * a brief, a page update, a video script — are long-form or not posts at all;
 * a material created in the Control Room carries no kind and is a post.
 */
const LINKEDIN_POST_MATERIAL_KINDS: ReadonlySet<string> = new Set(["SOCIAL_ADAPTATION"]);

function stripInlineMarkdown(text: string): string {
	return (
		text
			.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g, (_match, label: string, url: string) =>
				label.trim() === url ? url : `${label} (${url})`,
			)
			.replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
			.replace(/(\*\*|__)(?=\S)(.*?\S)\1/g, "$2")
			// Single-marker emphasis only where the marker cannot be part of a word, so
			// snake_case and URLs keep their underscores.
			.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1$2")
			.replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, "$1$2")
			.replace(/~~(?=\S)([^~\n]*?\S)~~/g, "$1")
			.replace(/`([^`\n]+)`/g, "$1")
			.replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, "$1")
	);
}

/** Markdown as LinkedIn will show it: the same words, without the syntax. */
export function markdownToPlainText(markdown: string): string {
	const lines: string[] = [];
	let inFence = false;
	for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
		const line = raw.replace(/\s+$/, "");
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) {
			lines.push(line);
			continue;
		}
		if (/^\s{0,3}([-*_])(?:\s*\1){2,}$/.test(line)) continue;
		const heading = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?$/.exec(line);
		const text = heading ? heading[1] : line.replace(/^\s{0,3}>\s?/, "").replace(/^(\s*)[-*+]\s+/, "$1• ");
		lines.push(stripInlineMarkdown(text));
	}
	return lines
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * The exact text of a LinkedIn post: the body as plain text, then the call to
 * action on its own line unless the body already carries that link.
 */
export function linkedInPostText(body: string, ctaUrl?: string | null): string {
	const text = markdownToPlainText(body);
	if (!ctaUrl || text.includes(ctaUrl)) return text;
	return text ? `${text}\n\n${ctaUrl}` : ctaUrl;
}

/**
 * Why a material cannot go out as a LinkedIn post, or null when it can.
 *
 * `materialKind` is the kind an Aether material arrived with; `contentKind` is
 * the Content OS kind of a material created in the Control Room.
 */
export function linkedInPostRefusal(input: {
	body: string;
	contentKind?: string | null;
	ctaUrl?: string | null;
	materialKind?: string | null;
}): string | null {
	if (input.contentKind === "YOUTUBE_VIDEO") return "A YouTube video script cannot be released as a LinkedIn post";
	if (input.materialKind && !LINKEDIN_POST_MATERIAL_KINDS.has(input.materialKind)) {
		return input.materialKind === "ARTICLE"
			? "An article cannot be released as a LinkedIn post; release its LinkedIn adaptation instead"
			: `This material (${input.materialKind}) cannot be released as a LinkedIn post`;
	}
	const length = linkedInPostText(input.body, input.ctaUrl).length;
	if (length > LINKEDIN_POST_MAX_CHARACTERS) {
		return `This post is ${length} characters as LinkedIn will show it; LinkedIn allows ${LINKEDIN_POST_MAX_CHARACTERS}`;
	}
	return null;
}

import { describe, expect, it } from "vitest";
import {
	LINKEDIN_POST_MAX_CHARACTERS,
	linkedInPostRefusal,
	linkedInPostText,
	markdownToPlainText,
} from "./selena-linkedin-post";

describe("LinkedIn post text", () => {
	it("shows Markdown the way LinkedIn will: the words without the syntax", () => {
		const markdown = [
			"# Why AI answers skip your brand",
			"",
			"Most brands are **invisible** to *assistants*, and `robots.txt` is rarely why.",
			"",
			"## What to check",
			"",
			"- Your [methodology](https://www.selenasystems.com/methodology) page",
			"* Whether sources cite you",
			"1. Run a baseline",
			"",
			"> Measure before you optimise.",
			"",
			"---",
			"",
			"",
			"",
			"Read more at <https://www.selenasystems.com/check>.",
		].join("\n");

		expect(markdownToPlainText(markdown)).toBe(
			[
				"Why AI answers skip your brand",
				"",
				"Most brands are invisible to assistants, and robots.txt is rarely why.",
				"",
				"What to check",
				"",
				"• Your methodology (https://www.selenasystems.com/methodology) page",
				"• Whether sources cite you",
				"1. Run a baseline",
				"",
				"Measure before you optimise.",
				"",
				"Read more at https://www.selenasystems.com/check.",
			].join("\n"),
		);
	});

	it("keeps hashtags, snake_case words and URLs with underscores intact", () => {
		expect(markdownToPlainText("#AIVisibility for brand_name at https://example.com/a_b_c")).toBe(
			"#AIVisibility for brand_name at https://example.com/a_b_c",
		);
	});

	it("adds the call to action on its own line, once", () => {
		expect(linkedInPostText("A short post.", "https://www.selenasystems.com/check")).toBe(
			"A short post.\n\nhttps://www.selenasystems.com/check",
		);
		expect(
			linkedInPostText("Start here: https://www.selenasystems.com/check", "https://www.selenasystems.com/check"),
		).toBe("Start here: https://www.selenasystems.com/check");
	});
});

describe("what may go out as a LinkedIn post", () => {
	const post = { body: "A LinkedIn adaptation of the article.", ctaUrl: "https://www.selenasystems.com/check" };

	it("accepts a LinkedIn adaptation from Aether and a post written in the Control Room", () => {
		expect(linkedInPostRefusal({ ...post, materialKind: "SOCIAL_ADAPTATION" })).toBeNull();
		expect(linkedInPostRefusal({ ...post, contentKind: "GENERIC_POST", materialKind: null })).toBeNull();
	});

	it("refuses an article, pointing to its LinkedIn adaptation", () => {
		expect(linkedInPostRefusal({ ...post, materialKind: "ARTICLE" })).toMatch(/release its LinkedIn adaptation/);
	});

	it("refuses materials that are not posts at all", () => {
		expect(linkedInPostRefusal({ ...post, materialKind: "BRIEF" })).toMatch(/cannot be released as a LinkedIn post/);
		expect(linkedInPostRefusal({ ...post, contentKind: "YOUTUBE_VIDEO" })).toMatch(/video script/);
	});

	it("refuses a post LinkedIn would cut off, counting the text LinkedIn shows", () => {
		const atLimit = "a".repeat(LINKEDIN_POST_MAX_CHARACTERS);
		expect(linkedInPostRefusal({ body: atLimit, materialKind: "SOCIAL_ADAPTATION" })).toBeNull();
		// The Markdown markers are not shown, so they do not count against the limit.
		expect(linkedInPostRefusal({ body: `**${atLimit}**`, materialKind: "SOCIAL_ADAPTATION" })).toBeNull();
		expect(
			linkedInPostRefusal({ body: atLimit, ctaUrl: "https://www.selenasystems.com/check", materialKind: null }),
		).toMatch(/LinkedIn allows 3000/);
	});
});

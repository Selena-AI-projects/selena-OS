import { describe, expect, it } from "vitest";
import { questionLanguagePrefix } from "../selena-suggestion";

describe("questionLanguagePrefix", () => {
	it("tags a Russian question RU whatever the project language is", () => {
		expect(questionLanguagePrefix("лучшее кафе в Убуде", "en")).toBe("RU");
	});

	it("falls back to the project language for everything else", () => {
		expect(questionLanguagePrefix("best cafe in Ubud", "en")).toBe("EN");
		expect(questionLanguagePrefix("best cafe in Ubud", "id")).toBe("ID");
		expect(questionLanguagePrefix("best cafe in Ubud", undefined)).toBe("EN");
	});

	it("tags a mixed question by its Cyrillic, so a brand name in latin does not flip it", () => {
		expect(questionLanguagePrefix("где поесть рядом с Kora Food Hall", "en")).toBe("RU");
	});
});

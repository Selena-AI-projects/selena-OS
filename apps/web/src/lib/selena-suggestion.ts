/**
 * Shared by the suggestion server function and the workspace UI that describes
 * it, so the promise on screen and the request sent cannot drift apart.
 *
 * Kept out of the server module on purpose: importing a plain value from there
 * would pull its database imports into the client bundle.
 */
export const SUGGESTION_LIMITS = { competitors: 8, questions: 12 } as const;

/**
 * The research call returns question text with no language field, so the
 * script decides: Cyrillic is Russian, anything else belongs to the language
 * the project was created in. The prefix is what the profile form parses back.
 */
export function questionLanguagePrefix(question: string, projectLanguage: string | undefined): string {
	if (/[Ѐ-ӿ]/.test(question)) return "RU";
	return (projectLanguage ?? "en").toUpperCase();
}

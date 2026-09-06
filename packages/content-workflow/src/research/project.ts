/**
 * The single project a research run is scored against.
 *
 * Upstream resolved a project from a shared JSON registry, so any run could
 * reference any project. Here the project is derived from one brand's confirmed
 * profile version and carries that version's identity, which is what makes a
 * stored run traceable to the facts it was scored against — and what makes it
 * impossible to score a run against another brand's vocabulary.
 */

import type { NormalizedProjectProfile } from "../profile/index";
import type { ResearchProject } from "./contracts";
import { ContentResearchError } from "./contracts";

const MAX_TERMS = 60;
const MIN_TERM_LENGTH = 3;

/**
 * Profile prose becomes search vocabulary: normalized, de-duplicated and sorted
 * so the same profile always derives the same project, and a run is reproducible
 * from its recorded profile hash alone.
 */
function toTerms(values: readonly string[]): string[] {
	const terms = new Set<string>();
	for (const value of values) {
		const term = value.trim().toLowerCase().replace(/\s+/g, " ");
		if (term.length >= MIN_TERM_LENGTH) terms.add(term);
	}
	return [...terms].sort().slice(0, MAX_TERMS);
}

export interface DeriveResearchProjectInput {
	brandId: string;
	profileVersionId: string;
	profileHash: string;
	profile: NormalizedProjectProfile;
}

export function deriveResearchProject(input: DeriveResearchProjectInput): ResearchProject {
	const keywords = toTerms([
		input.profile.audience.primary,
		...input.profile.audience.secondary,
		...input.profile.audience.needs,
		...input.profile.voice.traits,
	]);

	if (keywords.length === 0) {
		throw new ContentResearchError(
			"INVALID_INPUT",
			"The confirmed profile carries no audience or voice terms to research against",
		);
	}

	return {
		brandId: input.brandId,
		slug: input.brandId,
		languages: input.profile.languages.map((language) => language.trim().toLowerCase()),
		keywords,
		// Voice exclusions and visual avoidances are the brand's own statement of
		// what it will not publish, so they filter discovery too.
		negativeKeywords: toTerms([...input.profile.voice.exclusions, ...input.profile.visualRules.avoid]),
		profileVersionId: input.profileVersionId,
		profileHash: input.profileHash,
	};
}

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

function normalizeTerm(value: string): string {
	return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Profile prose becomes search vocabulary: normalized, de-duplicated and sorted
 * so the same profile always derives the same project, and a run is reproducible
 * from its recorded profile hash alone.
 *
 * The sort exists for reproducibility only. Nothing may treat the first element
 * as the most important one — that mistake is what once let a voice trait
 * beginning with an early letter become the subject of a run.
 */
function toTerms(values: readonly string[]): string[] {
	const terms = new Set<string>();
	for (const value of values) {
		const term = normalizeTerm(value);
		if (term.length >= MIN_TERM_LENGTH) terms.add(term);
	}
	return [...terms].sort().slice(0, MAX_TERMS);
}

/**
 * The same normalization, but keeping the owner's order. Used for topics, where
 * the order a person wrote things in is the priority they meant.
 */
function toOrderedTerms(values: readonly string[]): string[] {
	const terms: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const term = normalizeTerm(value);
		if (term.length < MIN_TERM_LENGTH || seen.has(term)) continue;
		seen.add(term);
		terms.push(term);
	}
	return terms.slice(0, MAX_TERMS);
}

export interface DeriveResearchProjectInput {
	brandId: string;
	profileVersionId: string;
	profileHash: string;
	profile: NormalizedProjectProfile;
}

export function deriveResearchProject(input: DeriveResearchProjectInput): ResearchProject {
	// Voice traits say how this brand speaks, not what it speaks about, so they
	// are deliberately absent from both the search vocabulary and the topics.
	// They reach creation through the profile itself.
	const keywords = toTerms([
		input.profile.audience.primary,
		...input.profile.audience.secondary,
		...input.profile.audience.needs,
	]);

	// What the owner wants covered, in the order they wrote it. Needs come before
	// secondary audiences because a need is already a subject; an audience is a
	// reader. The primary audience is prose about who, so it never becomes a
	// topic — a run with no stated topic falls back to the brand itself rather
	// than borrowing a term that was never meant as one.
	const topics = toOrderedTerms([...input.profile.audience.needs, ...input.profile.audience.secondary]);

	if (keywords.length === 0) {
		throw new ContentResearchError(
			"INVALID_INPUT",
			"The confirmed profile carries no audience terms to research against",
		);
	}

	return {
		brandId: input.brandId,
		slug: input.brandId,
		languages: input.profile.languages.map((language) => language.trim().toLowerCase()),
		keywords,
		topics,
		// Voice exclusions and visual avoidances are the brand's own statement of
		// what it will not publish, so they filter discovery too.
		negativeKeywords: toTerms([...input.profile.voice.exclusions, ...input.profile.visualRules.avoid]),
		profileVersionId: input.profileVersionId,
		profileHash: input.profileHash,
	};
}

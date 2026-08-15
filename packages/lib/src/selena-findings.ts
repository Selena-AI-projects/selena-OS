export type VisibilityFinding = {
	severity: "critical" | "high" | "medium" | "low";
	category: string;
	title: string;
	detail: string;
};
export type VisibilityRecommendation = {
	priority: "now" | "next" | "later";
	title: string;
	action: string;
	rationale: string;
};

export function deriveFindings(input: {
	mentionRate: number;
	ownedCitationRate: number;
	invalidRate: number;
	visitorApiDivergence: number;
}): VisibilityFinding[] {
	const findings: VisibilityFinding[] = [];
	if (input.mentionRate < 0.2)
		findings.push({
			severity: "high",
			category: "visibility",
			title: "Low AI mention rate",
			detail: "The brand is rarely named in the approved discovery scenarios.",
		});
	if (input.ownedCitationRate < 0.2)
		findings.push({
			severity: "high",
			category: "citations",
			title: "Weak owned citation coverage",
			detail: "AI answers seldom cite the approved brand domains.",
		});
	if (input.invalidRate > 0.1)
		findings.push({
			severity: "medium",
			category: "quality",
			title: "Elevated invalid response rate",
			detail: "The dataset contains more invalid responses than the 10% quality threshold.",
		});
	if (input.visitorApiDivergence > 0.3)
		findings.push({
			severity: "medium",
			category: "methodology",
			title: "Visitor/API divergence",
			detail: "Visitor View and API View produce materially different visibility outcomes.",
		});
	return findings;
}

export function deriveRecommendations(findings: VisibilityFinding[]): VisibilityRecommendation[] {
	return findings.map((finding) => ({
		priority: finding.severity === "critical" || finding.severity === "high" ? "now" : "next",
		title: `Improve ${finding.category}`,
		action:
			finding.category === "citations"
				? "Publish and maintain authoritative, crawlable pages for the questions where the brand should be cited."
				: "Review the affected scenarios and strengthen the public evidence supporting the brand's positioning.",
		rationale: finding.detail,
	}));
}

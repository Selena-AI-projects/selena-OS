// Assembles the customer-facing grader report from per-run answer analyses.
//
// Pure by construction, like the analysis module it consumes: every number in
// the report must be recomputable from retained evidence, and every section
// that has nothing to stand on reports UNKNOWN (null) rather than zero.

import {
	type AnalysisSubject,
	type AnswerAnalysis,
	type ScenarioSetSummary,
	hasStandaloneMention,
	normalizeDomain,
	summarizeScenarioSet,
} from "./selena-answer-analysis";

export type GraderChannel = "VISITOR" | "API";

export type GraderRunInput = {
	runId: string;
	systemId: string;
	channel: GraderChannel;
	scenarioId: string;
	scenarioText: string;
	scenarioLanguage: string;
	/** Null when neither the answer text nor a stored analysis survives. */
	analysis: AnswerAnalysis | null;
};

export type GraderSubjects = {
	brand: AnalysisSubject;
	competitors: readonly AnalysisSubject[];
};

export type GraderGroupBreakdown = {
	answers: number;
	mentioned: number;
};

export type GraderSystemBreakdown = {
	systemId: string;
	channel: GraderChannel;
	answersExpected: number;
	answersAnalyzed: number;
	brandMentioned: number;
	branded: GraderGroupBreakdown;
	category: GraderGroupBreakdown;
	shareOfVoice: number | null;
	averageOrder: number | null;
};

export type GraderRosterEntry = {
	name: string;
	isBrand: boolean;
	answersMentioned: number;
	/** Null means UNKNOWN: never named, so there is no position to average. */
	averageOrder: number | null;
};

export type GraderGapRow = {
	runId: string;
	systemId: string;
	channel: GraderChannel;
	scenarioText: string;
	scenarioLanguage: string;
	competitorsShown: string[];
	citedDomains: string[];
};

export type GraderRecommendation =
	| { kind: "SOURCE_PRESENCE"; domain: string; timesCited: number; timesCitedWithoutBrand: number }
	| { kind: "OWN_SITE_UNDERCITED"; domain: string; timesCited: number; topExternalDomain: string; topExternalCited: number }
	| { kind: "CATEGORY_CONTENT"; missedAnswers: number; categoryAnswers: number; exampleQuestions: string[] };

export type GraderQuestion = {
	scenarioId: string;
	text: string;
	language: string;
	branded: boolean;
};

export type GraderReport = {
	methodology: {
		questions: number;
		visitorSystems: number;
		apiSystems: number;
		/** Null when the measurement scope is unreadable: UNKNOWN, not a guess. */
		repeats: number | null;
		answersExpected: number;
		answersAnalyzed: number;
		answersMissing: number;
	};
	systems: GraderSystemBreakdown[];
	overall: ScenarioSetSummary;
	roster: GraderRosterEntry[];
	gaps: GraderGapRow[];
	recommendations: GraderRecommendation[];
	questions: GraderQuestion[];
};

/**
 * A question is "branded" when it names the business — the definition the
 * report states to the customer, so it is decided from the question text, not
 * from how the scenario was produced.
 */
export function isBrandedQuestion(text: string, brand: AnalysisSubject): boolean {
	// The same standalone-word rule mentions use: a substring check would count
	// "кора" inside "декоративные" as the brand, corrupting the split the
	// report promises never to merge.
	const needles = [brand.name, ...(brand.aliases ?? [])];
	return needles.some((needle) => {
		const trimmed = needle.trim();
		return trimmed.length >= 2 && hasStandaloneMention(text, trimmed);
	});
}

function mean(values: readonly number[]): number {
	let total = 0;
	for (const value of values) total += value;
	return total / values.length;
}

const MAX_GAP_COMPETITORS = 3;
const MAX_GAP_DOMAINS = 3;
const MAX_SOURCE_RECOMMENDATIONS = 3;
const MAX_EXAMPLE_QUESTIONS = 2;

export function buildGraderReport(input: {
	runs: readonly GraderRunInput[];
	subjects: GraderSubjects;
	repeats?: number | null;
}): GraderReport {
	const { runs, subjects } = input;
	const brandDomain = subjects.brand.domain;

	// A run whose scenario row is gone has no question to classify: it stays in
	// the per-system totals but joins neither group and never renders as a
	// blank "approved question".
	const withQuestion = (run: GraderRunInput): boolean => run.scenarioText.trim() !== "";
	const questionsById = new Map<string, GraderQuestion>();
	for (const run of runs)
		if (withQuestion(run) && !questionsById.has(run.scenarioId))
			questionsById.set(run.scenarioId, {
				scenarioId: run.scenarioId,
				text: run.scenarioText,
				language: run.scenarioLanguage,
				branded: isBrandedQuestion(run.scenarioText, subjects.brand),
			});
	const questions = [...questionsById.values()];
	const brandedIds = new Set(questions.filter((q) => q.branded).map((q) => q.scenarioId));

	// Per-system breakdown; VISITOR systems come first, matching how the
	// report is read (what customers see, then what models know).
	// Keyed by channel AND system: two channels must never merge into one row —
	// that would blend what customers see with what models know.
	const systemsById = new Map<string, GraderRunInput[]>();
	for (const run of runs) {
		const key = `${run.channel}:${run.systemId}`;
		const bucket = systemsById.get(key) ?? [];
		bucket.push(run);
		systemsById.set(key, bucket);
	}
	const systems: GraderSystemBreakdown[] = [...systemsById.values()]
		.map((systemRuns) => {
			const analyzed = systemRuns.filter((run) => run.analysis !== null);
			const analyses = analyzed.map((run) => run.analysis as AnswerAnalysis);
			const summary = summarizeScenarioSet(analyses, { brandDomain });
			const group = (branded: boolean): GraderGroupBreakdown => {
				const inGroup = analyzed.filter((run) => withQuestion(run) && brandedIds.has(run.scenarioId) === branded);
				return {
					answers: inGroup.length,
					mentioned: inGroup.filter((run) => (run.analysis as AnswerAnalysis).brandMentioned).length,
				};
			};
			return {
				systemId: systemRuns[0].systemId,
				channel: systemRuns[0].channel,
				answersExpected: systemRuns.length,
				answersAnalyzed: analyzed.length,
				brandMentioned: analyses.filter((analysis) => analysis.brandMentioned).length,
				branded: group(true),
				category: group(false),
				shareOfVoice: summary.brandShareOfVoice,
				averageOrder: summary.brandAverageOrder,
			};
		})
		.sort((left, right) =>
			left.channel === right.channel
				? left.systemId.localeCompare(right.systemId)
				: left.channel === "VISITOR"
					? -1
					: 1,
		);

	const allAnalyses = runs.filter((run) => run.analysis !== null).map((run) => run.analysis as AnswerAnalysis);
	const overall = summarizeScenarioSet(allAnalyses, { brandDomain });

	// Roster: the brand plus every competitor the customer configured — the
	// zero rows are the point, so absence stays visible as UNKNOWN, not as a
	// missing row.
	const orders = new Map<string, number[]>();
	for (const analysis of allAnalyses)
		for (const mention of analysis.mentions) {
			const key = mention.role === "TARGET" ? subjects.brand.name : mention.name;
			const bucket = orders.get(key) ?? [];
			bucket.push(mention.order);
			orders.set(key, bucket);
		}
	const rosterFor = (subject: AnalysisSubject, isBrand: boolean): GraderRosterEntry => {
		const positions = orders.get(subject.name) ?? [];
		return {
			name: subject.name,
			isBrand,
			answersMentioned: positions.length,
			averageOrder: positions.length === 0 ? null : mean(positions),
		};
	};
	const roster = [
		rosterFor(subjects.brand, true),
		...subjects.competitors
			.map((competitor) => rosterFor(competitor, false))
			.sort(
				(left, right) =>
					right.answersMentioned - left.answersMentioned ||
					(left.averageOrder ?? Number.POSITIVE_INFINITY) - (right.averageOrder ?? Number.POSITIVE_INFINITY) ||
					left.name.localeCompare(right.name),
			),
	];

	// The gap table: answers that named a competitor and not the brand.
	const gaps: GraderGapRow[] = runs
		.filter((run) => {
			const analysis = run.analysis;
			return (
				analysis !== null &&
				!analysis.brandMentioned &&
				analysis.mentions.some((mention) => mention.role === "COMPETITOR")
			);
		})
		.map((run) => {
			const analysis = run.analysis as AnswerAnalysis;
			return {
				runId: run.runId,
				systemId: run.systemId,
				channel: run.channel,
				scenarioText: run.scenarioText,
				scenarioLanguage: run.scenarioLanguage,
				competitorsShown: [
					...new Set(
						analysis.mentions
							.filter((mention) => mention.role === "COMPETITOR")
							.sort((left, right) => left.order - right.order)
							.map((mention) => mention.name),
					),
				].slice(0, MAX_GAP_COMPETITORS),
				citedDomains: analysis.citedDomains.slice(0, MAX_GAP_DOMAINS),
			};
		});

	// Recommendations are observations restated as actions; each carries the
	// counts it was derived from so the UI can show its "why".
	const recommendations: GraderRecommendation[] = [];
	// A subdomain of the brand's own site is not a third party to "get into";
	// recommending presence on blog.<own-domain> would be nonsense.
	const brandHost = brandDomain ? normalizeDomain(brandDomain) : null;
	const ownedDomain = (domain: string): boolean =>
		brandHost !== null && (domain === brandHost || domain.endsWith(`.${brandHost}`));
	const externalGaps = overall.citationGap.filter(
		(entry) => !entry.ownedByBrand && !ownedDomain(entry.domain) && entry.timesCitedWithoutBrand > 0,
	);
	for (const entry of externalGaps.slice(0, MAX_SOURCE_RECOMMENDATIONS))
		recommendations.push({
			kind: "SOURCE_PRESENCE",
			domain: entry.domain,
			timesCited: entry.timesCited,
			timesCitedWithoutBrand: entry.timesCitedWithoutBrand,
		});
	const categoryAnswers = runs.filter(
		(run) => run.analysis !== null && withQuestion(run) && !brandedIds.has(run.scenarioId),
	);
	const categoryMissed = categoryAnswers.filter((run) => !(run.analysis as AnswerAnalysis).brandMentioned);
	if (categoryMissed.length > 0)
		recommendations.push({
			kind: "CATEGORY_CONTENT",
			missedAnswers: categoryMissed.length,
			categoryAnswers: categoryAnswers.length,
			exampleQuestions: [...new Set(categoryMissed.map((run) => run.scenarioText))].slice(0, MAX_EXAMPLE_QUESTIONS),
		});
	const ownEntry = overall.citationGap.find((entry) => entry.ownedByBrand);
	// The comparison is against the MOST-CITED external source — the gap list
	// is sorted by citations-without-brand, which is a different ranking.
	const topExternal = overall.citationGap
		.filter((entry) => !entry.ownedByBrand && !ownedDomain(entry.domain))
		.reduce<(typeof overall.citationGap)[number] | null>(
			(best, entry) => (best === null || entry.timesCited > best.timesCited ? entry : best),
			null,
		);
	if (brandDomain && topExternal && (ownEntry?.timesCited ?? 0) < topExternal.timesCited)
		recommendations.push({
			kind: "OWN_SITE_UNDERCITED",
			domain: brandDomain,
			timesCited: ownEntry?.timesCited ?? 0,
			topExternalDomain: topExternal.domain,
			topExternalCited: topExternal.timesCited,
		});

	return {
		methodology: {
			questions: questions.length,
			visitorSystems: systems.filter((system) => system.channel === "VISITOR").length,
			apiSystems: systems.filter((system) => system.channel === "API").length,
			repeats: input.repeats ?? null,
			answersExpected: runs.length,
			answersAnalyzed: allAnalyses.length,
			answersMissing: runs.length - allAnalyses.length,
		},
		systems,
		overall,
		roster,
		gaps,
		recommendations,
		questions,
	};
}

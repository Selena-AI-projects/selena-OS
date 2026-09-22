/**
 * Dry-run harness for the Jev mention-classification pilot (see JEV-PILOT.md).
 * Makes no network calls: it runs the existing heuristic for real, and builds
 * (without sending) the Jev request each case would produce, so the exact
 * payload shape can be inspected before any real spend is approved.
 *
 * Usage (from the repo root): pnpm --filter @workspace/worker exec tsx src/pilots/jev-mentions/run-dry-run.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyMentions, heuristicMentions } from "./classifier";
import { csvField } from "./csv-utils";
import { SYNTHETIC_CASES } from "./fixtures";

async function main() {
	const rows: string[] = [
		[
			"case",
			"heuristic_brand_mentioned",
			"heuristic_competitors_mentioned",
			"reference_brand",
			"reference_competitors",
			"heuristic_matches_reference",
			"reference_rationale",
			"jev_status",
			"jev_note",
		].join(","),
	];

	for (const testCase of SYNTHETIC_CASES) {
		const heuristic = heuristicMentions(testCase.text, testCase.brand, [...testCase.competitors]);
		const outcome = await classifyMentions(
			{ text: testCase.text, brand: testCase.brand, competitors: [...testCase.competitors] },
			{ enabled: true, dryRun: true },
		);

		let jevStatus = outcome.status;
		let jevNote = "";
		if (outcome.status === "dry_run") {
			jevNote = `would send ${Object.keys(outcome.wouldSend.questions).length} question(s) to model ${outcome.wouldSend.model}`;
		} else if (outcome.status === "insufficient_data") {
			jevNote = outcome.reason;
		}

		const hasReference = testCase.referenceBrand !== null;
		const matches = hasReference
			? heuristic.brandMentioned === testCase.referenceBrand &&
				JSON.stringify([...heuristic.competitorsMentioned].sort()) ===
					JSON.stringify([...testCase.referenceCompetitors].sort())
			: null;

		rows.push(
			[
				csvField(testCase.name),
				String(heuristic.brandMentioned),
				csvField(heuristic.competitorsMentioned.join(";")),
				String(testCase.referenceBrand),
				csvField((testCase.referenceCompetitors ?? []).join(";")),
				matches === null ? "n/a" : String(matches),
				csvField(testCase.referenceRationale),
				jevStatus,
				csvField(jevNote),
			].join(","),
		);
	}

	const outPath = join(process.cwd(), "results.csv");
	writeFileSync(outPath, rows.join("\n") + "\n", "utf-8");

	console.log(`Wrote ${rows.length - 1} rows to ${outPath}`);
	console.log("This is a DRY RUN: no Jev API calls were made, no accuracy numbers were produced.");
	console.log("See JEV-PILOT.md for what this does and does not demonstrate.");
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});

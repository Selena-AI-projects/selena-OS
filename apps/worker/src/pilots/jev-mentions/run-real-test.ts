/**
 * Minimal real-call validation for the Jev mention-classification pilot — the
 * "next real test" proposed in JEV-PILOT.md. NOT run without separate
 * authorization on data (the 7 existing synthetic cases only) and budget.
 *
 * Hard caps, by design, not configurable from the CLI:
 * - at most 7 calls (one per SYNTHETIC_CASES entry)
 * - stops immediately on the first real API error (no burning through the rest)
 * - only ever reads TYPESAFE_API_KEY from the environment; never logs it
 *
 * Usage: TYPESAFE_API_KEY is expected to already be in the environment
 * (e.g. via --env-file pointed at a file outside the repo). Run from apps/worker:
 *   pnpm exec tsx --env-file=<path-to-key-file> src/pilots/jev-mentions/run-real-test.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyMentions } from "./classifier";
import { SYNTHETIC_CASES } from "./fixtures";

const INPUT_PRICE_PER_MILLION_USD = 0.042;
const OUTPUT_PRICE_PER_MILLION_USD = 0;

function csvField(value: string): string {
	return `"${String(value).replace(/"/g, '""')}"`;
}

async function main() {
	if (!process.env.TYPESAFE_API_KEY) {
		console.error("TYPESAFE_API_KEY is not set. Refusing to run — this script must not fall back silently.");
		process.exitCode = 1;
		return;
	}

	const rows: string[] = [
		["case", "jev_status", "model", "entity", "reference", "verdict", "probability", "input_tokens", "output_tokens", "note"].join(
			",",
		),
	];

	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let callsMade = 0;

	for (const testCase of SYNTHETIC_CASES) {
		callsMade++;
		console.log(`[${callsMade}/${SYNTHETIC_CASES.length}] ${testCase.name}`);

		const outcome = await classifyMentions(
			{ text: testCase.text, brand: testCase.brand, competitors: [...testCase.competitors] },
			{ enabled: true }, // dryRun left unset -> false -> real call
		);

		if (outcome.status === "insufficient_data") {
			rows.push([csvField(testCase.name), "insufficient_data", "", "", "", "", "", "", "", csvField(outcome.reason)].join(","));
			continue;
		}

		if (outcome.status === "fallback") {
			// A real API error. Per the proposal, stop instead of burning through the
			// remaining calls against a failing endpoint.
			rows.push([csvField(testCase.name), "fallback (stopped)", "", "", "", "", "", "", "", csvField(outcome.reason)].join(","));
			console.error(`Stopping after a real API failure: ${outcome.reason}`);
			break;
		}

		if (outcome.status === "jev") {
			totalInputTokens += outcome.usage.inputTokens;
			totalOutputTokens += outcome.usage.outputTokens;
			const referenceMap = new Map<string, boolean | null>();
			referenceMap.set("brand", testCase.referenceBrand);
			for (const c of testCase.competitors) {
				referenceMap.set(
					`competitor:${c.name}`,
					testCase.referenceCompetitors === null
						? null
						: (testCase.referenceCompetitors as readonly string[]).includes(c.name),
				);
			}
			for (const entity of outcome.entities) {
				const reference = referenceMap.get(entity.entityId);
				rows.push(
					[
						csvField(testCase.name),
						"jev",
						csvField(outcome.model),
						csvField(entity.entityName),
						reference === null || reference === undefined ? "n/a" : String(reference),
						entity.verdict,
						entity.probability?.toFixed(4) ?? "",
						String(outcome.usage.inputTokens),
						String(outcome.usage.outputTokens),
						"",
					].join(","),
				);
			}
		}
	}

	const inputCost = (totalInputTokens / 1_000_000) * INPUT_PRICE_PER_MILLION_USD;
	const outputCost = (totalOutputTokens / 1_000_000) * OUTPUT_PRICE_PER_MILLION_USD;
	const totalCost = inputCost + outputCost;

	const outPath = join(process.cwd(), "real-test-results.csv");
	writeFileSync(outPath, rows.join("\n") + "\n", "utf-8");

	console.log(`\nCalls made: ${callsMade}/${SYNTHETIC_CASES.length}`);
	console.log(`Total input tokens: ${totalInputTokens}, output tokens: ${totalOutputTokens}`);
	console.log(
		`Measured cost at the confirmed rate ($${INPUT_PRICE_PER_MILLION_USD}/M input, $${OUTPUT_PRICE_PER_MILLION_USD}/M output): $${totalCost.toFixed(6)}`,
	);
	console.log(`Wrote ${rows.length - 1} rows to ${outPath}`);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exitCode = 1;
});

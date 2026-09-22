/**
 * Real-call validation for the Jev mention-classification pilot, split by test
 * category (straightforward / collision / negation / adversarial / invalid_input)
 * rather than pooled into one "accuracy" number. See JEV-PILOT.md.
 *
 * Hard caps, by design, not configurable from the CLI:
 * - one call per SYNTHETIC_CASES entry (currently ~30; each covers 1-2 entities)
 * - stops immediately on the first real API error (no burning through the rest)
 * - only ever reads TYPESAFE_API_KEY from the environment; never logs it
 *
 * The question template in classifier.ts is frozen before this file is run — this
 * script does not feed results back into question wording. If the question needs
 * changing, that's a separate, deliberate edit followed by a fresh full run.
 *
 * Usage: TYPESAFE_API_KEY is expected to already be in the environment
 * (e.g. via --env-file pointed at a file outside the repo). Run from apps/worker:
 *   pnpm exec tsx --env-file=<path-to-key-file> src/pilots/jev-mentions/run-real-test.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyMentions } from "./classifier";
import { csvField } from "./csv-utils";
import { SYNTHETIC_CASES, type TestCategory } from "./fixtures";

const INPUT_PRICE_PER_MILLION_USD = 0.042;
// TypeSafe's announcement (see JEV-PILOT.md) states output tokens are billed at $0 —
// not "not yet measured": if that ever changes, this constant must be updated by hand,
// since nothing here looks up pricing live.
const OUTPUT_PRICE_PER_MILLION_USD = 0;

type JudgmentResult = "correct" | "incorrect" | "ambiguous";

interface CategoryStats {
	correct: number;
	incorrect: number;
	ambiguous: number;
	probabilities: number[];
	latenciesMs: number[];
}

function emptyStats(): CategoryStats {
	return { correct: 0, incorrect: 0, ambiguous: 0, probabilities: [], latenciesMs: [] };
}

function avg(nums: number[]): string {
	if (nums.length === 0) return "n/a";
	return (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(3);
}

async function main() {
	if (!process.env.TYPESAFE_API_KEY) {
		console.error("TYPESAFE_API_KEY is not set. Refusing to run — this script must not fall back silently.");
		process.exitCode = 1;
		return;
	}

	const rows: string[] = [
		[
			"case",
			"category",
			"jev_status",
			"model",
			"entity",
			"reference",
			"verdict",
			"result",
			"probability",
			"input_tokens",
			"output_tokens",
			"latency_ms",
			"note",
		].join(","),
	];

	const statsByCategory = new Map<TestCategory, CategoryStats>();
	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let callsMade = 0;

	for (const testCase of SYNTHETIC_CASES) {
		callsMade++;
		console.log(`[${callsMade}/${SYNTHETIC_CASES.length}] (${testCase.category}) ${testCase.name}`);

		const outcome = await classifyMentions(
			{ text: testCase.text, brand: testCase.brand, competitors: [...testCase.competitors] },
			{ enabled: true }, // dryRun left unset -> false -> real call
		);

		if (outcome.status === "insufficient_data") {
			rows.push(
				[csvField(testCase.name), testCase.category, "insufficient_data", "", "", "", "", "", "", "", "", "", csvField(outcome.reason)].join(
					",",
				),
			);
			continue;
		}

		if (outcome.status === "fallback") {
			// A real API error. Per the proposal, stop instead of burning through the
			// remaining calls against a failing endpoint.
			rows.push(
				[csvField(testCase.name), testCase.category, "fallback (stopped)", "", "", "", "", "", "", "", "", "", csvField(outcome.reason)].join(
					",",
				),
			);
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
				let result: JudgmentResult | "n/a" = "n/a";
				if (reference !== null && reference !== undefined) {
					if (entity.verdict === "ambiguous") {
						result = "ambiguous";
					} else {
						result = (entity.verdict === "yes") === reference ? "correct" : "incorrect";
					}
					if (!statsByCategory.has(testCase.category)) statsByCategory.set(testCase.category, emptyStats());
					const stats = statsByCategory.get(testCase.category)!;
					stats[result]++;
					if (entity.probability !== undefined) stats.probabilities.push(entity.probability);
					stats.latenciesMs.push(outcome.latencyMs);
				}
				rows.push(
					[
						csvField(testCase.name),
						testCase.category,
						"jev",
						csvField(outcome.model),
						csvField(entity.entityName),
						reference === null || reference === undefined ? "n/a" : String(reference),
						entity.verdict,
						result,
						entity.probability?.toFixed(4) ?? "",
						String(outcome.usage.inputTokens),
						String(outcome.usage.outputTokens),
						String(outcome.latencyMs),
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
		`Measured cost at the confirmed rate ($${INPUT_PRICE_PER_MILLION_USD}/M input, $${OUTPUT_PRICE_PER_MILLION_USD}/M output — output price is TypeSafe's published $0, not "unmeasured"): $${totalCost.toFixed(6)}`,
	);
	console.log(`Wrote ${rows.length - 1} rows to ${outPath}`);

	console.log("\n--- Results by category (not pooled into one accuracy number) ---");
	for (const [category, stats] of statsByCategory) {
		const total = stats.correct + stats.incorrect + stats.ambiguous;
		console.log(
			`${category}: ${stats.correct}/${total} correct, ${stats.incorrect} incorrect, ${stats.ambiguous} ambiguous | avg probability ${avg(stats.probabilities)} | avg latency ${avg(stats.latenciesMs)}ms`,
		);
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exitCode = 1;
});

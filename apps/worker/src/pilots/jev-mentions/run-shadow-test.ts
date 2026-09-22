/**
 * Shadow test for the Jev mention-classification pilot: runs the existing
 * heuristic AND a real Jev call side by side on real (not synthetic, NOT client)
 * answer text, logging both outputs for human review. Nothing here decides which
 * one is "right" — there is no ground truth for real, unlabeled text — it only
 * flags where the two DISAGREE, since those are the cases worth a human looking at.
 *
 * This does not touch the main pipeline, any database, or JEV_PILOT_ENABLED in
 * production. Input is a local, gitignored JSON file you prepare yourself; see
 * shadow-input.example.json for the shape. Never put client data in that file.
 *
 * Hard caps, by design:
 * - at most MAX_ENTRIES real calls per run (raise only deliberately, not by habit)
 * - stops immediately on the first real API error
 * - only ever reads TYPESAFE_API_KEY from the environment; never logs it
 *
 * Usage (from apps/worker):
 *   cp src/pilots/jev-mentions/shadow-input.example.json src/pilots/jev-mentions/shadow-input.json
 *   # edit shadow-input.json with real answer text
 *   pnpm exec tsx src/pilots/jev-mentions/run-shadow-test.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Competitor } from "@workspace/lib/db/schema";
import { classifyMentions, heuristicMentions } from "./classifier";
import { csvField } from "./csv-utils";
import { makeBrand, makeCompetitor } from "./fixtures";

const MAX_ENTRIES = 50;
const INPUT_PRICE_PER_MILLION_USD = 0.042;
const OUTPUT_PRICE_PER_MILLION_USD = 0;

interface ShadowInputEntry {
	text: string;
	brandName: string;
	brandWebsite: string;
	brandAliases?: string[];
	competitors: { name: string; domains?: string[]; aliases?: string[] }[];
}

function loadInput(path: string): ShadowInputEntry[] {
	if (!existsSync(path)) {
		throw new Error(
			`No input file at ${path}. Copy shadow-input.example.json to shadow-input.json in the same directory and fill it in with real (non-client) answer text first.`,
		);
	}
	const raw = JSON.parse(readFileSync(path, "utf-8"));
	if (!Array.isArray(raw) || raw.length === 0) {
		throw new Error(`${path} must be a non-empty JSON array of entries.`);
	}
	return raw;
}

async function main() {
	if (!process.env.TYPESAFE_API_KEY) {
		console.error("TYPESAFE_API_KEY is not set. Refusing to run — this script must not fall back silently.");
		process.exitCode = 1;
		return;
	}

	const inputPath = process.argv[2] ?? join(__dirname, "shadow-input.json");
	let entries: ShadowInputEntry[];
	try {
		entries = loadInput(inputPath);
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		process.exitCode = 1;
		return;
	}

	if (entries.length > MAX_ENTRIES) {
		console.error(
			`${entries.length} entries exceeds the safety cap of ${MAX_ENTRIES}. Trim the input or raise MAX_ENTRIES deliberately, not by habit.`,
		);
		process.exitCode = 1;
		return;
	}

	const rows: string[] = [
		[
			"index",
			"text_snippet",
			"entity",
			"heuristic_mentioned",
			"jev_verdict",
			"jev_probability",
			"agreement",
			"input_tokens",
			"output_tokens",
			"latency_ms",
			"note",
		].join(","),
	];

	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let disagreements = 0;
	let comparableJudgments = 0;

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		const brand = makeBrand({ name: entry.brandName, website: entry.brandWebsite, aliases: entry.brandAliases ?? [] });
		const competitors: Competitor[] = entry.competitors.map((c) =>
			makeCompetitor({ id: `shadow-${i}-${c.name}`, name: c.name, domains: c.domains ?? [], aliases: c.aliases ?? [] }),
		);

		const snippet = entry.text.length > 60 ? `${entry.text.slice(0, 60)}...` : entry.text;
		console.log(`[${i + 1}/${entries.length}] ${snippet}`);

		const heuristic = heuristicMentions(entry.text, brand, competitors);
		const outcome = await classifyMentions({ text: entry.text, brand, competitors }, { enabled: true });

		if (outcome.status === "insufficient_data") {
			rows.push([String(i), csvField(snippet), "", "", "", "", "n/a", "", "", "", csvField(outcome.reason)].join(","));
			continue;
		}

		if (outcome.status === "fallback") {
			rows.push([String(i), csvField(snippet), "", "", "fallback (stopped)", "", "n/a", "", "", "", csvField(outcome.reason)].join(","));
			console.error(`Stopping after a real API failure: ${outcome.reason}`);
			break;
		}

		if (outcome.status === "jev") {
			totalInputTokens += outcome.usage.inputTokens;
			totalOutputTokens += outcome.usage.outputTokens;

			const heuristicByEntity = new Map<string, boolean>();
			heuristicByEntity.set("brand", heuristic.brandMentioned);
			for (const c of competitors) heuristicByEntity.set(`competitor:${c.name}`, heuristic.competitorsMentioned.includes(c.name));

			for (const entity of outcome.entities) {
				const heuristicSaid = heuristicByEntity.get(entity.entityId) ?? false;
				let agreement = "n/a";
				if (entity.verdict !== "ambiguous") {
					comparableJudgments++;
					const jevSaid = entity.verdict === "yes";
					agreement = jevSaid === heuristicSaid ? "agree" : "disagree";
					if (agreement === "disagree") disagreements++;
				}
				rows.push(
					[
						String(i),
						csvField(snippet),
						csvField(entity.entityName),
						String(heuristicByEntity.get(entity.entityId) ?? false),
						entity.verdict,
						entity.probability?.toFixed(4) ?? "",
						agreement,
						String(outcome.usage.inputTokens),
						String(outcome.usage.outputTokens),
						String(outcome.latencyMs),
						"",
					].join(","),
				);
			}
		}
	}

	const totalCost =
		(totalInputTokens / 1_000_000) * INPUT_PRICE_PER_MILLION_USD + (totalOutputTokens / 1_000_000) * OUTPUT_PRICE_PER_MILLION_USD;

	const outPath = join(process.cwd(), "shadow-test-results.csv");
	writeFileSync(outPath, rows.join("\n") + "\n", "utf-8");

	console.log(`\nTotal input tokens: ${totalInputTokens}, output tokens: ${totalOutputTokens}`);
	console.log(`Measured cost: $${totalCost.toFixed(6)}`);
	console.log(
		`Heuristic vs. Jev: ${comparableJudgments - disagreements}/${comparableJudgments} agree, ${disagreements} disagree (disagreements need a human look — neither side is assumed correct)`,
	);
	console.log(`Wrote ${rows.length - 1} rows to ${outPath}`);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exitCode = 1;
});

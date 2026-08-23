/**
 * The one live Bright Data probe the owner approved (decision 0.1-A): a single
 * request through the adapter's own request builder, raw response saved as a
 * fixture so the response-shape hypothesis in the adapter can be confirmed or
 * corrected against reality (SELENA_VISITOR_VIEW_BRIGHTDATA_WIRING.md, "What
 * must be confirmed").
 *
 * Run it on a machine that holds the credential — the key never leaves the
 * request header:
 *
 *   SELENA_BRIGHTDATA_PROBE=yes \
 *   BRIGHTDATA_PROBE_ENDPOINT=https://api.brightdata.com/... \
 *   BRIGHTDATA_PROBE_API_KEY=... \
 *   BRIGHTDATA_PROBE_ZONE=... \
 *   pnpm exec tsx scripts/selena-brightdata-probe.ts
 *
 * Exactly one request, no retries, 90s timeout. Set a hard spend limit in the
 * Bright Data dashboard before running — that limit, not this script, is the
 * guard that survives failures outside this process.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	brightDataVisitorSystems,
	buildBrightDataRequestBody,
	parseBrightDataAnswer,
} from "../src/adapters/brightdata-measurement-adapter";

const PROBE_SYSTEM = "chatgpt" as const;
const PROBE_PROMPT = "What are the best spa studios in Ubud, Bali?";
const TIMEOUT_MS = 90_000;

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value || value.trim() === "") {
		console.error(`Missing ${name}. This probe never invents defaults for a paid call.`);
		process.exit(1);
	}
	return value.trim();
}

async function main(): Promise<void> {
	if (process.env.SELENA_BRIGHTDATA_PROBE !== "yes") {
		console.error("Refusing: set SELENA_BRIGHTDATA_PROBE=yes to confirm the one owner-approved live call.");
		process.exit(1);
	}
	const endpoint = requireEnv("BRIGHTDATA_PROBE_ENDPOINT");
	if (!endpoint.startsWith("https://")) {
		console.error("Refusing a non-HTTPS endpoint: the key travels in a header.");
		process.exit(1);
	}
	const apiKey = requireEnv("BRIGHTDATA_PROBE_API_KEY");
	const zone = requireEnv("BRIGHTDATA_PROBE_ZONE");

	const body = buildBrightDataRequestBody({ zone, system: PROBE_SYSTEM, prompt: PROBE_PROMPT });
	console.log(`POST ${endpoint}`);
	console.log(`request body: ${JSON.stringify(body)}`);
	console.log(`(one call, systems available to the adapter: ${brightDataVisitorSystems.join(", ")})`);

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetch(endpoint, {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timer);
	}

	const raw = await response.text();
	const scriptDir = dirname(fileURLToPath(import.meta.url));
	const fixtureDir = join(scriptDir, "..", "src", "adapters", "__fixtures__");
	mkdirSync(fixtureDir, { recursive: true });
	const fixturePath = join(fixtureDir, "brightdata-live-probe.json");
	// The whole exchange minus the credential: status and body are what the
	// wiring questions need answered.
	writeFileSync(
		fixturePath,
		JSON.stringify(
			{
				capturedAt: new Date().toISOString(),
				endpoint,
				requestBody: body,
				responseStatus: response.status,
				responseBody: raw,
			},
			null,
			"\t",
		),
	);
	console.log(`HTTP ${response.status}, ${raw.length} bytes`);
	console.log(`fixture written: ${fixturePath}`);

	if (!response.ok) {
		console.error("Provider refused the request — the fixture records the refusal; do not retry blindly.");
		process.exit(2);
	}
	let payload: unknown;
	try {
		payload = JSON.parse(raw);
	} catch {
		payload = raw;
	}
	const parsed = parseBrightDataAnswer(payload);
	if (parsed === null) {
		console.log("Adapter default parser does NOT recognize this shape — the hypothesis needs correcting (expected outcome of the probe; adjust parseAnswer or the field lists from the fixture).");
	} else {
		console.log(
			`Adapter default parser DOES recognize the shape: answer ${parsed.answerText.length} chars, ${parsed.sources.length} sources${parsed.providerRequestId ? `, request id ${parsed.providerRequestId}` : ""}.`,
		);
	}
	console.log("Commit the fixture (or send it back) so the adapter tests can pin the confirmed shape.");
}

main().catch((error) => {
	// The message may quote request internals; the credential is only in the
	// header variable and is never interpolated into any string above.
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});

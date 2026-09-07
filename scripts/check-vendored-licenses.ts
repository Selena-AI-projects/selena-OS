#!/usr/bin/env tsx

/**
 * Vendored-source attribution check.
 *
 * The dependency audit next door reads `pnpm licenses list`, which only knows
 * about packages we install. Code transferred into this repository carries its
 * own licence obligations and appears in no such list, so it needs its own gate.
 *
 * Exit codes:
 *   0 – every vendored source carries its licence, provenance and ported files
 *   1 – at least one obligation is unmet
 */

import { fileURLToPath } from "node:url";
import { verifyVendoredSources } from "../packages/content-workflow/src/vendored/sources";

/** Packages that vendor third-party source. Add a package here when it starts to. */
const PACKAGES_WITH_VENDORED_SOURCE = ["packages/content-workflow"];

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

let failed = false;
for (const relative of PACKAGES_WITH_VENDORED_SOURCE) {
	const violations = verifyVendoredSources(new URL(`../${relative}/`, import.meta.url).pathname);
	if (violations.length === 0) {
		console.log(`${relative}: vendored source attribution is complete.`);
		continue;
	}
	failed = true;
	console.error(`\n${relative}: ${violations.length} attribution problem(s):\n`);
	for (const violation of violations) {
		console.error(`  ${violation.sourceId}: ${violation.problem}`);
	}
}

if (failed) {
	console.error(
		`\nTransferred code must keep its licence, its NOTICE where upstream has one, and a record of\n` +
			`its source commit and modifications. Fix the missing files rather than the manifest, unless the\n` +
			`source was genuinely removed — in which case remove its entry too.\n` +
			`Repository root: ${repoRoot}`,
	);
	process.exit(1);
}

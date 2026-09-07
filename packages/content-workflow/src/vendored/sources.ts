/**
 * Verifies that every third-party source transferred into this package still
 * carries the attribution its licence requires.
 *
 * The dependency audit in `scripts/check-licenses.mjs` cannot see any of this:
 * vendored code is not a dependency, so it has no entry in `pnpm licenses list`
 * and no manifest of its own. Without a check, an Apache-2.0 obligation is
 * satisfied by a file somebody could delete in a refactor and nothing would say
 * so until it mattered.
 *
 * The check runs in both directions. A declared source with a missing licence,
 * provenance record or ported file fails; so does a directory that appears under
 * `THIRD_PARTY_LICENSES/` without being declared, because vendoring code and
 * forgetting to record it is the failure this exists to catch.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface VendoredSource {
	id: string;
	repository: string;
	/** The exact commit the transfer was made from. A branch name is not provenance. */
	commit: string;
	license: string;
	licenseFile: string;
	/** SHA-256 of the upstream licence text, so a replaced file is caught. */
	licenseSha256: string;
	provenanceFile: string;
	upstreamHasNotice: boolean;
	/** Present when `upstreamHasNotice` is true. */
	noticeFile?: string;
	/** How the NOTICE question was settled, so the answer is checkable later. */
	upstreamNoticeEvidence: string;
	portedFiles: string[];
}

export interface VendoredManifest {
	sources: VendoredSource[];
}

export interface VendoredViolation {
	sourceId: string;
	problem: string;
}

const MANIFEST_FILE = "vendored-sources.json";
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;

function readManifest(licensesDir: string): VendoredManifest {
	const raw = readFileSync(join(licensesDir, MANIFEST_FILE), "utf8");
	const parsed = JSON.parse(raw) as VendoredManifest;
	if (!Array.isArray(parsed.sources)) throw new Error(`${MANIFEST_FILE} has no sources array`);
	return parsed;
}

function fileHasContent(path: string): boolean {
	if (!existsSync(path)) return false;
	const stats = statSync(path);
	return stats.isFile() && stats.size > 0;
}

/**
 * `packageDir` is the package root — the directory holding both `src/` and
 * `THIRD_PARTY_LICENSES/`. Taking it as an argument is what lets the fixture test
 * point the same check at a copy with a file removed.
 */
export function verifyVendoredSources(packageDir: string): VendoredViolation[] {
	const licensesDir = join(packageDir, "THIRD_PARTY_LICENSES");
	const violations: VendoredViolation[] = [];

	if (!existsSync(licensesDir)) {
		return [{ sourceId: "(manifest)", problem: `THIRD_PARTY_LICENSES is missing from ${packageDir}` }];
	}
	if (!fileHasContent(join(licensesDir, MANIFEST_FILE))) {
		return [{ sourceId: "(manifest)", problem: `${MANIFEST_FILE} is missing or empty` }];
	}

	let manifest: VendoredManifest;
	try {
		manifest = readManifest(licensesDir);
	} catch (error) {
		const reason = error instanceof Error ? error.message : "unreadable";
		return [{ sourceId: "(manifest)", problem: `${MANIFEST_FILE} could not be read: ${reason}` }];
	}

	for (const source of manifest.sources) {
		const record = (problem: string) => violations.push({ sourceId: source.id || "(unnamed)", problem });

		if (!FULL_COMMIT_SHA.test(source.commit ?? "")) {
			record(`commit must be a full 40-character sha, not "${source.commit}"`);
		}
		if (!source.repository?.startsWith("https://")) {
			record("repository must be an https url");
		}
		const licensePath = join(licensesDir, source.licenseFile ?? "");
		if (!fileHasContent(licensePath)) {
			record(`licence file ${source.licenseFile} is missing or empty`);
		} else if (!/^[a-f0-9]{64}$/.test(source.licenseSha256 ?? "")) {
			record("licenseSha256 must be the sha-256 of the upstream licence text");
		} else {
			// Presence is not the obligation; carrying the licence is. A file that
			// exists but is not the upstream text satisfies a size check and fails
			// the licence.
			const actual = createHash("sha256").update(readFileSync(licensePath)).digest("hex");
			if (actual !== source.licenseSha256) {
				record(`licence file ${source.licenseFile} does not match the recorded upstream digest`);
			}
		}
		if (!fileHasContent(join(licensesDir, source.provenanceFile ?? ""))) {
			record(`provenance record ${source.provenanceFile} is missing or empty`);
		}
		if (!source.upstreamNoticeEvidence?.trim()) {
			record("upstreamNoticeEvidence must state how the NOTICE question was settled");
		}
		// Apache-2.0 section 4(d) is conditional on upstream shipping a NOTICE. When
		// it does, the file is not optional; when it does not, declaring one would
		// be an invention.
		if (source.upstreamHasNotice) {
			if (!source.noticeFile) record("upstreamHasNotice is true but no noticeFile is declared");
			else if (!fileHasContent(join(licensesDir, source.noticeFile))) {
				record(`upstream NOTICE ${source.noticeFile} is declared but missing or empty`);
			}
		} else if (source.noticeFile) {
			record("noticeFile is declared but upstreamHasNotice is false");
		}

		if (!Array.isArray(source.portedFiles) || source.portedFiles.length === 0) {
			record("portedFiles must list at least one transferred file");
			continue;
		}
		for (const ported of source.portedFiles) {
			if (!fileHasContent(join(packageDir, ported))) {
				record(`ported file ${ported} is recorded but missing`);
			}
		}
	}

	const declared = new Set(manifest.sources.map((source) => source.id));
	for (const entry of readdirSync(licensesDir, { withFileTypes: true })) {
		if (entry.isDirectory() && !declared.has(entry.name)) {
			violations.push({
				sourceId: entry.name,
				problem: `a vendored licence directory exists but is not declared in ${MANIFEST_FILE}`,
			});
		}
	}

	return violations;
}

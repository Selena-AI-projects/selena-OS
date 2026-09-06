import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { verifyVendoredSources } from "./sources";

const packageDir = fileURLToPath(new URL("../..", import.meta.url));
const temporaries: string[] = [];

/**
 * A copy of the real package, so a test can remove a required file and watch the
 * check fail. Asserting only that the real tree passes would prove the check runs,
 * not that it refuses anything.
 */
function copyOfPackage(): string {
	const root = mkdtempSync(join(tmpdir(), "vendored-"));
	temporaries.push(root);
	const destination = join(root, "content-workflow");
	cpSync(join(packageDir, "THIRD_PARTY_LICENSES"), join(destination, "THIRD_PARTY_LICENSES"), { recursive: true });
	cpSync(join(packageDir, "src"), join(destination, "src"), { recursive: true });
	return destination;
}

afterEach(() => {
	for (const path of temporaries.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("vendored source attribution", () => {
	it("passes on this package as it stands", () => {
		expect(verifyVendoredSources(packageDir)).toEqual([]);
	});

	// Each of these is a licence obligation, not a tidiness rule, so each has to
	// fail on its own rather than being covered by one of the others.
	it("fails when the vendored licence is removed", () => {
		const copy = copyOfPackage();
		rmSync(join(copy, "THIRD_PARTY_LICENSES/youtube-pro/LICENSE"));
		expect(verifyVendoredSources(copy)).toContainEqual({
			sourceId: "youtube-pro",
			problem: "licence file youtube-pro/LICENSE is missing or empty",
		});
	});

	// A file that exists but is not the upstream text passes a size check and
	// fails the licence, which is the obligation this exists to keep.
	it("fails when the licence is replaced by something that is not the licence", () => {
		const copy = copyOfPackage();
		writeFileSync(join(copy, "THIRD_PARTY_LICENSES/youtube-pro/LICENSE"), "x");
		expect(verifyVendoredSources(copy)).toContainEqual({
			sourceId: "youtube-pro",
			problem: "licence file youtube-pro/LICENSE does not match the recorded upstream digest",
		});
	});

	it("fails when the provenance record is removed", () => {
		const copy = copyOfPackage();
		rmSync(join(copy, "THIRD_PARTY_LICENSES/youtube-pro/PROVENANCE.md"));
		expect(verifyVendoredSources(copy)).toContainEqual({
			sourceId: "youtube-pro",
			problem: "provenance record youtube-pro/PROVENANCE.md is missing or empty",
		});
	});

	it("fails when a recorded ported file is removed", () => {
		const copy = copyOfPackage();
		rmSync(join(copy, "src/creation/contracts.ts"));
		expect(verifyVendoredSources(copy)).toContainEqual({
			sourceId: "youtube-pro",
			problem: "ported file src/creation/contracts.ts is recorded but missing",
		});
	});

	it("fails when the manifest itself is removed", () => {
		const copy = copyOfPackage();
		rmSync(join(copy, "THIRD_PARTY_LICENSES/vendored-sources.json"));
		expect(verifyVendoredSources(copy)).toEqual([
			{ sourceId: "(manifest)", problem: "vendored-sources.json is missing or empty" },
		]);
	});

	// The conditional half of Apache-2.0 section 4(d): when upstream ships a
	// NOTICE it must travel with the code, and a claim that it does must be true.
	it("fails when a declared upstream NOTICE is absent", () => {
		const copy = copyOfPackage();
		const manifest = join(copy, "THIRD_PARTY_LICENSES/vendored-sources.json");
		writeFileSync(
			manifest,
			JSON.stringify({
				sources: [
					{
						id: "youtube-pro",
						repository: "https://github.com/parkourcafe/youtube-pro",
						commit: "63cd9b9c2ad19b9941a763be3d5cfcbd9bc13b25",
						license: "Apache-2.0",
						licenseFile: "youtube-pro/LICENSE",
						licenseSha256: "b40930bbcf80744c86c46a12bc9da056641d722716c378f5659b9e555ef833e1",
						provenanceFile: "youtube-pro/PROVENANCE.md",
						upstreamHasNotice: true,
						noticeFile: "youtube-pro/NOTICE",
						upstreamNoticeEvidence: "claimed for this fixture",
						portedFiles: ["src/creation/contracts.ts"],
					},
				],
			}),
		);
		expect(verifyVendoredSources(copy)).toContainEqual({
			sourceId: "youtube-pro",
			problem: "upstream NOTICE youtube-pro/NOTICE is declared but missing or empty",
		});
	});

	it("fails when a vendored directory is not declared at all", () => {
		const copy = copyOfPackage();
		cpSync(join(copy, "THIRD_PARTY_LICENSES/youtube-pro"), join(copy, "THIRD_PARTY_LICENSES/some-other-project"), {
			recursive: true,
		});
		expect(verifyVendoredSources(copy)).toContainEqual({
			sourceId: "some-other-project",
			problem: "a vendored licence directory exists but is not declared in vendored-sources.json",
		});
	});

	it("rejects a commit that is not a full sha", () => {
		const copy = copyOfPackage();
		const manifest = join(copy, "THIRD_PARTY_LICENSES/vendored-sources.json");
		writeFileSync(
			manifest,
			JSON.stringify({
				sources: [
					{
						id: "youtube-pro",
						repository: "https://github.com/parkourcafe/youtube-pro",
						commit: "63cd9b9",
						license: "Apache-2.0",
						licenseFile: "youtube-pro/LICENSE",
						licenseSha256: "b40930bbcf80744c86c46a12bc9da056641d722716c378f5659b9e555ef833e1",
						provenanceFile: "youtube-pro/PROVENANCE.md",
						upstreamHasNotice: false,
						upstreamNoticeEvidence: "no NOTICE at this commit",
						portedFiles: ["src/creation/contracts.ts"],
					},
				],
			}),
		);
		expect(verifyVendoredSources(copy)).toContainEqual({
			sourceId: "youtube-pro",
			problem: 'commit must be a full 40-character sha, not "63cd9b9"',
		});
	});
});

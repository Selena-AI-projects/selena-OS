import { describe, expect, it } from "vitest";
import { assertThumbnailAssetsUsable, type ThumbnailAsset, thumbnailBundleMembers } from "./thumbnails";

const NOW = new Date("2026-09-07T00:00:00.000Z");
const VERSION = "42000000-0000-4000-8000-000000000201";

function asset(overrides: Partial<ThumbnailAsset> = {}): ThumbnailAsset {
	return {
		id: "42000000-0000-4000-8000-000000000301",
		contentVersionId: VERSION,
		sha256: "b".repeat(64),
		mimeType: "image/png",
		sizeBytes: 1024,
		scanStatus: "CLEAN",
		origin: "UPLOADED",
		rightsExpiresAt: null,
		consentExpiresAt: null,
		...overrides,
	};
}

function check(assets: readonly ThumbnailAsset[], assetIds: string[] = assets.map((a) => a.id)) {
	assertThumbnailAssetsUsable({
		contentVersionId: VERSION,
		plan: { concept: "A concept", text: "", assetIds },
		assets,
		now: NOW,
	});
}

describe("what a thumbnail has to be before a reviewer sees it", () => {
	it("accepts a clean asset belonging to the version under review", () => {
		expect(() => check([asset()])).not.toThrow();
	});

	it.each([
		["QUARANTINED", "ASSET_NOT_CLEAN"],
		["SCANNING", "ASSET_NOT_CLEAN"],
		["REJECTED", "ASSET_NOT_CLEAN"],
	] as const)("refuses an asset the scanner has not cleared (%s)", (scanStatus, code) => {
		expect(() => check([asset({ scanStatus })])).toThrow(expect.objectContaining({ code }));
	});

	it("refuses an asset attached to another version", () => {
		const other = "42000000-0000-4000-8000-000000000999";
		expect(() => check([asset({ contentVersionId: other })])).toThrow(
			expect.objectContaining({ code: "ASSET_OUT_OF_VERSION" }),
		);
	});

	it("refuses an asset whose rights have run out, and allows one where none were recorded", () => {
		const expired = new Date(NOW.getTime() - 1);
		expect(() => check([asset({ rightsExpiresAt: expired })])).toThrow(
			expect.objectContaining({ code: "ASSET_RIGHTS_EXPIRED" }),
		);
		expect(() => check([asset({ rightsExpiresAt: new Date(NOW.getTime() + 1) })])).not.toThrow();
		expect(() => check([asset({ rightsExpiresAt: null })])).not.toThrow();
	});

	it("refuses an asset whose consent has run out", () => {
		expect(() => check([asset({ consentExpiresAt: new Date(NOW.getTime() - 1) })])).toThrow(
			expect.objectContaining({ code: "ASSET_CONSENT_EXPIRED" }),
		);
	});

	it("refuses a plan that names an asset nobody supplied", () => {
		expect(() => check([], ["42000000-0000-4000-8000-000000000301"])).toThrow(
			expect.objectContaining({ code: "NOT_FOUND" }),
		);
	});

	it("refuses a plan that names the same asset twice", () => {
		const one = asset();
		expect(() => check([one], [one.id, one.id])).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
	});
});

describe("the bundle a reviewer is shown", () => {
	it("is the clean digests in digest order, whatever order they arrive in", () => {
		const members = thumbnailBundleMembers([
			asset({ id: "42000000-0000-4000-8000-000000000301", sha256: "b".repeat(64) }),
			asset({ id: "42000000-0000-4000-8000-000000000302", sha256: "1".repeat(64) }),
			asset({ id: "42000000-0000-4000-8000-000000000303", sha256: "c".repeat(64), scanStatus: "QUARANTINED" }),
		]);
		expect(members).toEqual(["1".repeat(64), "b".repeat(64)]);
	});

	it("is empty when nothing has been cleared", () => {
		expect(thumbnailBundleMembers([asset({ scanStatus: "SCANNING" })])).toEqual([]);
	});
});

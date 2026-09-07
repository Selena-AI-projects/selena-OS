/**
 * What a thumbnail has to be before a reviewer can be shown it.
 *
 * The rules are here rather than in the repository because they are answerable
 * from the asset rows alone, and because a rule that lives next to its database
 * call gets skipped by the second caller. Storage and scanning are I/O and stay
 * with the caller; everything below is a decision about rows already read.
 *
 * `ThumbnailAsset` is deliberately narrower than the `content_assets` row. A
 * module that takes the whole row starts depending on columns it has no business
 * reading, and a thumbnail decision has no business reading a storage key.
 */

import { z } from "zod";
import { ContentCreationError } from "./contracts";

export const thumbnailAssetSchema = z
	.object({
		id: z.string().uuid(),
		contentVersionId: z.string().uuid(),
		sha256: z.string().regex(/^[a-f0-9]{64}$/),
		mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
		sizeBytes: z
			.number()
			.int()
			.positive()
			.max(10 * 1024 * 1024),
		scanStatus: z.enum(["QUARANTINED", "SCANNING", "CLEAN", "REJECTED"]),
		origin: z.enum(["UPLOADED", "GENERATED"]),
		rightsExpiresAt: z.date().nullable(),
		consentExpiresAt: z.date().nullable(),
	})
	.strict();

export type ThumbnailAsset = z.infer<typeof thumbnailAssetSchema>;

export const thumbnailPlanSchema = z
	.object({
		concept: z.string().trim().min(1).max(700),
		// A thumbnail with no overlaid words is a normal thumbnail, so this is
		// allowed to be empty; the concept is what a reviewer reads.
		text: z.string().trim().max(120),
		assetIds: z.array(z.string().uuid()).min(1).max(8),
	})
	.strict();

export type ThumbnailPlan = z.infer<typeof thumbnailPlanSchema>;

/**
 * Every reason a planned thumbnail cannot go to a reviewer, checked in one place
 * so that a caller cannot pass four of five checks and proceed.
 *
 * An expiry that has not been recorded is not treated as an expiry that has
 * passed: a null means nobody stated a limit, which is a different fact from a
 * limit that ran out, and refusing on it would block every asset the product
 * has today.
 */
export function assertThumbnailAssetsUsable(input: {
	contentVersionId: string;
	plan: ThumbnailPlan;
	assets: readonly ThumbnailAsset[];
	now: Date;
}): void {
	const planned = input.plan.assetIds;
	if (new Set(planned).size !== planned.length) {
		throw new ContentCreationError("INVALID_INPUT", "A thumbnail names the same asset more than once");
	}

	const byId = new Map(input.assets.map((asset) => [asset.id, asset]));
	for (const id of planned) {
		const asset = byId.get(id);
		if (!asset) {
			throw new ContentCreationError("NOT_FOUND", `No asset ${id} is available to this brand`);
		}
		if (asset.contentVersionId !== input.contentVersionId) {
			throw new ContentCreationError(
				"ASSET_OUT_OF_VERSION",
				`Asset ${id} belongs to a different version than the one being reviewed`,
			);
		}
		if (asset.scanStatus !== "CLEAN") {
			throw new ContentCreationError("ASSET_NOT_CLEAN", `Asset ${id} has not been scanned clean`);
		}
		if (asset.rightsExpiresAt !== null && asset.rightsExpiresAt.getTime() <= input.now.getTime()) {
			throw new ContentCreationError("ASSET_RIGHTS_EXPIRED", `The rights recorded for asset ${id} have run out`);
		}
		if (asset.consentExpiresAt !== null && asset.consentExpiresAt.getTime() <= input.now.getTime()) {
			throw new ContentCreationError("ASSET_CONSENT_EXPIRED", `The consent recorded for asset ${id} has run out`);
		}
	}
}

/**
 * The digest the database computes for an approval bundle, computed here too so
 * a surface can tell a reviewer whether what they are looking at is still what
 * would be approved.
 *
 * It is not the authority. `selena_registry.editorial_asset_bundle_hash` is, and
 * the approval policy compares against that one — this exists so a stale screen
 * can be recognised as stale before anyone clicks, not so a second opinion can
 * be substituted for the first.
 */
export function thumbnailBundleMembers(assets: readonly ThumbnailAsset[]): string[] {
	return assets
		.filter((asset) => asset.scanStatus === "CLEAN")
		.map((asset) => asset.sha256)
		.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

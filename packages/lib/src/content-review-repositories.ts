import {
	assertApprovableAssetBundle,
	ContentReviewError,
	EDITORIAL_AUDIT_ACTIONS,
	type EditorialDecision,
	type ReviewableAsset,
	stageForDecision,
	validateEditorialDecision,
} from "@workspace/content-workflow/review";
import { and, desc, eq } from "drizzle-orm";
import {
	appendContentAudit,
	type ContentAuthContext,
	type ContentTransaction,
	withBrandRequestContext,
} from "./content-workflow-repositories";
import { selenaWebDb as db } from "./db/db";
import {
	scrBrandContentProfileVersions,
	scrContentAssets,
	scrContentItems,
	scrContentVersions,
	scrEditorialApprovals,
} from "./db/schema";
import { assetBundleHash, sha256 } from "./selena-control-room";

// Editorial review repository (Slice 4).
//
// Reads and writes the editorial_approvals stream and nothing else: no row
// here can satisfy the release path, which keeps its own approvals table
// bound to a channel account. The database already enforces append-only rows,
// the content-hash binding, owner-only APPROVED and the reason rule; this
// module adds the asset gate, latest-version rule and profile binding the
// database cannot see, and records every decision in the audit chain.

const AGGREGATE_TYPE = "content_review";

type AssetRow = typeof scrContentAssets.$inferSelect;
type VersionRow = typeof scrContentVersions.$inferSelect;

function assertWritable(context: ContentAuthContext): void {
	if (context.authType !== "session" || !["owner", "member"].includes(context.role)) {
		throw new ContentReviewError("FORBIDDEN", "Forbidden: owner or member access required");
	}
}

function isInteractiveOwner(context: ContentAuthContext): boolean {
	return context.authType === "session" && context.role === "owner";
}

function toReviewableAsset(row: AssetRow): ReviewableAsset {
	return {
		id: row.id,
		sha256: row.sha256,
		scanStatus: row.scanStatus as ReviewableAsset["scanStatus"],
		rightsExpiresAt: row.rightsExpiresAt ? row.rightsExpiresAt.toISOString() : null,
		consentExpiresAt: row.consentExpiresAt ? row.consentExpiresAt.toISOString() : null,
	};
}

async function loadVersionAssets(tx: ContentTransaction, brandId: string, contentVersionId: string) {
	return tx
		.select()
		.from(scrContentAssets)
		.where(and(eq(scrContentAssets.brandId, brandId), eq(scrContentAssets.contentVersionId, contentVersionId)))
		.orderBy(desc(scrContentAssets.createdAt));
}

async function loadLatestVersion(
	tx: ContentTransaction,
	brandId: string,
	contentId: string,
): Promise<VersionRow | null> {
	const rows = await tx
		.select()
		.from(scrContentVersions)
		.where(and(eq(scrContentVersions.brandId, brandId), eq(scrContentVersions.contentId, contentId)))
		.orderBy(desc(scrContentVersions.version))
		.limit(1);
	return rows[0] ?? null;
}

export function createContentReviewRepositories(database: typeof db = db) {
	/** Everything the review desk shows for one brand: YouTube drafts, their latest version, its assets and decision history. */
	async function getReview(context: ContentAuthContext, brandId: string) {
		return withBrandRequestContext(database, context, brandId, async (tx) => {
			const items = await tx
				.select()
				.from(scrContentItems)
				.where(and(eq(scrContentItems.brandId, brandId), eq(scrContentItems.contentKind, "YOUTUBE_VIDEO")))
				.orderBy(desc(scrContentItems.updatedAt));

			const views = [];
			for (const item of items) {
				const latest = await loadLatestVersion(tx, brandId, item.id);
				if (!latest) continue;
				const assets = await loadVersionAssets(tx, brandId, latest.id);
				const decisions = await tx
					.select()
					.from(scrEditorialApprovals)
					.where(and(eq(scrEditorialApprovals.brandId, brandId), eq(scrEditorialApprovals.contentVersionId, latest.id)))
					.orderBy(desc(scrEditorialApprovals.createdAt));
				views.push({
					id: item.id,
					title: item.title,
					workflowStage: item.workflowStage,
					latestVersion: {
						id: latest.id,
						version: latest.version,
						contentHash: latest.contentHash,
						formatVersion: latest.formatVersion,
						createdAt: latest.createdAt.toISOString(),
					},
					assets: assets.map((asset) => ({
						id: asset.id,
						originalFilename: asset.originalFilename,
						scanStatus: asset.scanStatus,
						sha256: asset.sha256,
						rightsExpiresAt: asset.rightsExpiresAt ? asset.rightsExpiresAt.toISOString() : null,
						consentExpiresAt: asset.consentExpiresAt ? asset.consentExpiresAt.toISOString() : null,
					})),
					decisions: decisions.map((decision) => ({
						id: decision.id,
						decision: decision.decision,
						reason: decision.reason,
						decidedBy: decision.decidedBy,
						createdAt: decision.createdAt.toISOString(),
					})),
				});
			}
			return { canDecide: isInteractiveOwner(context), canComment: true, items: views };
		});
	}

	/**
	 * Records one editorial decision about the latest version of a draft.
	 * APPROVED is interactive-owner-only (checked here and enforced again by the
	 * database policy), binds the exact content, profile, evidence and asset
	 * hashes it looked at, and grants no release authority.
	 */
	async function decideEditorial(
		context: ContentAuthContext,
		input: { brandId: string; contentVersionId: string; decision: EditorialDecision; reason?: string },
	) {
		assertWritable(context);
		validateEditorialDecision(input);
		if (input.decision === "APPROVED" && !isInteractiveOwner(context)) {
			throw new ContentReviewError("OWNER_DECISION_REQUIRED", "APPROVED requires an interactive owner session");
		}

		return withBrandRequestContext(
			database,
			context,
			input.brandId,
			async (tx) => {
				const versions = await tx
					.select()
					.from(scrContentVersions)
					.where(
						and(eq(scrContentVersions.brandId, input.brandId), eq(scrContentVersions.id, input.contentVersionId)),
					)
					.limit(1);
				const version = versions[0];
				if (!version) throw new ContentReviewError("NOT_FOUND", "Content version not found for this brand");

				const latest = await loadLatestVersion(tx, input.brandId, version.contentId);
				if (!latest || latest.id !== version.id) {
					throw new ContentReviewError("NOT_LATEST_VERSION", "Only the latest version can receive a decision");
				}

				if (!version.projectProfileVersionId) {
					throw new ContentReviewError("PROFILE_MISSING", "The version carries no project profile lineage");
				}
				const profiles = await tx
					.select()
					.from(scrBrandContentProfileVersions)
					.where(eq(scrBrandContentProfileVersions.id, version.projectProfileVersionId))
					.limit(1);
				const profile = profiles[0];
				if (!profile) throw new ContentReviewError("PROFILE_MISSING", "The bound profile version is not readable");

				const assetRows = await loadVersionAssets(tx, input.brandId, version.id);
				if (input.decision === "APPROVED") {
					assertApprovableAssetBundle(assetRows.map(toReviewableAsset));
				}
				const bundleHash = assetBundleHash(assetRows.map((asset) => ({ id: asset.id, sha256: asset.sha256 })));
				const evidenceHash = sha256(version.evidence ?? []);

				const inserted = await tx
					.insert(scrEditorialApprovals)
					.values({
						organizationId: context.tenantId,
						brandId: input.brandId,
						contentVersionId: version.id,
						decision: input.decision,
						contentHash: version.contentHash,
						profileHash: profile.profileHash,
						evidenceHash,
						assetBundleHash: bundleHash,
						reason: input.reason?.trim() || null,
						decidedBy: context.actorId,
					})
					.returning({ id: scrEditorialApprovals.id });

				const nextStage = stageForDecision(input.decision);
				await tx
					.update(scrContentItems)
					.set({ workflowStage: nextStage, updatedAt: new Date() })
					.where(and(eq(scrContentItems.brandId, input.brandId), eq(scrContentItems.id, version.contentId)));

				await appendContentAudit(
					tx,
					context,
					input.brandId,
					EDITORIAL_AUDIT_ACTIONS[input.decision],
					AGGREGATE_TYPE,
					version.id,
					{
						contentId: version.contentId,
						version: version.version,
						decision: input.decision,
						contentHash: version.contentHash,
						profileHash: profile.profileHash,
						evidenceHash,
						assetBundleHash: bundleHash,
					},
				);

				return {
					id: inserted[0]?.id ?? null,
					decision: input.decision,
					contentVersionId: version.id,
					workflowStage: nextStage,
					assetBundleHash: bundleHash,
				};
			},
			true,
		);
	}

	return { getReview, decideEditorial };
}

export const contentReviewRepositories = createContentReviewRepositories();

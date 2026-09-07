/**
 * Editorial review: what a reviewer is shown, and what a decision is bound to.
 *
 * An editorial decision says a person read this version and stands behind it. It
 * says nothing about publishing, and nothing here touches a release intent, an
 * outbox event or a channel account — Slice 4's containment requirement is met by
 * this module having no way to express any of them.
 *
 * The three derived hashes are asked of the database, never computed here.
 * `selena_registry.editorial_evidence_hash` and
 * `selena_registry.editorial_asset_bundle_hash` are what the insert policy
 * compares against, so a second implementation agreeing with them is not
 * evidence — only the same answer is. A surface renders what it was given, the
 * reviewer submits it back, and the policy refuses if the version moved in
 * between. That refusal is the staleness check; this module's job is to make it
 * legible rather than to pre-empt it.
 */

import {
	assertThumbnailAssetsUsable,
	ContentCreationError,
	type ThumbnailAsset,
	thumbnailBundleMembers,
} from "@workspace/content-workflow/creation";
import { and, desc, eq, sql } from "drizzle-orm";
import {
	appendContentAudit,
	type ContentAuthContext,
	type ContentTransaction,
	withBrandRequestContext,
} from "./content-workflow-repositories";
import { selenaWebDb as db } from "./db/db";
import {
	scrAuditEvents,
	scrBrandContentProfileVersions,
	scrContentAssets,
	scrContentItems,
	scrContentPolicies,
	scrContentVersions,
	scrEditorialApprovals,
} from "./db/schema";

const AGGREGATE_TYPE = "editorial_approval";

export const EDITORIAL_SUBMITTED_ACTION = "content.editorial_submitted";
export const EDITORIAL_APPROVED_ACTION = "content.editorial_approved";
export const EDITORIAL_REVOKED_ACTION = "content.editorial_approval_revoked";

export const REVIEW_ERROR_CODES = [
	"INVALID_INPUT",
	"NOT_FOUND",
	"NO_PROFILE_LINEAGE",
	"EVIDENCE_REQUIRED",
	// The hashes the reviewer submitted no longer describe the version. Either the
	// content, its evidence or its clean asset bundle changed after the screen was
	// drawn, or the decision was never one the policy admits.
	"STALE_DECISION",
	"NOT_APPROVED",
	"INTERNAL_ERROR",
] as const;

export type ReviewErrorCode = (typeof REVIEW_ERROR_CODES)[number];

export class ContentReviewError extends Error {
	readonly code: ReviewErrorCode;

	constructor(code: ReviewErrorCode, message: string) {
		super(message);
		this.name = "ContentReviewError";
		this.code = code;
	}
}

export type EditorialDecision = "APPROVED" | "CHANGES_REQUESTED" | "REJECTED" | "REVOKED";

/**
 * The four hashes a decision names. They arrive from the client because the
 * point is to compare what the reviewer was shown against what is stored now;
 * re-reading them here and submitting those would approve whatever the version
 * happens to be at the moment of the click.
 */
export type DecisionBinding = {
	contentHash: string;
	profileHash: string;
	evidenceHash: string;
	assetBundleHash: string;
};

export type ReviewAssetView = {
	id: string;
	sha256: string;
	mimeType: string;
	sizeBytes: number;
	scanStatus: "QUARANTINED" | "SCANNING" | "CLEAN" | "REJECTED";
	origin: "UPLOADED" | "GENERATED";
	rightsExpiresAt: string | null;
	consentExpiresAt: string | null;
	createdAt: string;
};

function assertWritable(context: ContentAuthContext): void {
	if (context.authType !== "session" || !["owner", "member"].includes(context.role)) {
		throw new Error("Forbidden: owner or member access required");
	}
}

/**
 * Approving and revoking are owner acts. The database says so too — the insert
 * policy calls `can_human_approve` — and this check exists so a member gets a
 * sentence rather than a policy violation, not so the database can stop
 * checking.
 */
function assertInteractiveOwner(context: ContentAuthContext): void {
	if (context.authType !== "session" || context.role !== "owner") {
		throw new Error("Forbidden: an interactive owner session is required");
	}
}

function toAssetView(row: typeof scrContentAssets.$inferSelect): ReviewAssetView {
	return {
		id: row.id,
		sha256: row.sha256,
		mimeType: row.mimeType,
		sizeBytes: row.sizeBytes,
		scanStatus: row.scanStatus,
		origin: row.origin,
		rightsExpiresAt: row.rightsExpiresAt?.toISOString() ?? null,
		consentExpiresAt: row.consentExpiresAt?.toISOString() ?? null,
		createdAt: row.createdAt.toISOString(),
	};
}

function toThumbnailAsset(row: typeof scrContentAssets.$inferSelect): ThumbnailAsset | null {
	// The pure contract is narrower than the row on purpose, and a row whose mime
	// type is outside the allowed set cannot be described by it. Such a row is
	// reported as unusable rather than forced through a schema that would reject
	// it with a parser's words.
	if (row.mimeType !== "image/jpeg" && row.mimeType !== "image/png" && row.mimeType !== "image/webp") return null;
	return {
		id: row.id,
		contentVersionId: row.contentVersionId,
		sha256: row.sha256,
		mimeType: row.mimeType,
		sizeBytes: row.sizeBytes,
		scanStatus: row.scanStatus,
		origin: row.origin,
		rightsExpiresAt: row.rightsExpiresAt,
		consentExpiresAt: row.consentExpiresAt,
	};
}

export function createContentReviewRepositories(database: typeof db = db) {
	async function readVersion(tx: ContentTransaction, context: ContentAuthContext, brandId: string, versionId: string) {
		const [version] = await tx
			.select()
			.from(scrContentVersions)
			.where(
				and(
					eq(scrContentVersions.id, versionId),
					eq(scrContentVersions.organizationId, context.tenantId),
					eq(scrContentVersions.brandId, brandId),
				),
			)
			.limit(1);
		if (!version) throw new ContentReviewError("NOT_FOUND", "That content version is not available to this brand");
		return version;
	}

	async function readAssets(tx: ContentTransaction, context: ContentAuthContext, brandId: string, versionId: string) {
		return tx
			.select()
			.from(scrContentAssets)
			.where(
				and(
					eq(scrContentAssets.contentVersionId, versionId),
					eq(scrContentAssets.organizationId, context.tenantId),
					eq(scrContentAssets.brandId, brandId),
				),
			)
			.orderBy(desc(scrContentAssets.createdAt));
	}

	/**
	 * Both derived hashes in one round trip, from the definer functions the insert
	 * policy uses. Read through the same transaction as everything else, so a
	 * caller cannot be shown a bundle assembled under a different request context.
	 */
	async function readDerivedHashes(
		tx: ContentTransaction,
		versionId: string,
	): Promise<{ evidenceHash: string; assetBundleHash: string }> {
		const result = await tx.execute(sql`
			SELECT selena_registry.editorial_evidence_hash(${versionId}::uuid) AS evidence_hash,
			       selena_registry.editorial_asset_bundle_hash(${versionId}::uuid) AS asset_bundle_hash
		`);
		const row = result.rows?.[0] as { evidence_hash?: unknown; asset_bundle_hash?: unknown } | undefined;
		if (typeof row?.evidence_hash !== "string" || typeof row?.asset_bundle_hash !== "string") {
			throw new ContentReviewError("INTERNAL_ERROR", "The database did not return the version's editorial hashes");
		}
		return { evidenceHash: row.evidence_hash, assetBundleHash: row.asset_bundle_hash };
	}

	async function readProfileHash(tx: ContentTransaction, profileVersionId: string | null): Promise<string | null> {
		if (!profileVersionId) return null;
		const [profile] = await tx
			.select({ profileHash: scrBrandContentProfileVersions.profileHash })
			.from(scrBrandContentProfileVersions)
			.where(eq(scrBrandContentProfileVersions.id, profileVersionId))
			.limit(1);
		return profile?.profileHash ?? null;
	}

	async function readRequireEvidence(
		tx: ContentTransaction,
		context: ContentAuthContext,
		brandId: string,
		policyVersion: string,
	): Promise<boolean> {
		const [policy] = await tx
			.select({ requireEvidence: scrContentPolicies.requireEvidence })
			.from(scrContentPolicies)
			.where(
				and(
					eq(scrContentPolicies.organizationId, context.tenantId),
					eq(scrContentPolicies.brandId, brandId),
					eq(scrContentPolicies.policyVersion, policyVersion),
				),
			)
			.limit(1);
		return policy?.requireEvidence === true;
	}

	async function readDecisions(
		tx: ContentTransaction,
		context: ContentAuthContext,
		brandId: string,
		versionId: string,
	) {
		return tx
			.select()
			.from(scrEditorialApprovals)
			.where(
				and(
					eq(scrEditorialApprovals.contentVersionId, versionId),
					eq(scrEditorialApprovals.organizationId, context.tenantId),
					eq(scrEditorialApprovals.brandId, brandId),
				),
			)
			.orderBy(desc(scrEditorialApprovals.decidedSeq));
	}

	/**
	 * Everything a reviewer or an author needs about one version, assembled once so
	 * the two surfaces cannot disagree about whether a version is ready.
	 */
	async function describeVersion(
		tx: ContentTransaction,
		context: ContentAuthContext,
		brandId: string,
		version: typeof scrContentVersions.$inferSelect,
		now: Date,
	) {
		const assetRows = await readAssets(tx, context, brandId, version.id);
		const derived = await readDerivedHashes(tx, version.id);
		const profileHash = await readProfileHash(tx, version.projectProfileVersionId);
		const requireEvidence = await readRequireEvidence(tx, context, brandId, version.policyVersion);
		const decisions = await readDecisions(tx, context, brandId, version.id);

		const evidenceClaimCount = Array.isArray(version.evidence) ? version.evidence.length : 0;
		const cleanAssets = assetRows.filter((row) => row.scanStatus === "CLEAN");

		// Readiness is reported, not thrown: this describes a version, and a version
		// that is not ready is a normal thing for the page to show.
		let assetBlocker: string | null = null;
		const thumbnailAssets = cleanAssets.map(toThumbnailAsset);
		if (thumbnailAssets.some((asset) => asset === null)) {
			assetBlocker = "ASSET_NOT_CLEAN";
		} else if (cleanAssets.length > 0) {
			const usable = thumbnailAssets.filter((asset): asset is ThumbnailAsset => asset !== null);
			try {
				assertThumbnailAssetsUsable({
					contentVersionId: version.id,
					plan: { concept: "editorial bundle", text: "", assetIds: usable.map((asset) => asset.id) },
					assets: usable,
					now,
				});
			} catch (error) {
				assetBlocker = error instanceof ContentCreationError ? error.code : "INTERNAL_ERROR";
			}
		}

		const standing = decisions.find((row) => row.decision === "APPROVED" || row.decision === "REVOKED") ?? null;
		const approvalStanding = standing?.decision === "APPROVED" ? standing : null;
		const binding: DecisionBinding = {
			contentHash: version.contentHash,
			profileHash: profileHash ?? "",
			evidenceHash: derived.evidenceHash,
			assetBundleHash: derived.assetBundleHash,
		};

		const blockers: string[] = [];
		if (!version.projectProfileVersionId || !profileHash) blockers.push("NO_PROFILE_LINEAGE");
		if (requireEvidence && evidenceClaimCount === 0) blockers.push("EVIDENCE_REQUIRED");
		if (assetBlocker) blockers.push(assetBlocker);

		const [submitted] = await tx
			.select({ createdAt: scrAuditEvents.createdAt })
			.from(scrAuditEvents)
			.where(
				and(
					eq(scrAuditEvents.organizationId, context.tenantId),
					eq(scrAuditEvents.brandId, brandId),
					eq(scrAuditEvents.aggregateId, version.id),
					eq(scrAuditEvents.action, EDITORIAL_SUBMITTED_ACTION),
				),
			)
			.orderBy(desc(scrAuditEvents.createdAt))
			.limit(1);

		return {
			contentId: version.contentId,
			versionId: version.id,
			version: version.version,
			formatVersion: version.formatVersion,
			createdAt: version.createdAt.toISOString(),
			profileVersionId: version.projectProfileVersionId,
			evidenceClaimCount,
			requireEvidence,
			binding,
			assets: assetRows.map(toAssetView),
			// The digests the client can compare against `binding.assetBundleHash`'s
			// inputs. Shown so a stale screen is recognisable before anyone clicks.
			bundleMembers: thumbnailBundleMembers(
				thumbnailAssets.filter((asset): asset is ThumbnailAsset => asset !== null),
			),
			blockers,
			submittedAt: submitted?.createdAt.toISOString() ?? null,
			decisions: decisions.map((row) => ({
				id: row.id,
				decision: row.decision as EditorialDecision,
				reason: row.reason,
				decidedBy: row.decidedBy,
				createdAt: row.createdAt.toISOString(),
				contentHash: row.contentHash,
				profileHash: row.profileHash,
				evidenceHash: row.evidenceHash,
				assetBundleHash: row.assetBundleHash,
			})),
			standingDecision: standing ? (standing.decision as EditorialDecision) : null,
			/**
			 * A standing approval whose bound hashes no longer match what the version
			 * derives now. The approval is not withdrawn by this — nothing withdraws an
			 * append-only row — it simply no longer describes the version, and the page
			 * has to say so rather than showing a green tick.
			 */
			approvalStale: approvalStanding
				? approvalStanding.contentHash !== binding.contentHash ||
					approvalStanding.profileHash !== binding.profileHash ||
					approvalStanding.evidenceHash !== binding.evidenceHash ||
					approvalStanding.assetBundleHash !== binding.assetBundleHash
				: false,
		};
	}

	function assertDecidable(described: Awaited<ReturnType<typeof describeVersion>>): void {
		if (described.blockers.includes("NO_PROFILE_LINEAGE")) {
			throw new ContentReviewError(
				"NO_PROFILE_LINEAGE",
				"This version does not name the profile it was written against, so a decision cannot be bound to one",
			);
		}
		if (described.blockers.includes("EVIDENCE_REQUIRED")) {
			throw new ContentReviewError(
				"EVIDENCE_REQUIRED",
				"The brand's content policy requires evidence and this version carries none",
			);
		}
		const assetBlocker = described.blockers.find((blocker) => blocker.startsWith("ASSET_"));
		if (assetBlocker) {
			throw new ContentCreationError(
				assetBlocker as "ASSET_NOT_CLEAN",
				"An asset on this version cannot go in front of a reviewer",
			);
		}
	}

	function assertBindingMatches(described: Awaited<ReturnType<typeof describeVersion>>, given: DecisionBinding): void {
		const current = described.binding;
		if (
			current.contentHash !== given.contentHash ||
			current.profileHash !== given.profileHash ||
			current.evidenceHash !== given.evidenceHash ||
			current.assetBundleHash !== given.assetBundleHash
		) {
			throw new ContentReviewError(
				"STALE_DECISION",
				"This version changed after the screen was drawn; reload it and read the current version before deciding",
			);
		}
	}

	async function recordDecision(
		tx: ContentTransaction,
		context: ContentAuthContext,
		brandId: string,
		input: { contentVersionId: string; decision: EditorialDecision; reason: string | null; binding: DecisionBinding },
	): Promise<string> {
		try {
			const [created] = await tx
				.insert(scrEditorialApprovals)
				.values({
					organizationId: context.tenantId,
					brandId,
					contentVersionId: input.contentVersionId,
					decision: input.decision,
					contentHash: input.binding.contentHash,
					profileHash: input.binding.profileHash,
					evidenceHash: input.binding.evidenceHash,
					assetBundleHash: input.binding.assetBundleHash,
					reason: input.reason,
					decidedBy: context.actorId,
				})
				.returning({ id: scrEditorialApprovals.id });
			if (!created) throw new ContentReviewError("INTERNAL_ERROR", "The decision could not be recorded");
			return created.id;
		} catch (error) {
			if (error instanceof ContentReviewError) throw error;
			// The insert policy is the authority on every binding this module also
			// checks in TypeScript. When it refuses, the reason is that one of those
			// bindings does not hold *now* — reporting it as an internal error would
			// hide the one outcome the slice exists to produce.
			const message = error instanceof Error ? error.message : "";
			if (/row-level security|violates row-level security policy/i.test(message)) {
				throw new ContentReviewError(
					"STALE_DECISION",
					"The database refused this decision: it no longer describes the version as stored",
				);
			}
			throw error;
		}
	}

	return {
		/**
		 * The Create-side view: every draft's latest version, its assets and whether
		 * they can go in front of a reviewer.
		 */
		async getThumbnails(context: ContentAuthContext, brandId: string) {
			return withBrandRequestContext(database, context, brandId, async (tx) => {
				const now = new Date();
				const items = await tx
					.select()
					.from(scrContentItems)
					.where(
						and(
							eq(scrContentItems.organizationId, context.tenantId),
							eq(scrContentItems.brandId, brandId),
							eq(scrContentItems.contentKind, "YOUTUBE_VIDEO"),
						),
					)
					.orderBy(desc(scrContentItems.createdAt));

				const drafts = [];
				for (const item of items) {
					const [latest] = await tx
						.select()
						.from(scrContentVersions)
						.where(
							and(
								eq(scrContentVersions.contentId, item.id),
								eq(scrContentVersions.organizationId, context.tenantId),
								eq(scrContentVersions.brandId, brandId),
							),
						)
						.orderBy(desc(scrContentVersions.version))
						.limit(1);
					if (!latest) continue;
					drafts.push({
						title: item.title,
						workflowStage: item.workflowStage,
						...(await describeVersion(tx, context, brandId, latest, now)),
					});
				}

				return {
					drafts,
					canAttach: context.authType === "session" && ["owner", "member"].includes(context.role),
				};
			});
		},

		/**
		 * The Govern-side view. `releases` is stated rather than queried: Stage 1
		 * publishes nothing, and a page that showed a release control would be
		 * offering something no code behind it can do.
		 */
		async getReview(context: ContentAuthContext, brandId: string) {
			return withBrandRequestContext(database, context, brandId, async (tx) => {
				const now = new Date();
				const items = await tx
					.select()
					.from(scrContentItems)
					.where(
						and(
							eq(scrContentItems.organizationId, context.tenantId),
							eq(scrContentItems.brandId, brandId),
							eq(scrContentItems.contentKind, "YOUTUBE_VIDEO"),
						),
					)
					.orderBy(desc(scrContentItems.createdAt));

				const versions = [];
				for (const item of items) {
					const [latest] = await tx
						.select()
						.from(scrContentVersions)
						.where(
							and(
								eq(scrContentVersions.contentId, item.id),
								eq(scrContentVersions.organizationId, context.tenantId),
								eq(scrContentVersions.brandId, brandId),
							),
						)
						.orderBy(desc(scrContentVersions.version))
						.limit(1);
					if (!latest) continue;
					versions.push({
						title: item.title,
						workflowStage: item.workflowStage,
						...(await describeVersion(tx, context, brandId, latest, now)),
					});
				}

				return {
					versions,
					canDecide: context.authType === "session" && context.role === "owner",
					releases: {
						readOnly: true,
						youTubeAvailable: false,
						reason: "Editorial approval is not publishing approval. Stage 1 creates no YouTube release of any kind.",
					},
				};
			});
		},

		/**
		 * Hands a version to a reviewer. It grants nothing and decides nothing; it
		 * refuses early for the reasons an approval would be refused for, so an
		 * author finds out before a reviewer does.
		 */
		async submitForReview(context: ContentAuthContext, input: { brandId: string; contentVersionId: string }) {
			assertWritable(context);
			return withBrandRequestContext(database, context, input.brandId, async (tx) => {
				const version = await readVersion(tx, context, input.brandId, input.contentVersionId);
				const described = await describeVersion(tx, context, input.brandId, version, new Date());
				assertDecidable(described);
				await appendContentAudit(
					tx,
					context,
					input.brandId,
					EDITORIAL_SUBMITTED_ACTION,
					AGGREGATE_TYPE,
					version.id,
					{
						contentId: version.contentId,
						version: version.version,
						contentHash: described.binding.contentHash,
						profileHash: described.binding.profileHash,
						evidenceHash: described.binding.evidenceHash,
						assetBundleHash: described.binding.assetBundleHash,
						status: "SUBMITTED",
					},
				);
				return { versionId: version.id, binding: described.binding, status: "SUBMITTED" as const };
			});
		},

		/**
		 * An owner's decision on one version. `APPROVED` and `REVOKED` are owner-only
		 * in the database too; `CHANGES_REQUESTED` and `REJECTED` are not, because a
		 * reviewer who can only say yes is not a reviewer.
		 */
		async decide(
			context: ContentAuthContext,
			input: {
				brandId: string;
				contentVersionId: string;
				decision: Exclude<EditorialDecision, "REVOKED">;
				reason: string | null;
				binding: DecisionBinding;
			},
		) {
			if (input.decision === "APPROVED") assertInteractiveOwner(context);
			else assertWritable(context);
			if (input.decision !== "APPROVED" && !input.reason?.trim()) {
				throw new ContentReviewError("INVALID_INPUT", "A decision other than approval has to say why");
			}

			return withBrandRequestContext(
				database,
				context,
				input.brandId,
				async (tx) => {
					const version = await readVersion(tx, context, input.brandId, input.contentVersionId);
					const described = await describeVersion(tx, context, input.brandId, version, new Date());
					assertBindingMatches(described, input.binding);
					if (input.decision === "APPROVED") assertDecidable(described);

					const id = await recordDecision(tx, context, input.brandId, {
						contentVersionId: version.id,
						decision: input.decision,
						reason: input.reason?.trim() || null,
						binding: input.binding,
					});

					if (input.decision === "APPROVED") {
						await appendContentAudit(
							tx,
							context,
							input.brandId,
							EDITORIAL_APPROVED_ACTION,
							AGGREGATE_TYPE,
							id,
							{
								contentVersionId: version.id,
								contentId: version.contentId,
								version: version.version,
								contentHash: input.binding.contentHash,
								profileHash: input.binding.profileHash,
								evidenceHash: input.binding.evidenceHash,
								assetBundleHash: input.binding.assetBundleHash,
								status: "APPROVED",
							},
						);
					}
					return { id, decision: input.decision, versionId: version.id };
				},
				// Two decisions racing on one version can both read the same standing
				// row. The lock makes the order the rows are written the order they were
				// decided in, which is what `decided_seq` then records.
				true,
			);
		},

		/**
		 * Takes an approval back. A new row, never an edit: the table admits no
		 * UPDATE and no DELETE, and the history of what was once approved is the
		 * point of keeping it.
		 */
		async revokeApproval(
			context: ContentAuthContext,
			input: { brandId: string; contentVersionId: string; reason: string },
		) {
			assertInteractiveOwner(context);
			if (!input.reason.trim()) {
				throw new ContentReviewError("INVALID_INPUT", "Taking an approval back has to say why");
			}

			return withBrandRequestContext(
				database,
				context,
				input.brandId,
				async (tx) => {
					const version = await readVersion(tx, context, input.brandId, input.contentVersionId);
					const described = await describeVersion(tx, context, input.brandId, version, new Date());
					if (described.standingDecision !== "APPROVED") {
						throw new ContentReviewError("NOT_APPROVED", "This version has no standing approval to take back");
					}
					// Revocation binds the hashes of the approval being withdrawn, which
					// the policy requires to match a standing APPROVED row. Reading them
					// from the decision rather than from the caller means an owner can
					// withdraw an approval that has already gone stale — which is exactly
					// when withdrawing it matters most.
					const standing = described.decisions.find((decision) => decision.decision === "APPROVED");
					if (!standing) throw new ContentReviewError("NOT_APPROVED", "This version has no standing approval to take back");
					const binding: DecisionBinding = {
						contentHash: standing.contentHash,
						profileHash: standing.profileHash,
						evidenceHash: standing.evidenceHash,
						assetBundleHash: standing.assetBundleHash,
					};

					const id = await recordDecision(tx, context, input.brandId, {
						contentVersionId: version.id,
						decision: "REVOKED",
						reason: input.reason.trim(),
						binding,
					});

					await appendContentAudit(tx, context, input.brandId, EDITORIAL_REVOKED_ACTION, AGGREGATE_TYPE, id, {
						contentVersionId: version.id,
						contentId: version.contentId,
						version: version.version,
						contentHash: binding.contentHash,
						profileHash: binding.profileHash,
						evidenceHash: binding.evidenceHash,
						assetBundleHash: binding.assetBundleHash,
						revokedApprovalId: standing.id,
						status: "REVOKED",
					});
					return { id, decision: "REVOKED" as const, versionId: version.id };
				},
				true,
			);
		},
	};
}

export const contentReviewRepositories = createContentReviewRepositories();

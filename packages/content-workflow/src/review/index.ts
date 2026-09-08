import { z } from "zod";

// Editorial review domain rules (Slice 4).
//
// An editorial decision is a human judgment about one immutable content
// version. It binds the exact hashes it looked at and grants no release
// authority: the release path keeps its own approvals table, bound to a
// channel account, and nothing here can reach it. The database enforces the
// hard rules (append-only rows, owner-only APPROVED, content-hash binding,
// reason required for non-approval); this module states the application
// rules the database cannot see — the asset gate and the stage transition.

export const editorialDecisionSchema = z.enum(["APPROVED", "CHANGES_REQUESTED", "REJECTED"]);
export type EditorialDecision = z.infer<typeof editorialDecisionSchema>;

export type ContentReviewErrorCode =
	| "REASON_REQUIRED"
	| "ASSET_NOT_CLEAN"
	| "ASSET_RIGHTS_EXPIRED"
	| "ASSET_CONSENT_EXPIRED"
	| "NOT_LATEST_VERSION"
	| "PROFILE_MISSING"
	| "OWNER_DECISION_REQUIRED"
	| "NOT_FOUND"
	| "FORBIDDEN";

export class ContentReviewError extends Error {
	readonly code: ContentReviewErrorCode;

	constructor(code: ContentReviewErrorCode, message: string) {
		super(message);
		this.name = "ContentReviewError";
		this.code = code;
	}
}

export const editorialDecisionInputSchema = z.object({
	contentVersionId: z.string().uuid(),
	decision: editorialDecisionSchema,
	reason: z.string().trim().min(1).max(2000).optional(),
});
export type EditorialDecisionInput = z.infer<typeof editorialDecisionInputSchema>;

/** A non-approval must say why; the reason lands in an append-only record. */
export function validateEditorialDecision(input: Pick<EditorialDecisionInput, "decision" | "reason">): void {
	if (input.decision !== "APPROVED" && !input.reason?.trim()) {
		throw new ContentReviewError("REASON_REQUIRED", "CHANGES_REQUESTED and REJECTED require a reason");
	}
}

export type ReviewableAsset = {
	id: string;
	sha256: string;
	scanStatus: "QUARANTINED" | "SCANNING" | "CLEAN" | "REJECTED";
	rightsExpiresAt: string | null;
	consentExpiresAt: string | null;
};

/**
 * APPROVED may bind an asset bundle only when every asset is CLEAN and its
 * rights and consent are present and unexpired. An empty bundle is legal —
 * a script can be approved before its thumbnail exists — but a dirty or
 * expired asset can never ride along silently.
 */
export function assertApprovableAssetBundle(assets: ReadonlyArray<ReviewableAsset>, now: Date = new Date()): void {
	for (const asset of assets) {
		if (asset.scanStatus !== "CLEAN") {
			throw new ContentReviewError("ASSET_NOT_CLEAN", `Asset ${asset.id} is ${asset.scanStatus}, not CLEAN`);
		}
		if (!asset.rightsExpiresAt || new Date(asset.rightsExpiresAt) <= now) {
			throw new ContentReviewError("ASSET_RIGHTS_EXPIRED", `Asset ${asset.id} has no unexpired rights`);
		}
		if (!asset.consentExpiresAt || new Date(asset.consentExpiresAt) <= now) {
			throw new ContentReviewError("ASSET_CONSENT_EXPIRED", `Asset ${asset.id} has no unexpired consent`);
		}
	}
}

export type ContentWorkflowStage = "DRAFT" | "IDEA_SELECTED" | "SCRIPT_DRAFTED" | "IN_REVIEW" | "APPROVED" | "ARCHIVED";

/** APPROVED advances the item; CHANGES_REQUESTED sends it back to work; REJECTED archives it. */
export function stageForDecision(decision: EditorialDecision): ContentWorkflowStage {
	switch (decision) {
		case "APPROVED":
			return "APPROVED";
		case "CHANGES_REQUESTED":
			return "SCRIPT_DRAFTED";
		case "REJECTED":
			return "ARCHIVED";
	}
}

export const EDITORIAL_AUDIT_ACTIONS: Record<EditorialDecision, string> = {
	APPROVED: "content.editorial_approved",
	CHANGES_REQUESTED: "content.editorial_changes_requested",
	REJECTED: "content.editorial_rejected",
};

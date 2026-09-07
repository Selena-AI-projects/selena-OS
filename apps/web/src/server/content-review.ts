import { createServerFn } from "@tanstack/react-start";
import { contentReviewRepositories } from "@workspace/lib/content-review-repositories";
import { z } from "zod";
import { isContentOsStage1Enabled } from "@/lib/content-os-stage1.server";
import { resolveSessionAuthContext } from "@/lib/selena-auth-context.server";

/**
 * Submit, approve, request changes, reject and revoke.
 *
 * Every decision carries the four hashes the reviewer's screen was drawn from.
 * They are inputs rather than something this module reads for itself: a decision
 * re-derived at the moment of the click would approve whatever the version had
 * become, which is the one thing the slice must not allow.
 */

const brandInput = z.object({ brandId: z.string().trim().min(1).max(120) });

const bindingInput = z.object({
	contentHash: z.string().regex(/^[a-f0-9]{64}$/),
	profileHash: z.string().regex(/^[a-f0-9]{64}$/),
	evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
	assetBundleHash: z.string().regex(/^[a-f0-9]{64}$/),
});

const submitInput = brandInput.extend({ contentVersionId: z.string().uuid() });

const decideInput = brandInput.extend({
	contentVersionId: z.string().uuid(),
	decision: z.enum(["APPROVED", "CHANGES_REQUESTED", "REJECTED"]),
	reason: z.string().trim().max(2000).nullable(),
	binding: bindingInput,
});

const revokeInput = brandInput.extend({
	contentVersionId: z.string().uuid(),
	reason: z.string().trim().min(1).max(2000),
});

function assertStage1Enabled(): void {
	if (!isContentOsStage1Enabled()) throw new Error("Content OS Stage 1 is disabled");
}

export const getContentReviewFn = createServerFn({ method: "GET" })
	.validator(brandInput)
	.handler(async ({ data }) => {
		assertStage1Enabled();
		const context = await resolveSessionAuthContext();
		return contentReviewRepositories.getReview(context, data.brandId);
	});

export const submitContentForReviewFn = createServerFn({ method: "POST" })
	.validator(submitInput)
	.handler(async ({ data }) => {
		assertStage1Enabled();
		const context = await resolveSessionAuthContext();
		return contentReviewRepositories.submitForReview(context, {
			brandId: data.brandId,
			contentVersionId: data.contentVersionId,
		});
	});

export const decideContentReviewFn = createServerFn({ method: "POST" })
	.validator(decideInput)
	.handler(async ({ data }) => {
		assertStage1Enabled();
		const context = await resolveSessionAuthContext();
		return contentReviewRepositories.decide(context, {
			brandId: data.brandId,
			contentVersionId: data.contentVersionId,
			decision: data.decision,
			reason: data.reason,
			binding: data.binding,
		});
	});

export const revokeContentApprovalFn = createServerFn({ method: "POST" })
	.validator(revokeInput)
	.handler(async ({ data }) => {
		assertStage1Enabled();
		const context = await resolveSessionAuthContext();
		return contentReviewRepositories.revokeApproval(context, {
			brandId: data.brandId,
			contentVersionId: data.contentVersionId,
			// A revocation binds the standing approval's own hashes, which the
			// repository reads from that row. Accepting them from the caller would let
			// one name a different approval than the one being withdrawn.
			reason: data.reason,
		});
	});

import { createServerFn } from "@tanstack/react-start";
import { contentReviewRepositories } from "@workspace/lib/content-review-repositories";
import { z } from "zod";
import { isContentOsStage1Enabled } from "@/lib/content-os-stage1.server";
import { resolveSessionAuthContext } from "@/lib/selena-auth-context.server";

// Editorial review server functions (Slice 4). Thin, like every Content OS
// handler: assert the flag, resolve the session, delegate to the repository.
// No provider is called anywhere on this path and nothing here can create a
// release intent — the release path keeps its own approval table and gates.

const brandInput = z.object({ brandId: z.string().trim().min(1).max(120) });

const decisionInput = z.object({
	brandId: z.string().trim().min(1).max(120),
	contentVersionId: z.string().uuid(),
	decision: z.enum(["APPROVED", "CHANGES_REQUESTED", "REJECTED"]),
	reason: z.string().trim().min(1).max(2000).optional(),
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

export const decideEditorialFn = createServerFn({ method: "POST" })
	.validator(decisionInput)
	.handler(async ({ data }) => {
		assertStage1Enabled();
		const context = await resolveSessionAuthContext();
		return contentReviewRepositories.decideEditorial(context, data);
	});

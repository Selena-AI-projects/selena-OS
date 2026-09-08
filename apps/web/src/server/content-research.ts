import { createServerFn } from "@tanstack/react-start";
import { contentResearchRepositories } from "@workspace/lib/content-research-repositories";
import { z } from "zod";
import { isContentOsStage1Enabled } from "@/lib/content-os-stage1.server";
import { resolveSessionAuthContext } from "@/lib/selena-auth-context.server";

const brandInput = z.object({ brandId: z.string().trim().min(1).max(120) });
const runInput = brandInput.extend({
	idempotencyKey: z.string().trim().min(1).max(200),
	// The client may only state an intent; the server maps it to the adapter.
	// A live run still has to pass every fuse — env gates, credential, the
	// owner-set durable budget — or it fails with that fuse's own code.
	live: z.boolean().optional(),
});
const decisionInput = brandInput.extend({
	opportunityId: z.string().uuid(),
	decision: z.enum(["SAVED", "REJECTED", "SENT_TO_CREATION"]),
	reason: z.string().trim().max(1000).optional(),
});

function assertStage1Enabled(): void {
	if (!isContentOsStage1Enabled()) throw new Error("Content OS Stage 1 is disabled");
}

export const getContentResearchFn = createServerFn({ method: "GET" })
	.validator(brandInput)
	.handler(async ({ data }) => {
		assertStage1Enabled();
		const context = await resolveSessionAuthContext();
		const state = await contentResearchRepositories.getResearch(context, data.brandId);
		return { ...state, canDecide: context.authType === "session" && ["owner", "member"].includes(context.role) };
	});

export const runContentResearchFn = createServerFn({ method: "POST" })
	.validator(runInput)
	.handler(async ({ data }) => {
		assertStage1Enabled();
		const context = await resolveSessionAuthContext();
		return contentResearchRepositories.runResearch(context, {
			brandId: data.brandId,
			idempotencyKey: data.idempotencyKey,
			adapterId: data.live ? "video-radar" : undefined,
		});
	});

export const decideContentOpportunityFn = createServerFn({ method: "POST" })
	.validator(decisionInput)
	.handler(async ({ data }) => {
		assertStage1Enabled();
		const context = await resolveSessionAuthContext();
		return contentResearchRepositories.decideOpportunity(context, {
			organizationId: context.tenantId,
			brandId: data.brandId,
			opportunityId: data.opportunityId,
			decision: data.decision,
			reason: data.reason,
		});
	});

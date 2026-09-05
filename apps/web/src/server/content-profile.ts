import { createServerFn } from "@tanstack/react-start";
import { projectProfileInputSchema } from "@workspace/content-workflow/profile";
import { contentWorkflowRepositories } from "@workspace/lib/content-workflow-repositories";
import { z } from "zod";
import { isContentOsStage1Enabled } from "@/lib/content-os-stage1.server";
import { resolveSessionAuthContext } from "@/lib/selena-auth-context.server";

const brandInput = z.object({ brandId: z.string().trim().min(1).max(120) });
const profileVersionInput = brandInput.extend({ profile: projectProfileInputSchema });
const decisionInput = brandInput.extend({
	profileVersionId: z.string().uuid(),
	decision: z.enum(["CONFIRMED", "REVOKED"]),
	reason: z.string().trim().max(1000).optional(),
});

function assertStage1Enabled(): void {
	if (!isContentOsStage1Enabled()) throw new Error("Content OS Stage 1 is disabled");
}

export const getContentProfileFn = createServerFn({ method: "GET" })
	.validator(brandInput)
	.handler(async ({ data }) => {
		assertStage1Enabled();
		const context = await resolveSessionAuthContext();
		const [current, versions] = await Promise.all([
			contentWorkflowRepositories.profiles.getCurrent(context, data.brandId),
			contentWorkflowRepositories.profiles.listVersions(context, data.brandId),
		]);
		return { current, versions, canDecide: context.authType === "session" && context.role === "owner" };
	});

export const createContentProfileVersionFn = createServerFn({ method: "POST" })
	.validator(profileVersionInput)
	.handler(async ({ data }) => {
		assertStage1Enabled();
		const context = await resolveSessionAuthContext();
		return contentWorkflowRepositories.profiles.createVersion(context, {
			organizationId: context.tenantId,
			brandId: data.brandId,
			profile: data.profile,
		});
	});

export const decideContentProfileFn = createServerFn({ method: "POST" })
	.validator(decisionInput)
	.handler(async ({ data }) => {
		assertStage1Enabled();
		const context = await resolveSessionAuthContext();
		return contentWorkflowRepositories.profiles.decide(context, {
			organizationId: context.tenantId,
			brandId: data.brandId,
			profileVersionId: data.profileVersionId,
			decision: data.decision,
			reason: data.reason,
		});
	});

export const ensureDraftYouTubeChannelFn = createServerFn({ method: "POST" })
	.validator(brandInput)
	.handler(async ({ data }) => {
		assertStage1Enabled();
		const channel = await contentWorkflowRepositories.channels.ensureDraftYouTube(
			await resolveSessionAuthContext(),
			data.brandId,
		);
		return {
			...channel,
			createdAt: channel.createdAt.toISOString(),
		};
	});

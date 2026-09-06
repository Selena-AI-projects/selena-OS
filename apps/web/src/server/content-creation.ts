import { createServerFn } from "@tanstack/react-start";
import { contentCreationRepositories } from "@workspace/lib/content-creation-repositories";
import { z } from "zod";
import { isContentOsStage1Enabled } from "@/lib/content-os-stage1.server";
import { resolveSessionAuthContext } from "@/lib/selena-auth-context.server";

const brandInput = z.object({ brandId: z.string().trim().min(1).max(120) });
const ideasInput = brandInput.extend({
	opportunityId: z.string().uuid(),
	idempotencyKey: z.string().trim().min(1).max(200),
});
const selectInput = brandInput.extend({
	generationRunId: z.string().uuid(),
	ideaIndex: z.number().int().min(0).max(5),
});
const scriptInput = brandInput.extend({
	contentId: z.string().uuid(),
	idempotencyKey: z.string().trim().min(1).max(200),
	revision: z.boolean().optional(),
});

function assertStage1Enabled(): void {
	if (!isContentOsStage1Enabled()) throw new Error("Content OS Stage 1 is disabled");
}

export const getContentCreationFn = createServerFn({ method: "GET" })
	.validator(brandInput)
	.handler(async ({ data }) => {
		assertStage1Enabled();
		const context = await resolveSessionAuthContext();
		return contentCreationRepositories.getCreation(context, data.brandId);
	});

export const generateContentIdeasFn = createServerFn({ method: "POST" })
	.validator(ideasInput)
	.handler(async ({ data }) => {
		assertStage1Enabled();
		const context = await resolveSessionAuthContext();
		// The adapter is not a client input. A request cannot select the live
		// provider, which is why it is absent from every schema above.
		return contentCreationRepositories.generateIdeas(context, {
			brandId: data.brandId,
			opportunityId: data.opportunityId,
			idempotencyKey: data.idempotencyKey,
		});
	});

export const selectContentIdeaFn = createServerFn({ method: "POST" })
	.validator(selectInput)
	.handler(async ({ data }) => {
		assertStage1Enabled();
		const context = await resolveSessionAuthContext();
		return contentCreationRepositories.selectIdea(context, {
			brandId: data.brandId,
			generationRunId: data.generationRunId,
			ideaIndex: data.ideaIndex,
		});
	});

export const generateContentScriptFn = createServerFn({ method: "POST" })
	.validator(scriptInput)
	.handler(async ({ data }) => {
		assertStage1Enabled();
		const context = await resolveSessionAuthContext();
		return contentCreationRepositories.generateScript(context, {
			brandId: data.brandId,
			contentId: data.contentId,
			idempotencyKey: data.idempotencyKey,
			revision: data.revision,
		});
	});

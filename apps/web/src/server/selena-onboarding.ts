import { createServerFn } from "@tanstack/react-start";
import { db } from "@workspace/lib/db/db";
import { assertSuggestSpendAllowed } from "@workspace/lib/run-policy";
import { createSelenaRepositories } from "@workspace/lib/selena-visibility-repositories";
import { z } from "zod";
import { cancelAnalyzeBrand, enqueueAnalyzeBrand, getAnalyzeBrandStatus } from "@/lib/analyze-brand-job";
import { questionLanguagePrefix, SUGGESTION_LIMITS } from "@/lib/selena-suggestion";
import { resolveSessionAuthContext } from "../lib/selena-auth-context";

const repositories = createSelenaRepositories(db);
const profileSchema = z.object({
	projectId: z.string().uuid(),
	brandName: z.string().trim().min(1).max(160),
	primaryDomain: z.string().trim().min(3).max(255),
	publicProfiles: z.array(z.object({ platform: z.string().min(1), url: z.string().url() })).max(20),
	competitorSnapshot: z.array(z.object({ name: z.string().min(1), domains: z.array(z.string()).default([]) })).max(50),
	scenarioSnapshot: z
		.array(z.object({ text: z.string().min(1), language: z.string().min(2), intentType: z.string().min(1) }))
		.max(100),
});

export const confirmSelenaProfileFn = createServerFn({ method: "POST" })
	.validator(profileSchema)
	.handler(async ({ data }) => {
		const context = await resolveSessionAuthContext();
		const profile = await repositories.profiles.confirm(context, {
			projectId: data.projectId,
			brandName: data.brandName,
			primaryDomain: data.primaryDomain,
			publicProfiles: data.publicProfiles,
			competitorSnapshot: data.competitorSnapshot,
			scenarioSnapshot: data.scenarioSnapshot,
		});
		return {
			id: profile.id,
			projectId: profile.projectId,
			brandName: profile.brandName,
			primaryDomain: profile.primaryDomain,
			publicProfiles: data.publicProfiles,
			competitorSnapshot: data.competitorSnapshot,
			scenarioSnapshot: data.scenarioSnapshot,
			confirmedAt: profile.confirmedAt,
		};
	});

/**
 * Suggest competitors and customer questions from the project's own website.
 *
 * Owners rarely know who they compete with *inside an AI answer* — it is
 * routinely a place they have never considered a rival. The research call
 * reads the public site and proposes both lists as a starting hypothesis; the
 * customer still edits and confirms them, and a paid measurement is what
 * replaces the hypothesis with observed fact.
 *
 * Runs as a background job: this is an LLM + web-search round trip that takes
 * about a minute, which a reverse proxy would cut off mid-request.
 */
const suggestionScopeSchema = z.object({ projectId: z.string().uuid() });

async function requireProject(projectId: string) {
	const context = await resolveSessionAuthContext();
	const project = await repositories.projects.get(context, projectId);
	if (!project) throw new Error("Project not found");
	return project;
}

export const startSelenaProfileSuggestionFn = createServerFn({ method: "POST" })
	.validator(suggestionScopeSchema.extend({ website: z.string().trim().min(3).max(255) }))
	.handler(async ({ data }) => {
		// The button is free to the customer and not to us: it starts a paid
		// LLM round trip on a live key. Refused unless the owner has named the
		// budget class that pays for it.
		assertSuggestSpendAllowed();
		const project = await requireProject(data.projectId);
		await enqueueAnalyzeBrand({
			product: "selena",
			requestKey: data.projectId,
			website: data.website,
			brandName: project.name,
			maxCompetitors: SUGGESTION_LIMITS.competitors,
			maxPrompts: SUGGESTION_LIMITS.questions,
		});
		return { ok: true };
	});

export type SelenaProfileSuggestion =
	| { status: "pending" }
	| { status: "done"; competitors: string; questions: string }
	| { status: "failed"; error: string };

/** POST so no cache can pin an early `pending` and starve the poll. */
export const getSelenaProfileSuggestionFn = createServerFn({ method: "POST" })
	.validator(suggestionScopeSchema)
	.handler(async ({ data }): Promise<SelenaProfileSuggestion> => {
		const project = await requireProject(data.projectId);
		const status = await getAnalyzeBrandStatus("selena", data.projectId);
		if (status.status !== "done") return status;
		return {
			status: "done",
			competitors: status.suggestion.competitors.map((item) => item.name).join(", "),
			questions: status.suggestion.suggestedPrompts
				.map((item) => `${questionLanguagePrefix(item.prompt, project.languages[0])}: ${item.prompt}`)
				.join("\n"),
		};
	});

export const cancelSelenaProfileSuggestionFn = createServerFn({ method: "POST" })
	.validator(suggestionScopeSchema)
	.handler(async ({ data }) => {
		await requireProject(data.projectId);
		await cancelAnalyzeBrand("selena", data.projectId);
		return { ok: true };
	});

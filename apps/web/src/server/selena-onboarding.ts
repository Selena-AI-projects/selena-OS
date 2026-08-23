import { createServerFn } from "@tanstack/react-start";
import { db } from "@workspace/lib/db/db";
import { assertSuggestSpendAllowed } from "@workspace/lib/run-policy";
import { createSelenaRepositories } from "@workspace/lib/selena-visibility-repositories";
import { z } from "zod";
import { cancelAnalyzeBrand, enqueueAnalyzeBrand, getAnalyzeBrandStatus } from "@/lib/analyze-brand-job";
import { type GoogleMapsLocationSnapshot, parseGoogleMapsLocation } from "@workspace/lib/google-maps-location";
import { questionLanguagePrefix, SUGGESTION_LIMITS } from "@/lib/selena-suggestion";
import { resolveSessionAuthContext } from "../lib/selena-auth-context";

const repositories = createSelenaRepositories(db);
const profileSchema = z.object({
	projectId: z.string().uuid(),
	brandName: z.string().trim().min(1).max(160),
	primaryDomain: z.string().trim().min(3).max(255),
	publicProfiles: z.array(z.object({ platform: z.string().min(1), url: z.string().url() })).max(20),
	mapsLocationUrl: z.string().trim().max(2048).default(""),
	competitorSnapshot: z.array(z.object({ name: z.string().min(1), domains: z.array(z.string()).default([]) })).max(50),
	scenarioSnapshot: z
		.array(z.object({ text: z.string().min(1), language: z.string().min(2), intentType: z.string().min(1) }))
		.max(100),
});

export const confirmSelenaProfileFn = createServerFn({ method: "POST" })
	.validator(profileSchema)
	.handler(async ({ data }) => {
		const context = await resolveSessionAuthContext();
		// The snapshot is re-derived server-side from the raw link so a client
		// cannot store arbitrary coordinates or another business's CID.
		const mapsLocation = data.mapsLocationUrl ? parseGoogleMapsLocation(data.mapsLocationUrl) : null;
		if (mapsLocation && !mapsLocation.isValid) throw new Error(`Google Maps location: ${mapsLocation.error}`);
		const profile = await repositories.profiles.confirm(context, {
			projectId: data.projectId,
			brandName: data.brandName,
			primaryDomain: data.primaryDomain,
			publicProfiles: data.publicProfiles,
			mapsLocation: mapsLocation ? mapsLocation.location : null,
			competitorSnapshot: data.competitorSnapshot,
			scenarioSnapshot: data.scenarioSnapshot,
		});
		return {
			id: profile.id,
			projectId: profile.projectId,
			brandName: profile.brandName,
			primaryDomain: profile.primaryDomain,
			publicProfiles: data.publicProfiles,
			mapsLocation: mapsLocation ? mapsLocation.location : null,
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

function countryName(code: string): string {
	try {
		return new Intl.DisplayNames(["en"], { type: "region" }).of(code.toUpperCase()) ?? code;
	} catch {
		return code;
	}
}

/**
 * Free-text place context for the research prompt. The listing name comes
 * from the customer's Google Maps link; the area comes from the project,
 * because a share link often carries no readable fields at all.
 */
function buildLocationHint(
	location: GoogleMapsLocationSnapshot,
	project: { region: string | null; country: string },
): string {
	const parts = [location.placeName, project.region, countryName(project.country)].filter(
		(part): part is string => typeof part === "string" && part.trim() !== "",
	);
	const coordinates =
		location.latitude !== null && location.longitude !== null
			? ` (coordinates ${location.latitude}, ${location.longitude})`
			: "";
	return `${parts.join(", ")}${coordinates}`.trim();
}

export const startSelenaProfileSuggestionFn = createServerFn({ method: "POST" })
	.validator(
		suggestionScopeSchema.extend({
			website: z.string().trim().min(3).max(255),
			mapsLocationUrl: z.string().trim().max(2048).default(""),
		}),
	)
	.handler(async ({ data }) => {
		// The button is free to the customer and not to us: it starts a paid
		// LLM round trip on a live key. Refused unless the owner has named the
		// budget class that pays for it.
		assertSuggestSpendAllowed();
		const project = await requireProject(data.projectId);
		let locationHint: string | undefined;
		if (data.mapsLocationUrl) {
			const maps = parseGoogleMapsLocation(data.mapsLocationUrl);
			if (!maps.isValid) throw new Error(`Google Maps location: ${maps.error}`);
			locationHint = buildLocationHint(maps.location, project) || undefined;
		}
		await enqueueAnalyzeBrand({
			product: "selena",
			requestKey: data.projectId,
			website: data.website,
			brandName: project.name,
			locationHint,
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

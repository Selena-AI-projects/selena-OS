import { createServerFn } from "@tanstack/react-start";
import { db } from "@workspace/lib/db/db";
import { createSelenaRepositories } from "@workspace/lib/selena-visibility-repositories";
import { z } from "zod";
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

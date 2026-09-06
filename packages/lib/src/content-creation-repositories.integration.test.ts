import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { createContentCreationRepositories, creationProviderCallCount } from "./content-creation-repositories";
import { createContentResearchRepositories } from "./content-research-repositories";
import { createContentWorkflowRepositories } from "./content-workflow-repositories";
import { contentVersionHash } from "./selena-control-room";

const disposableDatabaseUrl = process.env.SELENA_DISPOSABLE_DATABASE_URL;

const profileInput = {
	languages: ["en"],
	audience: {
		primary: "independent studio owners",
		secondary: ["studio managers"],
		needs: ["booking workflow", "client retention"],
	},
	voice: { traits: ["direct"], examples: [], exclusions: ["guaranteed revenue"] },
	ctaRules: [],
	visualRules: { palette: [], imagery: [], avoid: ["stock robots"] },
	claimRules: { requireSources: true, allowedStates: ["VERIFIED" as const] },
	facts: [
		{
			id: "retention",
			statement: "Client retention improves when reminders are automated",
			state: "VERIFIED" as const,
			sourceRefs: ["https://brand.example.test/retention"],
		},
	],
	sourceRefs: [{ uri: "https://brand.example.test/retention", title: "Retention" }],
};

describe.skipIf(!disposableDatabaseUrl)("content creation PostgreSQL adapter", () => {
	it("keeps creation evidence-bearing, brand-scoped, immutable and provider-free", async () => {
		if (!disposableDatabaseUrl) throw new Error("disposable database URL is required");
		const suffix = randomUUID();
		const organizationId = `creation-org-${suffix}`;
		const brandId = `creation-brand-${suffix}`;
		const siblingBrandId = `creation-sibling-${suffix}`;
		const ownerId = `creation-owner-${suffix}`;
		const memberId = `creation-member-${suffix}`;

		const root = new Client({ connectionString: disposableDatabaseUrl });
		await root.connect();
		await root.query(
			`INSERT INTO public."user" (id, name, email, created_at, updated_at)
			 VALUES ($1, 'Creation Owner', $2, now(), now()), ($3, 'Creation Member', $4, now(), now())`,
			[ownerId, `${ownerId}@example.test`, memberId, `${memberId}@example.test`],
		);
		await root.query(`INSERT INTO public.organization (id, name, slug, created_at) VALUES ($1, $2, $3, now())`, [
			organizationId,
			"Creation Test Organization",
			organizationId,
		]);
		await root.query(
			`INSERT INTO public.member (id, organization_id, user_id, role, created_at)
			 VALUES ($1, $2, $3, 'owner', now()), ($4, $2, $5, 'member', now())`,
			[`owner-membership-${suffix}`, organizationId, ownerId, `member-membership-${suffix}`, memberId],
		);
		await root.query(
			`INSERT INTO public.brands (id, name, website, organization_id)
			 VALUES ($1, 'Creation Test Brand', 'https://brand.example.test', $3),
			        ($2, 'Creation Sibling Brand', 'https://sibling.example.test', $3)`,
			[brandId, siblingBrandId, organizationId],
		);
		// Stage 1 publishes nothing, so the channel is draft-only by construction.
		await root.query(
			`INSERT INTO selena_registry.content_channels (organization_id, brand_id, platform, created_by)
			 VALUES ($1, $2, 'youtube', $3), ($1, $4, 'youtube', $3)`,
			[organizationId, brandId, ownerId, siblingBrandId],
		);

		const profiles = createContentWorkflowRepositories();
		const research = createContentResearchRepositories();
		const creation = createContentCreationRepositories();
		const owner = { actorId: ownerId, tenantId: organizationId, role: "owner" as const, authType: "session" as const };
		const member = {
			actorId: memberId,
			tenantId: organizationId,
			role: "member" as const,
			authType: "session" as const,
		};

		const version = await profiles.profiles.createVersion(member, { organizationId, brandId, profile: profileInput });
		await profiles.profiles.decide(owner, {
			organizationId,
			brandId,
			profileVersionId: version.id,
			decision: "CONFIRMED",
		});
		await research.runResearch(member, { brandId, idempotencyKey: `run-${suffix}` });
		const researchState = await research.getResearch(owner, brandId);
		const opportunityId = researchState.opportunities[0].id;

		// Creation starts from a decision, not from a suggestion.
		await expect(
			creation.generateIdeas(member, { brandId, opportunityId, idempotencyKey: `ideas-early-${suffix}` }),
		).rejects.toMatchObject({ code: "OPPORTUNITY_NOT_SAVED" });

		await research.decideOpportunity(member, { organizationId, brandId, opportunityId, decision: "SAVED" });

		const ideas = await creation.generateIdeas(member, {
			brandId,
			opportunityId,
			idempotencyKey: `ideas-${suffix}`,
		});
		expect(ideas.status).toBe("COMPLETED");
		expect(ideas.reused).toBe(false);

		// A repeated delivery resumes the same run rather than generating again.
		const repeated = await creation.generateIdeas(member, {
			brandId,
			opportunityId,
			idempotencyKey: `ideas-${suffix}`,
		});
		expect(repeated.reused).toBe(true);
		expect(repeated.id).toBe(ideas.id);

		const state = await creation.getCreation(owner, brandId);
		expect(state.ideas).toHaveLength(6);
		// Every idea carries evidence bound to the run it came from.
		for (const idea of state.ideas) {
			expect(idea.evidenceClaims.length).toBeGreaterThan(0);
			for (const claim of idea.evidenceClaims) {
				expect(claim.researchRunId).toBe(researchState.run?.id);
			}
		}

		const selected = await creation.selectIdea(member, {
			brandId,
			generationRunId: ideas.id,
			ideaIndex: 0,
		});
		expect(selected.version).toBe(1);

		// The five unselected ideas stay in the run's output, so the choice remains
		// reviewable rather than being quietly discarded.
		const afterSelection = await creation.getCreation(owner, brandId);
		expect(afterSelection.ideas).toHaveLength(6);
		expect(afterSelection.items).toHaveLength(1);
		expect(afterSelection.items[0].contentKind).toBe("YOUTUBE_VIDEO");
		expect(afterSelection.items[0].workflowStage).toBe("IDEA_SELECTED");

		const scripted = await creation.generateScript(member, {
			brandId,
			contentId: selected.contentId,
			idempotencyKey: `script-${suffix}`,
		});
		expect(scripted.version).toBe(2);
		expect(scripted.contentHash).not.toBe(selected.contentHash);

		const afterScript = await creation.getCreation(owner, brandId);
		const versions = afterScript.versionsByItem[selected.contentId];
		expect(versions).toHaveLength(2);
		// History is added to, never rewritten: version 1 is byte-identical.
		const firstVersion = versions.find((entry) => entry.version === 1);
		expect(firstVersion?.contentHash).toBe(selected.contentHash);
		for (const entry of versions) {
			expect(entry.formatVersion).toBe("content.youtube-video/v1");
			expect(entry.hashVersion).toBe("content.workflow/v2");
			expect(entry.structuredBody?.schema).toBe("content.youtube-video/v1");
			// A structured version is never hashed the way a legacy one is.
			expect(entry.contentHash).not.toBe(
				contentVersionHash({
					body: "",
					ctaUrl: "",
					claims: [],
					evidence: [],
					disclosure: {},
					policyVersion: "brand-pack/v1",
				}),
			);
		}
		const scriptVersion = versions.find((entry) => entry.version === 2);
		expect(scriptVersion?.structuredBody?.script?.sections.length).toBeGreaterThan(1);
		expect(afterScript.items[0].workflowStage).toBe("SCRIPT_DRAFTED");

		// The Gemini adapter is disabled and has no transport, so asking for it is
		// recorded as a refusal rather than becoming a call.
		const refused = await creation.generateIdeas(member, {
			brandId,
			opportunityId,
			idempotencyKey: `gemini-${suffix}`,
			adapterId: "gemini",
		});
		expect(refused.status).toBe("FAILED");
		expect(refused.errorCode).toBe("ADAPTER_DISABLED");
		expect(creationProviderCallCount()).toBe(0);

		// A sibling brand's content is neither readable nor reachable.
		const siblingVersion = await profiles.profiles.createVersion(member, {
			organizationId,
			brandId: siblingBrandId,
			profile: profileInput,
		});
		await profiles.profiles.decide(owner, {
			organizationId,
			brandId: siblingBrandId,
			profileVersionId: siblingVersion.id,
			decision: "CONFIRMED",
		});
		const siblingState = await creation.getCreation(owner, siblingBrandId);
		expect(siblingState.items).toHaveLength(0);
		expect(siblingState.ideas).toHaveLength(0);
		await expect(
			creation.selectIdea(member, { brandId: siblingBrandId, generationRunId: ideas.id, ideaIndex: 0 }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			creation.generateScript(member, {
				brandId: siblingBrandId,
				contentId: selected.contentId,
				idempotencyKey: `sibling-script-${suffix}`,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		// All four Slice 3 events are present, and their metadata carries only ids,
		// hashes, versions, status and normalized codes.
		const events = await root.query<{ action: string; metadata: Record<string, unknown> }>(
			`SELECT action, metadata FROM selena_audit.audit_events WHERE brand_id = $1 ORDER BY created_at`,
			[brandId],
		);
		const actions = new Set(events.rows.map((row) => row.action));
		for (const action of [
			"content.generation_started",
			"content.generation_completed",
			"content.generation_failed",
			"content.version_created",
		]) {
			expect(actions).toContain(action);
		}
		const allowedKeys = new Set([
			"kind",
			"adapterId",
			"profileVersionId",
			"profileHash",
			"researchRunId",
			"researchOpportunityId",
			"correlationId",
			"status",
			"externalProviderCalls",
			"errorCode",
			"contentId",
			"version",
			"formatVersion",
			"hashVersion",
			"contentHash",
			"generationRunId",
			"opportunityId",
			"runId",
			"decision",
			"sourcesScored",
			"shortlisted",
			"opportunitiesProduced",
			"errorCodes",
			"profileVersion",
			"reason",
		]);
		for (const row of events.rows) {
			for (const key of Object.keys(row.metadata ?? {})) expect(allowedKeys).toContain(key);
		}

		// Nothing in this slice can publish.
		const sideEffects = await root.query<{ intents: string; manifests: string; outbox: string; accounts: string }>(
			`SELECT
			   (SELECT count(*) FROM selena_release.release_intents WHERE brand_id = $1) AS intents,
			   (SELECT count(*) FROM selena_release.release_manifests WHERE brand_id = $1) AS manifests,
			   (SELECT count(*) FROM selena_release.outbox_events WHERE brand_id = $1) AS outbox,
			   (SELECT count(*) FROM selena_registry.channel_accounts WHERE brand_id = $1) AS accounts`,
			[brandId],
		);
		expect(sideEffects.rows[0]).toEqual({ intents: "0", manifests: "0", outbox: "0", accounts: "0" });

		// A run that made no call must not claim a budget it never asked for.
		const runs = await root.query<{ requested: number; actual: number; provider: string }>(
			`SELECT requested_call_count AS requested, actual_call_count AS actual, provider
			   FROM selena_registry.generation_runs WHERE brand_id = $1`,
			[brandId],
		);
		for (const run of runs.rows) {
			expect(run.provider).toBe("none");
			expect(run.actual).toBe(0);
			expect(run.requested).toBe(0);
		}

		await root.end();
	});
});

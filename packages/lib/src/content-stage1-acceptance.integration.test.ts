import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { createContentCreationRepositories, creationProviderCallCount } from "./content-creation-repositories";
import { createContentResearchRepositories, researchProviderCallCount } from "./content-research-repositories";
import { createContentReviewRepositories } from "./content-review-repositories";
import { createContentWorkflowRepositories } from "./content-workflow-repositories";

// Stage 1 acceptance: the complete fixture vertical for one disposable brand.
//
// This is the named Slice 5 run, not another adapter test: the adapter suites
// already prove the failure paths, gates and idempotency one at a time. Here
// the whole path a real owner would walk runs once, cleanly, and the outcome
// is recorded as a machine-readable acceptance summary — written to
// SELENA_STAGE1_ACCEPTANCE_REPORT when set, so CI can publish it as evidence.
//
// Evidence class: disposable database only. A green run here says nothing
// about staging, production, or the browser surface.

const disposableDatabaseUrl = process.env.SELENA_DISPOSABLE_DATABASE_URL;

const profileInput = {
	languages: ["en", "ru"],
	audience: {
		primary: "guests planning a food hall visit",
		secondary: ["local families"],
		needs: ["menu overview", "opening hours"],
	},
	voice: {
		traits: ["тёплый и честный", "clear and concise, not salesy"],
		examples: [],
		exclusions: ["guaranteed outcomes"],
	},
	ctaRules: ["Invite the viewer to the website"],
	visualRules: { palette: ["terracotta"], imagery: ["real venue footage"], avoid: ["stock robots"] },
	claimRules: { requireSources: true, allowedStates: ["VERIFIED" as const] },
	facts: [
		{
			id: "location",
			statement: "The venue operates in Bali",
			state: "VERIFIED" as const,
			sourceRefs: ["https://acceptance.example.test/about"],
		},
		{
			id: "capacity-claim",
			statement: "Seats one thousand guests",
			state: "PROHIBITED" as const,
			sourceRefs: [],
		},
	],
	sourceRefs: [{ uri: "https://acceptance.example.test/about", title: "About" }],
};

describe.skipIf(!disposableDatabaseUrl)("Content OS Stage 1 acceptance", () => {
	it("walks the full fixture vertical for one brand with zero external provider calls", async () => {
		if (!disposableDatabaseUrl) throw new Error("disposable database URL is required");
		const suffix = randomUUID();
		const organizationId = `acceptance-org-${suffix}`;
		const brandId = `acceptance-brand-${suffix}`;
		const siblingBrandId = `acceptance-sibling-${suffix}`;
		const ownerId = `acceptance-owner-${suffix}`;
		const memberId = `acceptance-member-${suffix}`;

		const root = new Client({ connectionString: disposableDatabaseUrl });
		await root.connect();
		await root.query(
			`INSERT INTO public."user" (id, name, email, created_at, updated_at)
			 VALUES ($1, 'Acceptance Owner', $2, now(), now()), ($3, 'Acceptance Member', $4, now(), now())`,
			[ownerId, `${ownerId}@example.test`, memberId, `${memberId}@example.test`],
		);
		await root.query(`INSERT INTO public.organization (id, name, slug, created_at) VALUES ($1, $2, $3, now())`, [
			organizationId,
			"Stage 1 Acceptance Organization",
			organizationId,
		]);
		await root.query(
			`INSERT INTO public.member (id, organization_id, user_id, role, created_at)
			 VALUES ($1, $2, $3, 'owner', now()), ($4, $2, $5, 'member', now())`,
			[`owner-membership-${suffix}`, organizationId, ownerId, `member-membership-${suffix}`, memberId],
		);
		await root.query(
			`INSERT INTO public.brands (id, name, website, organization_id)
			 VALUES ($1, 'Acceptance Test Brand', 'https://acceptance.example.test', $3),
			        ($2, 'Acceptance Sibling Brand', 'https://sibling.example.test', $3)`,
			[brandId, siblingBrandId, organizationId],
		);
		await root.query(
			`INSERT INTO selena_registry.content_channels (organization_id, brand_id, platform, created_by)
			 VALUES ($1, $2, 'youtube', $3)`,
			[organizationId, brandId, ownerId],
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

		// 1. A member drafts the profile; only the interactive owner confirms it.
		const version = await profiles.profiles.createVersion(member, { organizationId, brandId, profile: profileInput });
		await expect(
			profiles.profiles.decide(member, { organizationId, brandId, profileVersionId: version.id, decision: "CONFIRMED" }),
		).rejects.toThrow(/interactive owner session is required/);
		await profiles.profiles.decide(owner, {
			organizationId,
			brandId,
			profileVersionId: version.id,
			decision: "CONFIRMED",
		});

		// 2. Fixture research runs against the confirmed profile.
		await research.runResearch(member, { brandId, idempotencyKey: `acceptance-run-${suffix}` });
		const researchState = await research.getResearch(owner, brandId);
		expect(researchState.run?.status).toBe("COMPLETED");
		expect(researchState.opportunities.length).toBeGreaterThan(0);
		const opportunityId = researchState.opportunities[0].id;

		// 3. The owner saves one opportunity; exactly six ideas come back.
		await research.decideOpportunity(owner, { organizationId, brandId, opportunityId, decision: "SAVED" });
		const ideas = await creation.generateIdeas(member, {
			brandId,
			opportunityId,
			idempotencyKey: `acceptance-ideas-${suffix}`,
		});
		expect(ideas.status).toBe("COMPLETED");
		const withIdeas = await creation.getCreation(owner, brandId);
		expect(withIdeas.ideas).toHaveLength(6);

		// 4. Selecting an idea creates the draft; a script and one revision follow.
		const selected = await creation.selectIdea(member, { brandId, generationRunId: ideas.id, ideaIndex: 0 });
		const scripted = await creation.generateScript(member, {
			brandId,
			contentId: selected.contentId,
			idempotencyKey: `acceptance-script-${suffix}`,
		});
		if (scripted.status !== "COMPLETED") throw new Error(`script generation failed: ${scripted.errorCode}`);
		const revised = await creation.generateScript(member, {
			brandId,
			contentId: selected.contentId,
			idempotencyKey: `acceptance-revision-${suffix}`,
			revision: true,
		});
		if (revised.status !== "COMPLETED") throw new Error(`revision failed: ${revised.errorCode}`);

		const finalState = await creation.getCreation(owner, brandId);
		const versions = finalState.versionsByItem[selected.contentId];
		expect(versions).toHaveLength(3);
		expect(finalState.items[0].workflowStage).toBe("SCRIPT_DRAFTED");

		// 4b. Editorial review (Slice 4): a member sends it back with a reason,
		// the interactive owner approves the latest version; the empty asset
		// bundle is legal and no release authority comes into existence.
		const review = createContentReviewRepositories();
		const latestVersionId = versions.reduce((a, b) => (b.version > a.version ? b : a)).id;
		const changesRequested = await review.decideEditorial(member, {
			brandId,
			contentVersionId: latestVersionId,
			decision: "CHANGES_REQUESTED",
			reason: "Acceptance pass: tighten the hook",
		});
		expect(changesRequested.workflowStage).toBe("SCRIPT_DRAFTED");
		const editorialApproved = await review.decideEditorial(owner, {
			brandId,
			contentVersionId: latestVersionId,
			decision: "APPROVED",
		});
		expect(editorialApproved.workflowStage).toBe("APPROVED");
		const editorialState = await review.getReview(owner, brandId);
		expect(editorialState.items[0].decisions).toHaveLength(2);
		// The prohibited fact stayed out of every generated claim context.
		for (const entry of versions) {
			const claimIds = entry.structuredBody?.evidenceClaimIds ?? [];
			expect(claimIds).not.toContain("capacity-claim");
		}

		// 5. Cross-brand denial: the sibling brand sees none of it.
		const siblingState = await creation.getCreation(owner, siblingBrandId);
		expect(siblingState.items).toHaveLength(0);
		await expect(
			creation.generateScript(member, {
				brandId: siblingBrandId,
				contentId: selected.contentId,
				idempotencyKey: `acceptance-sibling-${suffix}`,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		// 6. Zero external provider calls, recorded three independent ways.
		expect(researchProviderCallCount()).toBe(0);
		expect(creationProviderCallCount()).toBe(0);
		const researchCalls = await root.query<{ calls: number }>(
			`SELECT coalesce(sum(external_provider_calls), 0)::int AS calls
			   FROM selena_registry.content_research_runs WHERE brand_id = $1`,
			[brandId],
		);
		expect(researchCalls.rows[0].calls).toBe(0);
		const generationCalls = await root.query<{ requested: number; actual: number }>(
			`SELECT coalesce(sum(requested_call_count), 0)::int AS requested,
			        coalesce(sum(actual_call_count), 0)::int AS actual
			   FROM selena_registry.generation_runs WHERE brand_id = $1`,
			[brandId],
		);
		expect(generationCalls.rows[0]).toEqual({ requested: 0, actual: 0 });

		// 7. Nothing publishable came into existence.
		const sideEffects = await root.query<{ intents: string; manifests: string; outbox: string; accounts: string }>(
			`SELECT
			   (SELECT count(*) FROM selena_release.release_intents WHERE brand_id = $1) AS intents,
			   (SELECT count(*) FROM selena_release.release_manifests WHERE brand_id = $1) AS manifests,
			   (SELECT count(*) FROM selena_release.outbox_events WHERE brand_id = $1) AS outbox,
			   (SELECT count(*) FROM selena_registry.channel_accounts WHERE brand_id = $1) AS accounts`,
			[brandId],
		);
		expect(sideEffects.rows[0]).toEqual({ intents: "0", manifests: "0", outbox: "0", accounts: "0" });

		// 8. The acceptance summary is the evidence artifact.
		const summary = {
			acceptance: "content-os-stage1",
			evidenceClass: "disposable-database",
			completedAt: new Date().toISOString(),
			profileVersion: version.version,
			researchRunStatus: researchState.run?.status ?? "MISSING",
			opportunities: researchState.opportunities.length,
			ideas: withIdeas.ideas.length,
			contentVersions: versions.length,
			editorialDecisions: editorialState.items[0].decisions.length,
			workflowStage: editorialState.items[0].workflowStage,
			externalProviderCalls: {
				researchLedger: researchProviderCallCount(),
				creationLedger: creationProviderCallCount(),
				researchRuns: researchCalls.rows[0].calls,
				generationRunsRequested: generationCalls.rows[0].requested,
				generationRunsActual: generationCalls.rows[0].actual,
			},
			releaseSideEffects: sideEffects.rows[0],
		};
		const reportPath = process.env.SELENA_STAGE1_ACCEPTANCE_REPORT;
		if (reportPath) writeFileSync(reportPath, `${JSON.stringify(summary, null, 2)}\n`);
		console.log(`stage1-acceptance ${JSON.stringify(summary)}`);

		await root.end();
	});
});

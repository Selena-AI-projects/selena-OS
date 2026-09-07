import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { createContentCreationRepositories } from "./content-creation-repositories";
import { createContentResearchRepositories } from "./content-research-repositories";
import { createContentReviewRepositories } from "./content-review-repositories";
import { createContentWorkflowRepositories } from "./content-workflow-repositories";
import { assetBundleHash } from "./selena-control-room";

const disposableDatabaseUrl = process.env.SELENA_DISPOSABLE_DATABASE_URL;

const profileInput = {
	languages: ["en"],
	audience: { primary: "food hall guests", secondary: [], needs: ["menus"] },
	voice: { traits: ["warm and honest"], examples: [], exclusions: ["guaranteed outcomes"] },
	ctaRules: [],
	visualRules: { palette: [], imagery: [], avoid: [] },
	claimRules: { requireSources: true, allowedStates: ["VERIFIED" as const] },
	facts: [
		{
			id: "location",
			statement: "The venue operates in Bali",
			state: "VERIFIED" as const,
			sourceRefs: ["https://review.example.test/about"],
		},
	],
	sourceRefs: [{ uri: "https://review.example.test/about", title: "About" }],
};

describe.skipIf(!disposableDatabaseUrl)("content editorial review PostgreSQL adapter", () => {
	it("records human decisions on the latest version and grants no release authority", async () => {
		if (!disposableDatabaseUrl) throw new Error("disposable database URL is required");
		const suffix = randomUUID();
		const organizationId = `review-org-${suffix}`;
		const brandId = `review-brand-${suffix}`;
		const siblingBrandId = `review-sibling-${suffix}`;
		const ownerId = `review-owner-${suffix}`;
		const memberId = `review-member-${suffix}`;

		const root = new Client({ connectionString: disposableDatabaseUrl });
		await root.connect();
		await root.query(
			`INSERT INTO public."user" (id, name, email, created_at, updated_at)
			 VALUES ($1, 'Review Owner', $2, now(), now()), ($3, 'Review Member', $4, now(), now())`,
			[ownerId, `${ownerId}@example.test`, memberId, `${memberId}@example.test`],
		);
		await root.query(`INSERT INTO public.organization (id, name, slug, created_at) VALUES ($1, $2, $3, now())`, [
			organizationId,
			"Review Test Organization",
			organizationId,
		]);
		await root.query(
			`INSERT INTO public.member (id, organization_id, user_id, role, created_at)
			 VALUES ($1, $2, $3, 'owner', now()), ($4, $2, $5, 'member', now())`,
			[`owner-membership-${suffix}`, organizationId, ownerId, `member-membership-${suffix}`, memberId],
		);
		await root.query(
			`INSERT INTO public.brands (id, name, website, organization_id)
			 VALUES ($1, 'Review Test Brand', 'https://review.example.test', $3),
			        ($2, 'Review Sibling Brand', 'https://sibling.example.test', $3)`,
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
		const review = createContentReviewRepositories();
		const owner = { actorId: ownerId, tenantId: organizationId, role: "owner" as const, authType: "session" as const };
		const member = {
			actorId: memberId,
			tenantId: organizationId,
			role: "member" as const,
			authType: "session" as const,
		};

		// Reach SCRIPT_DRAFTED through the real vertical.
		const version = await profiles.profiles.createVersion(member, { organizationId, brandId, profile: profileInput });
		await profiles.profiles.decide(owner, {
			organizationId,
			brandId,
			profileVersionId: version.id,
			decision: "CONFIRMED",
		});
		await research.runResearch(member, { brandId, idempotencyKey: `review-run-${suffix}` });
		const researchState = await research.getResearch(owner, brandId);
		const opportunityId = researchState.opportunities[0].id;
		await research.decideOpportunity(owner, { organizationId, brandId, opportunityId, decision: "SAVED" });
		const ideas = await creation.generateIdeas(member, {
			brandId,
			opportunityId,
			idempotencyKey: `review-ideas-${suffix}`,
		});
		const selected = await creation.selectIdea(member, { brandId, generationRunId: ideas.id, ideaIndex: 0 });
		const scripted = await creation.generateScript(member, {
			brandId,
			contentId: selected.contentId,
			idempotencyKey: `review-script-${suffix}`,
		});
		if (scripted.status !== "COMPLETED") throw new Error(`script generation failed: ${scripted.errorCode}`);

		const before = await review.getReview(owner, brandId);
		expect(before.items).toHaveLength(1);
		const latestVersionId = before.items[0].latestVersion.id;

		// A non-approval without a reason is refused before it reaches the database.
		await expect(
			review.decideEditorial(member, { brandId, contentVersionId: latestVersionId, decision: "CHANGES_REQUESTED" }),
		).rejects.toMatchObject({ code: "REASON_REQUIRED" });

		// A member cannot approve, and the refusal names the actual rule.
		await expect(
			review.decideEditorial(member, { brandId, contentVersionId: latestVersionId, decision: "APPROVED" }),
		).rejects.toMatchObject({ code: "OWNER_DECISION_REQUIRED" });

		// A member can send it back to work with a reason.
		const changes = await review.decideEditorial(member, {
			brandId,
			contentVersionId: latestVersionId,
			decision: "CHANGES_REQUESTED",
			reason: "Tighten the hook",
		});
		expect(changes.workflowStage).toBe("SCRIPT_DRAFTED");

		// The owner approves the latest version; the empty asset bundle is legal.
		const approved = await review.decideEditorial(owner, {
			brandId,
			contentVersionId: latestVersionId,
			decision: "APPROVED",
		});
		expect(approved.workflowStage).toBe("APPROVED");
		expect(approved.assetBundleHash).toBe(assetBundleHash([]));

		const after = await review.getReview(owner, brandId);
		expect(after.items[0].workflowStage).toBe("APPROVED");
		expect(after.items[0].decisions.map((entry) => entry.decision)).toEqual(["APPROVED", "CHANGES_REQUESTED"]);

		// A revision makes the approved version non-latest; deciding on it is refused.
		const revised = await creation.generateScript(member, {
			brandId,
			contentId: selected.contentId,
			idempotencyKey: `review-revision-${suffix}`,
			revision: true,
		});
		if (revised.status !== "COMPLETED") throw new Error(`revision failed: ${revised.errorCode}`);
		await expect(
			review.decideEditorial(owner, { brandId, contentVersionId: latestVersionId, decision: "APPROVED" }),
		).rejects.toMatchObject({ code: "NOT_LATEST_VERSION" });

		// The sibling brand can neither read nor decide.
		const siblingView = await review.getReview(owner, siblingBrandId);
		expect(siblingView.items).toHaveLength(0);
		await expect(
			review.decideEditorial(owner, {
				brandId: siblingBrandId,
				contentVersionId: latestVersionId,
				decision: "REJECTED",
				reason: "wrong brand",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		// Editorial approval created no release authority of any kind.
		const sideEffects = await root.query<{
			intents: string;
			manifests: string;
			outbox: string;
			accounts: string;
			releaseApprovals: string;
		}>(
			`SELECT
			   (SELECT count(*) FROM selena_release.release_intents WHERE brand_id = $1) AS intents,
			   (SELECT count(*) FROM selena_release.release_manifests WHERE brand_id = $1) AS manifests,
			   (SELECT count(*) FROM selena_release.outbox_events WHERE brand_id = $1) AS outbox,
			   (SELECT count(*) FROM selena_registry.channel_accounts WHERE brand_id = $1) AS accounts,
			   (SELECT count(*) FROM selena_registry.approvals WHERE brand_id = $1) AS "releaseApprovals"`,
			[brandId],
		);
		expect(sideEffects.rows[0]).toEqual({
			intents: "0",
			manifests: "0",
			outbox: "0",
			accounts: "0",
			releaseApprovals: "0",
		});

		// Both editorial audit actions are present with hash-only metadata.
		const events = await root.query<{ action: string }>(
			`SELECT action FROM selena_audit.audit_events WHERE brand_id = $1 AND action LIKE 'content.editorial%' ORDER BY created_at`,
			[brandId],
		);
		expect(events.rows.map((row) => row.action)).toEqual([
			"content.editorial_changes_requested",
			"content.editorial_approved",
		]);

		await root.end();
	});
});

import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { createContentCreationRepositories } from "./content-creation-repositories";
import { createContentResearchRepositories } from "./content-research-repositories";
import { createContentReviewRepositories } from "./content-review-repositories";
import { createContentWorkflowRepositories } from "./content-workflow-repositories";

const disposableDatabaseUrl = process.env.SELENA_DISPOSABLE_DATABASE_URL;

const profileInput = {
	languages: ["en"],
	audience: {
		primary: "independent studio owners",
		secondary: ["studio managers"],
		needs: ["booking workflow"],
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

function digest(seed: string): string {
	return seed.padEnd(64, "0").slice(0, 64).replace(/[^a-f0-9]/g, "a");
}

describe.skipIf(!disposableDatabaseUrl)("editorial review PostgreSQL adapter", () => {
	it("binds a decision to what the reviewer was shown and grants no publishing authority", async () => {
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
			 VALUES ($1, 'Review Test Brand', 'https://brand.example.test', $3),
			        ($2, 'Review Sibling Brand', 'https://sibling.example.test', $3)`,
			[brandId, siblingBrandId, organizationId],
		);
		await root.query(
			`INSERT INTO selena_registry.content_channels (organization_id, brand_id, platform, created_by)
			 VALUES ($1, $2, 'youtube', $3), ($1, $4, 'youtube', $3)`,
			[organizationId, brandId, ownerId, siblingBrandId],
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

		const profileVersion = await profiles.profiles.createVersion(member, {
			organizationId,
			brandId,
			profile: profileInput,
		});
		await profiles.profiles.decide(owner, {
			organizationId,
			brandId,
			profileVersionId: profileVersion.id,
			decision: "CONFIRMED",
		});
		await research.runResearch(member, { brandId, idempotencyKey: `review-run-${suffix}` });
		const researchState = await research.getResearch(owner, brandId);
		const opportunityId = researchState.opportunities[0].id;
		await research.decideOpportunity(member, { organizationId, brandId, opportunityId, decision: "SAVED" });
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
		const versionId = scripted.versionId;

		/** The scanner owns this insert; the web runtime has no policy that allows it. */
		async function writeAsset(input: {
			assetBrandId: string;
			versionId: string;
			sha256: string;
			scanStatus: "QUARANTINED" | "SCANNING" | "CLEAN" | "REJECTED";
			origin?: "UPLOADED" | "GENERATED";
			rightsExpiresAt?: string | null;
			consentExpiresAt?: string | null;
		}): Promise<string> {
			const result = await root.query<{ id: string }>(
				`INSERT INTO selena_registry.content_assets (
					organization_id, brand_id, content_version_id, storage_bucket, storage_key,
					original_filename, sha256, mime_type, detected_mime_type, size_bytes,
					scan_status, origin, rights_expires_at, consent_expires_at, created_by
				) VALUES ($1, $2, $3, 'selena-quarantine', $4, 'thumb.png', $5, 'image/png', 'image/png', 4096,
					$6, $7, $8, $9, $10)
				RETURNING id`,
				[
					organizationId,
					input.assetBrandId,
					input.versionId,
					`originals/${randomUUID()}.png`,
					input.sha256,
					input.scanStatus,
					input.origin ?? "UPLOADED",
					input.rightsExpiresAt ?? new Date(Date.now() + 86_400_000).toISOString(),
					input.consentExpiresAt ?? new Date(Date.now() + 86_400_000).toISOString(),
					ownerId,
				],
			);
			const id = result.rows[0]?.id;
			if (!id) throw new Error("asset insert returned no id");
			return id;
		}

		// ── a version with no image at all is still reviewable ────────────────────
		// The empty bundle hashes the empty string rather than to nothing, which is
		// what makes the WITH CHECK comparison answerable at all.
		const beforeAssets = await review.getReview(owner, brandId);
		const emptyBundle = beforeAssets.versions[0];
		expect(emptyBundle?.versionId).toBe(versionId);
		expect(emptyBundle?.binding.assetBundleHash).toMatch(/^[a-f0-9]{64}$/);
		expect(emptyBundle?.bundleMembers).toEqual([]);
		expect(emptyBundle?.blockers).toEqual([]);

		// ── an image that is not scanned clean keeps the version out of review ────
		const quarantined = await writeAsset({
			assetBrandId: brandId,
			versionId,
			sha256: digest("aa1"),
			scanStatus: "QUARANTINED",
		});
		const withQuarantined = await review.getReview(owner, brandId);
		// A quarantined asset is not in the bundle, so the bundle does not change …
		expect(withQuarantined.versions[0]?.binding.assetBundleHash).toBe(emptyBundle?.binding.assetBundleHash);
		// … but it is shown, because a reviewer has to know an image is pending.
		expect(withQuarantined.versions[0]?.assets.map((asset) => asset.id)).toContain(quarantined);

		await root.query(`UPDATE selena_registry.content_assets SET scan_status = 'CLEAN' WHERE id = $1`, [quarantined]);
		const ready = (await review.getReview(owner, brandId)).versions[0];
		if (!ready) throw new Error("the version under review disappeared");
		expect(ready.binding.assetBundleHash).not.toBe(emptyBundle?.binding.assetBundleHash);
		expect(ready.bundleMembers).toEqual([digest("aa1")]);
		expect(ready.blockers).toEqual([]);

		// ── a member cannot approve, and a stale screen cannot either ─────────────
		await expect(
			review.decide(member, {
				brandId,
				contentVersionId: versionId,
				decision: "APPROVED",
				reason: null,
				binding: ready.binding,
			}),
		).rejects.toThrow(/interactive owner/);

		await expect(
			review.decide(owner, {
				brandId,
				contentVersionId: versionId,
				decision: "APPROVED",
				reason: null,
				binding: { ...ready.binding, assetBundleHash: digest("bad") },
			}),
		).rejects.toMatchObject({ code: "STALE_DECISION" });

		// The database is the authority on the same binding, and it has to be seen
		// refusing on its own — a TypeScript comparison that agrees with the policy
		// is not evidence that the policy is there. This goes through the runtime
		// login rather than the repository, so nothing checks the hashes first.
		const webUrl = process.env.SELENA_WEB_DATABASE_URL;
		if (!webUrl) throw new Error("the runtime login URL is required");
		const runtime = new Client({ connectionString: webUrl });
		await runtime.connect();
		await runtime.query("BEGIN");
		await runtime.query("SELECT selena_registry.set_request_context($1, $2, $3, $4, $5, $6, $7, NULL)", [
			ownerId,
			organizationId,
			brandId,
			"owner",
			randomUUID(),
			"web",
			"session",
		]);
		await expect(
			runtime.query(
				`INSERT INTO selena_registry.editorial_approvals (
					organization_id, brand_id, content_version_id, decision,
					content_hash, profile_hash, evidence_hash, asset_bundle_hash, decided_by
				) VALUES ($1, $2, $3, 'APPROVED', $4, $5, $6, $7, $8)`,
				[
					organizationId,
					brandId,
					versionId,
					ready.binding.contentHash,
					ready.binding.profileHash,
					ready.binding.evidenceHash,
					digest("bad"),
					ownerId,
				],
			),
		).rejects.toMatchObject({ code: "42501" });
		await runtime.query("ROLLBACK");
		await runtime.end();

		// Asking for changes is not an owner act: a reviewer who can only say yes is
		// not a reviewer.
		const changes = await review.decide(member, {
			brandId,
			contentVersionId: versionId,
			decision: "CHANGES_REQUESTED",
			reason: "The hook promises a number the script never gives",
			binding: ready.binding,
		});
		expect(changes.decision).toBe("CHANGES_REQUESTED");

		const submitted = await review.submitForReview(member, { brandId, contentVersionId: versionId });
		expect(submitted.binding).toEqual(ready.binding);

		const approved = await review.decide(owner, {
			brandId,
			contentVersionId: versionId,
			decision: "APPROVED",
			reason: null,
			binding: ready.binding,
		});
		expect(approved.decision).toBe("APPROVED");

		const afterApproval = (await review.getReview(owner, brandId)).versions[0];
		expect(afterApproval?.standingDecision).toBe("APPROVED");
		expect(afterApproval?.approvalStale).toBe(false);

		// ── the approval goes stale when a new clean image joins the bundle ───────
		const second = await writeAsset({
			assetBrandId: brandId,
			versionId,
			sha256: digest("bb2"),
			scanStatus: "CLEAN",
			origin: "GENERATED",
		});
		const stale = (await review.getReview(owner, brandId)).versions[0];
		if (!stale) throw new Error("the version under review disappeared");
		expect(stale.approvalStale).toBe(true);
		expect(stale.binding.assetBundleHash).not.toBe(ready.binding.assetBundleHash);
		expect(stale.assets.find((asset) => asset.id === second)?.origin).toBe("GENERATED");

		// A decision made against the screen that showed the old bundle is refused …
		await expect(
			review.decide(owner, {
				brandId,
				contentVersionId: versionId,
				decision: "APPROVED",
				reason: null,
				binding: ready.binding,
			}),
		).rejects.toMatchObject({ code: "STALE_DECISION" });

		// … and an owner can still withdraw the stale approval, which is exactly
		// when withdrawing it matters.
		const revoked = await review.revokeApproval(owner, {
			brandId,
			contentVersionId: versionId,
			reason: "A second image joined the bundle after I read it",
		});
		expect(revoked.decision).toBe("REVOKED");

		// Revoking twice would be a decision about nothing. `decided_seq` is what
		// makes the standing decision answerable when both rows share a created_at.
		await expect(
			review.revokeApproval(owner, {
				brandId,
				contentVersionId: versionId,
				reason: "again",
			}),
		).rejects.toMatchObject({ code: "NOT_APPROVED" });

		const afterRevocation = (await review.getReview(owner, brandId)).versions[0];
		expect(afterRevocation?.standingDecision).toBe("REVOKED");
		// The record of what was once approved survives; nothing is edited away.
		expect(afterRevocation?.decisions.filter((decision) => decision.decision === "APPROVED")).toHaveLength(1);

		// ── an expired right blocks approval; an unrecorded one does not ──────────
		await root.query(`UPDATE selena_registry.content_assets SET rights_expires_at = now() - interval '1 day' WHERE id = $1`, [
			second,
		]);
		const expired = (await review.getReview(owner, brandId)).versions[0];
		expect(expired?.blockers).toContain("ASSET_RIGHTS_EXPIRED");
		await expect(
			review.decide(owner, {
				brandId,
				contentVersionId: versionId,
				decision: "APPROVED",
				reason: null,
				binding: expired?.binding ?? ready.binding,
			}),
		).rejects.toMatchObject({ code: "ASSET_RIGHTS_EXPIRED" });

		await root.query(`UPDATE selena_registry.content_assets SET rights_expires_at = NULL WHERE id = $1`, [second]);
		const unrecorded = (await review.getReview(owner, brandId)).versions[0];
		// A null is "nobody stated a limit", which is a different fact from a limit
		// that ran out.
		expect(unrecorded?.blockers).toEqual([]);

		// ── another brand's image is not in this brand's bundle ───────────────────
		const siblingScript = await (async () => {
			const siblingProfile = await profiles.profiles.createVersion(member, {
				organizationId,
				brandId: siblingBrandId,
				profile: profileInput,
			});
			await profiles.profiles.decide(owner, {
				organizationId,
				brandId: siblingBrandId,
				profileVersionId: siblingProfile.id,
				decision: "CONFIRMED",
			});
			await research.runResearch(member, { brandId: siblingBrandId, idempotencyKey: `sibling-run-${suffix}` });
			const siblingResearch = await research.getResearch(owner, siblingBrandId);
			const siblingOpportunity = siblingResearch.opportunities[0].id;
			await research.decideOpportunity(member, {
				organizationId,
				brandId: siblingBrandId,
				opportunityId: siblingOpportunity,
				decision: "SAVED",
			});
			const siblingIdeas = await creation.generateIdeas(member, {
				brandId: siblingBrandId,
				opportunityId: siblingOpportunity,
				idempotencyKey: `sibling-ideas-${suffix}`,
			});
			const siblingSelected = await creation.selectIdea(member, {
				brandId: siblingBrandId,
				generationRunId: siblingIdeas.id,
				ideaIndex: 0,
			});
			return creation.generateScript(member, {
				brandId: siblingBrandId,
				contentId: siblingSelected.contentId,
				idempotencyKey: `sibling-script-${suffix}`,
			});
		})();
		if (siblingScript.status !== "COMPLETED") throw new Error("sibling script generation failed");
		await writeAsset({
			assetBrandId: siblingBrandId,
			versionId: siblingScript.versionId,
			sha256: digest("cc3"),
			scanStatus: "CLEAN",
		});
		const stillOurs = (await review.getReview(owner, brandId)).versions[0];
		expect(stillOurs?.bundleMembers).not.toContain(digest("cc3"));
		// The sibling's version is not decidable from this brand's context at all.
		await expect(
			review.decide(owner, {
				brandId,
				contentVersionId: siblingScript.versionId,
				decision: "APPROVED",
				reason: null,
				binding: stillOurs?.binding ?? ready.binding,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		// ── evidence, when the brand's policy demands it ──────────────────────────
		await root.query(
			`INSERT INTO selena_registry.content_policies (organization_id, brand_id, policy_version, require_evidence, created_by)
			 VALUES ($1, $2, 'brand-pack/v1', true, $3)
			 ON CONFLICT (brand_id, policy_version) DO UPDATE SET require_evidence = true`,
			[organizationId, brandId, ownerId],
		);
		// An existing version cannot be emptied — content_versions is append-only and
		// the trigger refuses even a superuser — so the evidence-free case is a new
		// version rather than an edited one. It carries the profile lineage, so
		// EVIDENCE_REQUIRED is the only thing standing in the way.
		const evidenceFreeVersionId = randomUUID();
		await root.query(
			`INSERT INTO selena_registry.content_versions (
				id, organization_id, brand_id, content_id, version, body, cta_url, claims, evidence,
				disclosure, policy_version, content_hash, format_version, hash_version, structured_body,
				project_profile_version_id, research_run_id, generation_run_id, created_by
			)
			SELECT $1, organization_id, brand_id, content_id, 99, body, cta_url, claims, '[]'::jsonb,
				disclosure, policy_version, $2, format_version, hash_version, structured_body,
				project_profile_version_id, research_run_id, generation_run_id, created_by
			FROM selena_registry.content_versions WHERE id = $3`,
			[evidenceFreeVersionId, digest("ee5"), versionId],
		);
		const withoutEvidence = (await review.getReview(owner, brandId)).versions[0];
		expect(withoutEvidence?.versionId).toBe(evidenceFreeVersionId);
		expect(withoutEvidence?.requireEvidence).toBe(true);
		expect(withoutEvidence?.evidenceClaimCount).toBe(0);
		expect(withoutEvidence?.blockers).toEqual(["EVIDENCE_REQUIRED"]);
		await expect(
			review.decide(owner, {
				brandId,
				contentVersionId: evidenceFreeVersionId,
				decision: "APPROVED",
				reason: null,
				binding: withoutEvidence?.binding ?? ready.binding,
			}),
		).rejects.toMatchObject({ code: "EVIDENCE_REQUIRED" });

		// ── release containment ───────────────────────────────────────────────────
		// Stage 1 creates no YouTube channel account, so a publishing approval has
		// no foreign key it could name — an editorial approval id is not one.
		const channelAccounts = await root.query<{ count: string }>(
			`SELECT count(*)::text AS count FROM selena_registry.channel_accounts WHERE organization_id = $1`,
			[organizationId],
		);
		expect(channelAccounts.rows[0]?.count).toBe("0");
		await expect(
			root.query(
				`INSERT INTO selena_registry.approvals (
					organization_id, brand_id, content_version_id, channel_account_id, decision,
					binding_hash, content_hash, asset_bundle_hash, policy_version, disclosure_hash, approver_id
				) VALUES ($1, $2, $3, $4, 'APPROVED', $5, $5, $5, 'brand-pack/v1', $5, $6)`,
				[organizationId, brandId, versionId, approved.id, digest("dd4"), ownerId],
			),
		).rejects.toThrow(/foreign key|violates/i);

		for (const table of ["release_intents", "publication_attempts", "outbox_events"]) {
			const rows = await root.query<{ count: string }>(
				`SELECT count(*)::text AS count FROM selena_release.${table} WHERE organization_id = $1`,
				[organizationId],
			);
			expect(rows.rows[0]?.count).toBe("0");
		}

		// ── both slice events are on the brand's hash chain ───────────────────────
		const events = await root.query<{ action: string; metadata: Record<string, unknown> }>(
			`SELECT action, metadata FROM selena_audit.audit_events
			 WHERE organization_id = $1 AND brand_id = $2 AND action LIKE 'content.editorial%'
			 ORDER BY created_at`,
			[organizationId, brandId],
		);
		const actions = events.rows.map((row) => row.action);
		expect(actions).toContain("content.editorial_approved");
		expect(actions).toContain("content.editorial_approval_revoked");
		const allowedKeys = new Set([
			"contentId",
			"contentVersionId",
			"version",
			"contentHash",
			"profileHash",
			"evidenceHash",
			"assetBundleHash",
			"revokedApprovalId",
			"status",
		]);
		for (const row of events.rows) {
			for (const key of Object.keys(row.metadata)) expect(allowedKeys).toContain(key);
			// No storage key, no filename, no image bytes and no provider body ever
			// reaches the audit log.
			expect(JSON.stringify(row.metadata)).not.toMatch(/originals\/|base64|thumb\.png/);
		}

		await root.end();
	}, 120_000);
});

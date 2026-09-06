import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { createContentWorkflowRepositories } from "./content-workflow-repositories";

const disposableDatabaseUrl = process.env.SELENA_DISPOSABLE_DATABASE_URL;

describe.skipIf(!disposableDatabaseUrl)("content workflow PostgreSQL adapter", () => {
	it("keeps drafts brand-scoped, owner-decided, audited and publication-free", async () => {
		if (!disposableDatabaseUrl) throw new Error("disposable database URL is required");
		const suffix = randomUUID();
		const organizationId = `content-org-${suffix}`;
		const brandId = `content-brand-${suffix}`;
		const siblingBrandId = `content-sibling-${suffix}`;
		const ownerId = `content-owner-${suffix}`;
		const memberId = `content-member-${suffix}`;
		const root = new Client({ connectionString: disposableDatabaseUrl });
		await root.connect();
		await root.query(
			`INSERT INTO public."user" (id, name, email, created_at, updated_at)
			 VALUES ($1, 'Content Owner', $2, now(), now()), ($3, 'Content Member', $4, now(), now())`,
			[ownerId, `${ownerId}@example.test`, memberId, `${memberId}@example.test`],
		);
		await root.query(`INSERT INTO public.organization (id, name, slug, created_at) VALUES ($1, $2, $3, now())`, [
			organizationId,
			"Content Test Organization",
			organizationId,
		]);
		await root.query(
			`INSERT INTO public.member (id, organization_id, user_id, role, created_at)
			 VALUES ($1, $2, $3, 'owner', now()), ($4, $2, $5, 'member', now())`,
			[`owner-membership-${suffix}`, organizationId, ownerId, `member-membership-${suffix}`, memberId],
		);
		await root.query(
			`INSERT INTO public.brands (id, name, website, organization_id)
			 VALUES ($1, 'Content Test Brand', 'https://brand.example.test', $3),
			        ($2, 'Content Sibling Brand', 'https://sibling.example.test', $3)`,
			[brandId, siblingBrandId, organizationId],
		);

		const repositories = createContentWorkflowRepositories();
		const owner = { actorId: ownerId, tenantId: organizationId, role: "owner" as const, authType: "session" as const };
		const member = {
			actorId: memberId,
			tenantId: organizationId,
			role: "member" as const,
			authType: "session" as const,
		};
		const profile = {
			languages: ["en"],
			audience: { primary: "Guests", secondary: [], needs: ["menus"] },
			voice: { traits: ["warm"], examples: [], exclusions: ["unverified claims"] },
			ctaRules: ["Visit the website"],
			visualRules: { palette: ["terracotta"], imagery: ["real food"], avoid: [] },
			claimRules: { requireSources: true, allowedStates: ["VERIFIED" as const] },
			facts: [
				{
					id: "location",
					statement: "Bali",
					state: "VERIFIED" as const,
					sourceRefs: ["https://brand.example.test/about"],
				},
			],
			sourceRefs: [{ uri: "https://brand.example.test/about", title: "About" }],
		};

		const created = await repositories.profiles.createVersion(member, {
			organizationId,
			brandId,
			profile,
		});
		await expect(
			repositories.profiles.decide(member, {
				organizationId,
				brandId,
				profileVersionId: created.id,
				decision: "CONFIRMED",
			}),
		).rejects.toThrow(/interactive owner/);

		await repositories.profiles.decide(owner, {
			organizationId,
			brandId,
			profileVersionId: created.id,
			decision: "CONFIRMED",
		});
		expect((await repositories.profiles.getCurrent(owner, brandId))?.version.id).toBe(created.id);
		expect(await repositories.profiles.getCurrent(owner, siblingBrandId)).toBeNull();

		const firstChannel = await repositories.channels.ensureDraftYouTube(member, brandId);
		const secondChannel = await repositories.channels.ensureDraftYouTube(member, brandId);
		expect(secondChannel.id).toBe(firstChannel.id);
		expect(firstChannel.publicationMode).toBe("DRAFT_ONLY");

		await repositories.profiles.decide(owner, {
			organizationId,
			brandId,
			profileVersionId: created.id,
			decision: "REVOKED",
			reason: "Superseded by a future verified version",
		});
		expect(await repositories.profiles.getCurrent(owner, brandId)).toBeNull();

		const audit = await root.query<{
			action: string;
			event_hash: string;
			metadata: Record<string, unknown>;
			previous_hash: string | null;
		}>(
			`SELECT action, event_hash, metadata, previous_hash FROM selena_audit.audit_events
			 WHERE organization_id = $1 AND brand_id = $2 ORDER BY created_at, id`,
			[organizationId, brandId],
		);
		expect(audit.rows.map((row) => row.action)).toEqual([
			"content.profile_version_created",
			"content.profile_confirmed",
			"content.channel_draft_created",
			"content.profile_revoked",
		]);
		const allowedAuditKeys = new Set([
			"channelId",
			"decision",
			"platform",
			"profileHash",
			"profileVersionId",
			"publicationMode",
		]);
		for (const row of audit.rows) {
			expect(Object.keys(row.metadata).every((key) => allowedAuditKeys.has(key))).toBe(true);
		}
		expect(audit.rows[0]?.previous_hash).toBeNull();
		for (let index = 1; index < audit.rows.length; index += 1) {
			expect(audit.rows[index]?.previous_hash).toBe(audit.rows[index - 1]?.event_hash);
		}
		expect(new Set(audit.rows.map((row) => row.event_hash)).size).toBe(audit.rows.length);

		const releaseSideEffects = await root.query<{ total: string }>(
			`SELECT (
			   (SELECT count(*) FROM selena_registry.channel_accounts WHERE organization_id = $1) +
			   (SELECT count(*) FROM selena_release.release_intents WHERE organization_id = $1) +
			   (SELECT count(*) FROM selena_release.outbox_events WHERE organization_id = $1) +
			   (SELECT count(*) FROM selena_release.publication_attempts WHERE organization_id = $1)
			 )::text AS total`,
			[organizationId],
		);
		expect(releaseSideEffects.rows[0]?.total).toBe("0");
		await root.end();
	});
});

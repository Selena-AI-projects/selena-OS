import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { createContentResearchRepositories } from "./content-research-repositories";
import { createContentWorkflowRepositories } from "./content-workflow-repositories";

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

describe.skipIf(!disposableDatabaseUrl)("content research PostgreSQL adapter", () => {
	it("keeps research brand-scoped, evidence-bearing, idempotent and provider-free", async () => {
		if (!disposableDatabaseUrl) throw new Error("disposable database URL is required");
		const suffix = randomUUID();
		const organizationId = `research-org-${suffix}`;
		const brandId = `research-brand-${suffix}`;
		const siblingBrandId = `research-sibling-${suffix}`;
		const ownerId = `research-owner-${suffix}`;
		const memberId = `research-member-${suffix}`;

		const root = new Client({ connectionString: disposableDatabaseUrl });
		await root.connect();
		await root.query(
			`INSERT INTO public."user" (id, name, email, created_at, updated_at)
			 VALUES ($1, 'Research Owner', $2, now(), now()), ($3, 'Research Member', $4, now(), now())`,
			[ownerId, `${ownerId}@example.test`, memberId, `${memberId}@example.test`],
		);
		await root.query(`INSERT INTO public.organization (id, name, slug, created_at) VALUES ($1, $2, $3, now())`, [
			organizationId,
			"Research Test Organization",
			organizationId,
		]);
		await root.query(
			`INSERT INTO public.member (id, organization_id, user_id, role, created_at)
			 VALUES ($1, $2, $3, 'owner', now()), ($4, $2, $5, 'member', now())`,
			[`owner-membership-${suffix}`, organizationId, ownerId, `member-membership-${suffix}`, memberId],
		);
		await root.query(
			`INSERT INTO public.brands (id, name, website, organization_id)
			 VALUES ($1, 'Research Test Brand', 'https://brand.example.test', $3),
			        ($2, 'Research Sibling Brand', 'https://sibling.example.test', $3)`,
			[brandId, siblingBrandId, organizationId],
		);
		// A generous durable budget, so the env gates below stay the thing each
		// case exercises; without a budget row every non-fixture refusal would be
		// PROVIDER_BUDGET_MISSING before any gate is reached.
		await root.query(
			`INSERT INTO selena_registry.provider_budgets
			   (organization_id, brand_id, provider_id, window_kind, ceiling_calls, ceiling_cost_micros, set_by)
			 VALUES ($1, $2, 'video-radar', 'MONTH', 1000, 1000000000, $3)`,
			[organizationId, brandId, ownerId],
		);

		const profiles = createContentWorkflowRepositories();
		const research = createContentResearchRepositories();
		const owner = { actorId: ownerId, tenantId: organizationId, role: "owner" as const, authType: "session" as const };
		const member = {
			actorId: memberId,
			tenantId: organizationId,
			role: "member" as const,
			authType: "session" as const,
		};

		await expect(
			research.runResearch(member, { brandId, idempotencyKey: `no-profile-${suffix}` }),
		).rejects.toMatchObject({ code: "PROFILE_NOT_CONFIRMED" });

		const version = await profiles.profiles.createVersion(member, { organizationId, brandId, profile: profileInput });
		await profiles.profiles.decide(owner, {
			organizationId,
			brandId,
			profileVersionId: version.id,
			decision: "CONFIRMED",
		});

		const first = await research.runResearch(member, { brandId, idempotencyKey: `run-one-${suffix}` });
		expect(first.reused).toBe(false);
		expect(first.status).toBe("COMPLETED");
		expect(first.profileVersionId).toBe(version.id);

		const repeated = await research.runResearch(member, { brandId, idempotencyKey: `run-one-${suffix}` });
		expect(repeated.reused).toBe(true);
		expect(repeated.id).toBe(first.id);

		const state = await research.getResearch(owner, brandId);
		expect(state.run?.id).toBe(first.id);
		expect(state.run?.externalProviderCalls).toBe(0);
		expect(state.sources.length).toBeGreaterThan(0);
		expect(state.opportunities.length).toBeGreaterThan(0);
		// Every opportunity carries the evidence that justified it.
		for (const opportunity of state.opportunities) {
			expect(opportunity.evidenceSummary.length).toBeGreaterThan(0);
			expect(opportunity.state).toBe("NEW");
		}
		// A source whose transcript was unavailable stores the reason, not text.
		const withoutTranscript = state.sources.filter((source) => source.transcriptStatus !== "AVAILABLE");
		expect(withoutTranscript.length).toBeGreaterThan(0);
		for (const source of withoutTranscript) expect(source.transcriptFailureReason).not.toBeNull();

		const saved = await research.decideOpportunity(member, {
			organizationId,
			brandId,
			opportunityId: state.opportunities[0].id,
			decision: "SAVED",
		});
		expect(saved.decision).toBe("SAVED");
		await expect(
			research.decideOpportunity(member, {
				organizationId,
				brandId,
				opportunityId: state.opportunities[0].id,
				decision: "REJECTED",
			}),
		).rejects.toMatchObject({ code: "INVALID_INPUT" });
		await research.decideOpportunity(member, {
			organizationId,
			brandId,
			opportunityId: state.opportunities[0].id,
			decision: "REJECTED",
			reason: "Not a fit for this quarter",
		});

		// The sibling brand has its own confirmed profile and its own run; neither
		// brand can observe or decide the other's evidence.
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
		await research.runResearch(member, { brandId: siblingBrandId, idempotencyKey: `sibling-${suffix}` });
		const siblingState = await research.getResearch(owner, siblingBrandId);
		expect(siblingState.run?.id).not.toBe(first.id);
		await expect(
			research.decideOpportunity(member, {
				organizationId,
				brandId,
				opportunityId: siblingState.opportunities[0].id,
				decision: "SAVED",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		// Each live-provider gate is exercised separately through the server path,
		// because "we observed no calls" is not evidence that any one gate holds:
		// only opening the other two proves the remaining one is what refused.
		// The fourth case leaves every gate open and shows the adapter still
		// refuses, because Stage 1 injects no dispatcher at all.
		const gateCases = [
			// The durable reserve runs first: with no MAX_CALLS the permitted count
			// is zero, and zero is not allowed to mean unknown — so the ceiling
			// case is refused by the budget gate, while the flag case keeps a
			// ceiling so the live flag stays the thing it exercises.
			{ name: "flag", env: { CONTENT_OS_VIDEO_RADAR_MAX_CALLS: "5" }, expected: "ADAPTER_DISABLED" },
			{
				name: "ceiling",
				env: { CONTENT_OS_VIDEO_RADAR_LIVE: "true", CONTENT_OS_VIDEO_RADAR_CREDENTIAL_PRESENT: "true" },
				expected: "UNKNOWN_COST_BLOCKED",
			},
			{
				name: "credential",
				env: { CONTENT_OS_VIDEO_RADAR_LIVE: "true", CONTENT_OS_VIDEO_RADAR_MAX_CALLS: "5" },
				expected: "PROVIDER_AUTH_FAILED",
			},
			{
				name: "transport",
				env: {
					CONTENT_OS_VIDEO_RADAR_LIVE: "true",
					CONTENT_OS_VIDEO_RADAR_MAX_CALLS: "5",
					CONTENT_OS_VIDEO_RADAR_CREDENTIAL_PRESENT: "true",
				},
				expected: "PROVIDER_UNAVAILABLE",
			},
		] as const;

		const gateKeys = [
			"CONTENT_OS_VIDEO_RADAR_LIVE",
			"CONTENT_OS_VIDEO_RADAR_MAX_CALLS",
			"CONTENT_OS_VIDEO_RADAR_CREDENTIAL_PRESENT",
		] as const;

		for (const gateCase of gateCases) {
			for (const key of gateKeys) delete process.env[key];
			Object.assign(process.env, gateCase.env);

			const refused = await research.runResearch(member, {
				brandId,
				idempotencyKey: `radar-${gateCase.name}-${suffix}`,
				adapterId: "video-radar",
			});
			expect(refused.status).toBe("FAILED");
			const refusedRun = await root.query<{ failures: { code: string }[]; external_provider_calls: number }>(
				`SELECT failures, external_provider_calls FROM selena_registry.content_research_runs WHERE id = $1`,
				[refused.id],
			);
			expect(refusedRun.rows[0]?.failures.map((failure) => failure.code)).toEqual([gateCase.expected]);
			expect(refusedRun.rows[0]?.external_provider_calls).toBe(0);
		}
		for (const key of gateKeys) delete process.env[key];

		// Nothing above dispatched, so no run recorded a provider call.
		const providerCalls = await root.query<{ total: string }>(
			`SELECT coalesce(sum(external_provider_calls), 0)::text AS total
			 FROM selena_registry.content_research_runs WHERE organization_id = $1`,
			[organizationId],
		);
		expect(providerCalls.rows[0]?.total).toBe("0");

		// A revoked profile is not a confirmed one, so research stops.
		await profiles.profiles.decide(owner, {
			organizationId,
			brandId,
			profileVersionId: version.id,
			decision: "REVOKED",
			reason: "Superseded",
		});
		await expect(
			research.runResearch(member, { brandId, idempotencyKey: `after-revoke-${suffix}` }),
		).rejects.toMatchObject({ code: "PROFILE_NOT_CONFIRMED" });

		const audit = await root.query<{ action: string; metadata: Record<string, unknown> }>(
			`SELECT action, metadata FROM selena_audit.audit_events
			 WHERE organization_id = $1 AND brand_id = $2 AND action LIKE 'content.research%'
			    OR (organization_id = $1 AND brand_id = $2 AND action LIKE 'content.opportunity%')
			 ORDER BY created_at, id`,
			[organizationId, brandId],
		);
		const actions = new Set(audit.rows.map((row) => row.action));
		expect(actions.has("content.research_started")).toBe(true);
		expect(actions.has("content.research_completed")).toBe(true);
		expect(actions.has("content.research_failed")).toBe(true);
		expect(actions.has("content.opportunity_saved")).toBe(true);
		expect(actions.has("content.opportunity_rejected")).toBe(true);

		const allowedAuditKeys = new Set([
			"adapterId",
			"correlationId",
			"decision",
			"errorCodes",
			"externalProviderCalls",
			"opportunitiesProduced",
			"opportunityId",
			"profileHash",
			"profileVersionId",
			"runId",
			"shortlisted",
			"sourcesScored",
			"status",
		]);
		for (const row of audit.rows) {
			expect(Object.keys(row.metadata).every((key) => allowedAuditKeys.has(key))).toBe(true);
		}

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

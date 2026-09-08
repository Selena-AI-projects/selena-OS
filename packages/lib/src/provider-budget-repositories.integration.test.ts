import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { createContentCreationRepositories } from "./content-creation-repositories";
import { createContentResearchRepositories } from "./content-research-repositories";
import { createContentWorkflowRepositories } from "./content-workflow-repositories";
import { createProviderBudgetRepositories, ProviderBudgetError } from "./provider-budget-repositories";

const disposableDatabaseUrl = process.env.SELENA_DISPOSABLE_DATABASE_URL;

const profileInput = {
	languages: ["en"],
	audience: { primary: "budget-conscious founders", secondary: [], needs: ["cost control"] },
	voice: { traits: ["direct"], examples: [], exclusions: ["guaranteed outcomes"] },
	ctaRules: [],
	visualRules: { palette: [], imagery: [], avoid: [] },
	claimRules: { requireSources: true, allowedStates: ["VERIFIED" as const] },
	facts: [
		{
			id: "spend",
			statement: "Provider spend is bounded by an owner-set budget",
			state: "VERIFIED" as const,
			sourceRefs: ["https://budget.example.test/about"],
		},
	],
	sourceRefs: [{ uri: "https://budget.example.test/about", title: "About" }],
};

describe.skipIf(!disposableDatabaseUrl)("provider budget PostgreSQL adapter", () => {
	it("gates live provider calls behind an owner-set durable budget", async () => {
		if (!disposableDatabaseUrl) throw new Error("disposable database URL is required");
		const suffix = randomUUID();
		const organizationId = `budget-org-${suffix}`;
		const brandId = `budget-brand-${suffix}`;
		const siblingBrandId = `budget-sibling-${suffix}`;
		const ownerId = `budget-owner-${suffix}`;
		const memberId = `budget-member-${suffix}`;

		const root = new Client({ connectionString: disposableDatabaseUrl });
		await root.connect();
		await root.query(
			`INSERT INTO public."user" (id, name, email, created_at, updated_at)
			 VALUES ($1, 'Budget Owner', $2, now(), now()), ($3, 'Budget Member', $4, now(), now())`,
			[ownerId, `${ownerId}@example.test`, memberId, `${memberId}@example.test`],
		);
		await root.query(`INSERT INTO public.organization (id, name, slug, created_at) VALUES ($1, $2, $3, now())`, [
			organizationId,
			"Budget Test Organization",
			organizationId,
		]);
		await root.query(
			`INSERT INTO public.member (id, organization_id, user_id, role, created_at)
			 VALUES ($1, $2, $3, 'owner', now()), ($4, $2, $5, 'member', now())`,
			[`owner-membership-${suffix}`, organizationId, ownerId, `member-membership-${suffix}`, memberId],
		);
		await root.query(
			`INSERT INTO public.brands (id, name, website, organization_id)
			 VALUES ($1, 'Budget Test Brand', 'https://budget.example.test', $3),
			        ($2, 'Budget Sibling Brand', 'https://sibling.example.test', $3)`,
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
		const budgets = createProviderBudgetRepositories();
		const owner = { actorId: ownerId, tenantId: organizationId, role: "owner" as const, authType: "session" as const };
		const member = {
			actorId: memberId,
			tenantId: organizationId,
			role: "member" as const,
			authType: "session" as const,
		};

		// Reach a saved opportunity through the fixture vertical, which must
		// reserve nothing: the Stage 1 evidence of externalProviderCalls=0 stays
		// exactly as it was.
		const version = await profiles.profiles.createVersion(member, { organizationId, brandId, profile: profileInput });
		await profiles.profiles.decide(owner, {
			organizationId,
			brandId,
			profileVersionId: version.id,
			decision: "CONFIRMED",
		});
		await research.runResearch(member, { brandId, idempotencyKey: `budget-run-${suffix}` });
		const researchState = await research.getResearch(owner, brandId);
		const opportunityId = researchState.opportunities[0].id;
		await research.decideOpportunity(owner, { organizationId, brandId, opportunityId, decision: "SAVED" });

		const ledgerCount = async () => {
			const counted = await root.query<{ count: string }>(
				`SELECT count(*) AS count FROM selena_registry.provider_call_ledger WHERE brand_id = $1`,
				[brandId],
			);
			return Number(counted.rows[0].count);
		};
		expect(await ledgerCount()).toBe(0);

		// A member cannot set a budget; the database policy is the enforcement.
		await expect(
			budgets.setBudget(member, {
				brandId,
				providerId: "gemini",
				windowKind: "DAY",
				ceilingCalls: 8,
				ceilingCostMicros: 400_000,
			}),
		).rejects.toThrow(/row-level security/);

		const original = {
			CONTENT_OS_GEMINI_LIVE: process.env.CONTENT_OS_GEMINI_LIVE,
			CONTENT_OS_GEMINI_MAX_CALLS: process.env.CONTENT_OS_GEMINI_MAX_CALLS,
			CONTENT_OS_GEMINI_CREDENTIAL_PRESENT: process.env.CONTENT_OS_GEMINI_CREDENTIAL_PRESENT,
		};
		process.env.CONTENT_OS_GEMINI_LIVE = "true";
		process.env.CONTENT_OS_GEMINI_MAX_CALLS = "5";
		process.env.CONTENT_OS_GEMINI_CREDENTIAL_PRESENT = "true";
		try {
			// Every environment gate is open and still nothing may move: without a
			// budget row the run fails with the budget's own code, and no
			// reservation was ever written.
			const unbudgeted = await creation.generateIdeas(member, {
				brandId,
				opportunityId,
				idempotencyKey: `budget-ideas-unbudgeted-${suffix}`,
				adapterId: "gemini",
			});
			expect(unbudgeted.status).toBe("FAILED");
			expect(unbudgeted.errorCode).toBe("PROVIDER_BUDGET_MISSING");
			expect(await ledgerCount()).toBe(0);

			// The owner sets the budget interactively.
			const budget = await budgets.setBudget(owner, {
				brandId,
				providerId: "gemini",
				windowKind: "DAY",
				ceilingCalls: 8,
				ceilingCostMicros: 400_000,
			});
			expect(budget.id).toBeTruthy();

			// Reserve happy path, and a repeated idempotency key returns the same
			// reservation rather than committing the spend twice.
			const reserved = await budgets.reserve(owner, {
				brandId,
				providerId: "gemini",
				purpose: "test.reserve",
				idempotencyKey: `budget-reserve-${suffix}`,
				estimatedCalls: 2,
				estimatedCostMicros: 40_000,
			});
			const repeated = await budgets.reserve(owner, {
				brandId,
				providerId: "gemini",
				purpose: "test.reserve",
				idempotencyKey: `budget-reserve-${suffix}`,
				estimatedCalls: 2,
				estimatedCostMicros: 40_000,
			});
			expect(repeated.id).toBe(reserved.id);

			// A reservation that does not fit under the ceiling is refused with a
			// typed code.
			await expect(
				budgets.reserve(owner, {
					brandId,
					providerId: "gemini",
					purpose: "test.overflow",
					idempotencyKey: `budget-overflow-${suffix}`,
					estimatedCalls: 20,
					estimatedCostMicros: 400_000,
				}),
			).rejects.toMatchObject({ code: "PROVIDER_QUOTA_EXCEEDED" });

			// The sibling brand has no budget at all.
			await expect(
				budgets.reserve(owner, {
					brandId: siblingBrandId,
					providerId: "gemini",
					purpose: "test.sibling",
					idempotencyKey: `budget-sibling-${suffix}`,
					estimatedCalls: 1,
					estimatedCostMicros: 20_000,
				}),
			).rejects.toBeInstanceOf(ProviderBudgetError);
			await expect(
				budgets.reserve(owner, {
					brandId: siblingBrandId,
					providerId: "gemini",
					purpose: "test.sibling",
					idempotencyKey: `budget-sibling-${suffix}`,
					estimatedCalls: 1,
					estimatedCostMicros: 20_000,
				}),
			).rejects.toMatchObject({ code: "PROVIDER_BUDGET_MISSING" });

			// Settle forward: RESERVED -> DISPATCHED -> SETTLED.
			await budgets.settle(owner, { brandId, ledgerId: reserved.id, status: "DISPATCHED" });
			await budgets.settle(owner, { brandId, ledgerId: reserved.id, status: "SETTLED", actualCalls: 2 });
			const settledRow = await root.query<{ status: string; actual_calls: number; reserved_by: string }>(
				`SELECT status, actual_calls, reserved_by FROM selena_registry.provider_call_ledger WHERE id = $1`,
				[reserved.id],
			);
			expect(settledRow.rows[0]).toMatchObject({ status: "SETTLED", actual_calls: 2, reserved_by: ownerId });

			// What the UI will read: the newest budget with the window's committed spend.
			const visible = await budgets.getBudgets(owner, brandId);
			expect(visible).toHaveLength(1);
			expect(visible[0]).toMatchObject({
				providerId: "gemini",
				windowKind: "DAY",
				ceilingCalls: 8,
				ceilingCostMicros: 400_000,
				spentCalls: 2,
				spentCostMicros: 40_000,
			});

			// End to end with a budget: the reservation is written first, the
			// adapter is still refused (Stage 1 injects no dispatcher), and the
			// reservation settles FAILED with the run's normalized code.
			const budgeted = await creation.generateIdeas(member, {
				brandId,
				opportunityId,
				idempotencyKey: `budget-ideas-budgeted-${suffix}`,
				adapterId: "gemini",
			});
			expect(budgeted.status).toBe("FAILED");
			expect(budgeted.errorCode).toBe("PROVIDER_UNAVAILABLE");
			const failedRow = await root.query<{ status: string; error_code: string; reserved_by: string }>(
				`SELECT status, error_code, reserved_by FROM selena_registry.provider_call_ledger
				 WHERE brand_id = $1 AND idempotency_key = $2`,
				[brandId, `budget-ideas-budgeted-${suffix}`],
			);
			expect(failedRow.rows).toHaveLength(1);
			expect(failedRow.rows[0]).toMatchObject({
				status: "FAILED",
				error_code: "PROVIDER_UNAVAILABLE",
				reserved_by: memberId,
			});
		} finally {
			Object.assign(process.env, original);
			for (const [key, value] of Object.entries(original)) if (value === undefined) delete process.env[key];
		}

		await root.end();
	});
});

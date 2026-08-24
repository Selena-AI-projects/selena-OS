import { createServerFn } from "@tanstack/react-start";
import { db } from "@workspace/lib/db/db";
import {
	svAuditEvents,
	svConfigurationLocks,
	svCycles,
	svOrders,
	svPayments,
	svProjectProfiles,
	svProjects,
	svPromptFamilies,
	svQuotes,
	svScenarios,
} from "@workspace/lib/db/schema";
import { lockedProfileBlock } from "@workspace/lib/selena-extraction-context";
import { createSelenaRepositories, type SelenaRepositoryContext } from "@workspace/lib/selena-visibility-repositories";
import {
	analysisSubjectsSchema,
	apiModelIds,
	assertPaymentAllowed,
	expectedRunsFromScope,
	type MeasurementScope,
	measurementScopeSchema,
	paymentConfigFromEnv,
	monthlyAnswerAllowance,
	planIds,
	SELENA_CATALOG,
	SELENA_CATALOG_VERSION,
	SELENA_CHECKOUT_METADATA,
	type SelenaPlan,
	type SelenaPlanId,
	visitorSurfaces,
} from "@workspace/selena-visibility-contracts";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth/helpers";
import { approveOrder, enqueueOrderRunsForOrder } from "./selena-admin-orders";
import { resolveSessionAuthContext } from "../lib/selena-auth-context";

// The order desk: where a confirmed brand profile becomes an order the
// operator queue can act on. It contacts no provider and starts no run — it
// ends at PAID_REVIEW_REQUIRED, which is exactly where the approval screen
// begins.
//
// The questions a customer typed live in the profile snapshot as free text.
// A measurement addresses scenario rows, so this module promotes that text
// into scenarios a human then approves one by one: nothing is measured that a
// person did not read and accept, which is the whole point of the
// configuration lock.

const repositories = /* @__PURE__ */ createSelenaRepositories(db);

async function requireAdminContext(): Promise<SelenaRepositoryContext> {
	await requireAdmin();
	return resolveSessionAuthContext();
}

const projectIdSchema = z.object({ projectId: z.string().uuid() });

/** The family every promoted profile question lands in, one per project. */
const PROFILE_FAMILY_SOURCE = "brand_profile";

type ProfileQuestion = { text: string; language: string; intentType: string };

function readProfileQuestions(snapshot: unknown): ProfileQuestion[] {
	if (!Array.isArray(snapshot)) return [];
	return snapshot.flatMap((entry) => {
		if (typeof entry !== "object" || entry === null) return [];
		const record = entry as Record<string, unknown>;
		const text = typeof record.text === "string" ? record.text.trim() : "";
		if (text === "") return [];
		return [
			{
				text,
				language: typeof record.language === "string" ? record.language : "en",
				intentType: typeof record.intentType === "string" ? record.intentType : "discovery",
			},
		];
	});
}

function readProfileCompetitors(snapshot: unknown): { name: string; domain?: string }[] {
	if (!Array.isArray(snapshot)) return [];
	return snapshot.flatMap((entry) => {
		if (typeof entry !== "object" || entry === null) return [];
		const record = entry as Record<string, unknown>;
		const name = typeof record.name === "string" ? record.name.trim() : "";
		if (name === "") return [];
		const domains = Array.isArray(record.domains) ? record.domains : [];
		const domain = domains.find((value): value is string => typeof value === "string" && value.trim() !== "");
		return [domain ? { name, domain } : { name }];
	});
}

export const getSelenaOrderDeskFn = createServerFn({ method: "GET" }).handler(async () => {
	const context = await requireAdminContext();
	const projects = await db
		.select({
			id: svProjects.id,
			name: svProjects.name,
			category: svProjects.category,
			country: svProjects.country,
			region: svProjects.region,
			languages: svProjects.languages,
			brandName: svProjectProfiles.brandName,
			primaryDomain: svProjectProfiles.primaryDomain,
			profileConfirmedAt: svProjectProfiles.confirmedAt,
			scenarioSnapshot: svProjectProfiles.scenarioSnapshot,
		})
		.from(svProjects)
		.leftJoin(svProjectProfiles, eq(svProjectProfiles.projectId, svProjects.id))
		.where(eq(svProjects.organizationId, context.tenantId))
		.orderBy(desc(svProjects.createdAt));

	return Promise.all(
		projects.map(async (project) => {
			const scenarios = await db
				.select({
					id: svScenarios.id,
					text: svScenarios.text,
					language: svScenarios.language,
					status: svScenarios.status,
				})
				.from(svScenarios)
				.innerJoin(svPromptFamilies, eq(svScenarios.familyId, svPromptFamilies.id))
				.where(and(eq(svPromptFamilies.projectId, project.id), eq(svScenarios.organizationId, context.tenantId)))
				.orderBy(svScenarios.createdAt);
			return {
				id: project.id,
				name: project.name,
				category: project.category,
				country: project.country,
				region: project.region,
				languages: project.languages,
				brandName: project.brandName,
				primaryDomain: project.primaryDomain,
				profileConfirmedAt: project.profileConfirmedAt,
				profileQuestions: readProfileQuestions(project.scenarioSnapshot).length,
				scenarios,
			};
		}),
	);
});

/**
 * Copy the confirmed profile's questions into scenario rows, as PROPOSED.
 *
 * Idempotent by text: running it again after the customer edits their profile
 * adds only what is new, so an approval already given is never silently reset.
 */
export const prepareSelenaScenariosFn = createServerFn({ method: "POST" })
	.validator(projectIdSchema)
	.handler(async ({ data }) => {
		// The customer's own judgement over their own project: tenant scoping is
		// the guard here, not the operator role.
		const context = await resolveSessionAuthContext();
		const profile = await repositories.profiles.get(context, data.projectId);
		if (!profile) throw new Error("SELENA_PROFILE_MISSING");
		if (!profile.confirmedAt) throw new Error("SELENA_PROFILE_NOT_CONFIRMED");
		const questions = readProfileQuestions(profile.scenarioSnapshot);
		if (questions.length === 0) throw new Error("SELENA_PROFILE_HAS_NO_QUESTIONS");

		const [existingFamily] = await db
			.select({ id: svPromptFamilies.id })
			.from(svPromptFamilies)
			.where(
				and(
					eq(svPromptFamilies.projectId, data.projectId),
					eq(svPromptFamilies.organizationId, context.tenantId),
					eq(svPromptFamilies.source, PROFILE_FAMILY_SOURCE),
				),
			)
			.limit(1);
		const family =
			existingFamily ??
			(await repositories.families.create(context, {
				projectId: data.projectId,
				intentType: "discovery",
				source: PROFILE_FAMILY_SOURCE,
				status: "PROPOSED",
			}));

		const existing = await repositories.scenarios.list(context, family.id);
		const known = new Set(existing.map((scenario) => scenario.text));
		const fresh = questions.filter((question) => !known.has(question.text));
		for (const question of fresh) {
			await repositories.scenarios.create(context, {
				familyId: family.id,
				text: question.text,
				language: question.language,
				status: "PROPOSED",
			});
		}
		return { familyId: family.id, added: fresh.length, total: existing.length + fresh.length };
	});

/**
 * The human gate. A scenario reaches a paid run only by being approved here,
 * so an auto-suggested question that misreads the business dies at this step
 * instead of becoming a measurement nobody can interpret.
 */
export const decideSelenaScenariosFn = createServerFn({ method: "POST" })
	.validator(
		projectIdSchema.extend({
			scenarioIds: z.array(z.string().uuid()).min(1).max(200),
			decision: z.enum(["APPROVED", "REJECTED", "PROPOSED"]),
		}),
	)
	.handler(async ({ data }) => {
		const context = await resolveSessionAuthContext();
		const owned = await db
			.select({ id: svScenarios.id })
			.from(svScenarios)
			.innerJoin(svPromptFamilies, eq(svScenarios.familyId, svPromptFamilies.id))
			.where(
				and(
					inArray(svScenarios.id, data.scenarioIds),
					eq(svScenarios.organizationId, context.tenantId),
					eq(svPromptFamilies.projectId, data.projectId),
				),
			);
		if (owned.length !== data.scenarioIds.length)
			throw new Error("Not found: scenario is outside AuthContext tenant or project");
		await db
			.update(svScenarios)
			.set({ status: data.decision, updatedAt: new Date() })
			.where(and(inArray(svScenarios.id, data.scenarioIds), eq(svScenarios.organizationId, context.tenantId)));
		return { updated: data.scenarioIds.length, decision: data.decision };
	});

function scopeForPlan(plan: SelenaPlan, scenarioIds: string[]): MeasurementScope {
	const systems = plan.systems.map((systemId) => ({
		systemId,
		channel: (visitorSurfaces as readonly string[]).includes(systemId) ? ("VISITOR" as const) : ("API" as const),
	}));
	const unknown = plan.systems.filter(
		(systemId) =>
			!(visitorSurfaces as readonly string[]).includes(systemId) &&
			!(apiModelIds as readonly string[]).includes(systemId),
	);
	if (unknown.length > 0) throw new Error(`SELENA_UNKNOWN_CATALOG_SYSTEM: ${unknown.join(", ")}`);
	return measurementScopeSchema.parse({
		scenarios: scenarioIds,
		systems,
		repeats: plan.repeatCount ?? 1,
	});
}

/**
 * Build one order from an approved scope: configuration lock, quote, order and
 * the recorded test payment that leaves it at PAID_REVIEW_REQUIRED.
 *
 * The lock is what a run is measured against, so it is written before the
 * money objects and never mutated afterwards: an order that has been paid for
 * always points at the exact scope the customer agreed to.
 */
type OrderDraftInput = {
	projectId: string;
	planId: (typeof planIds)[number];
	scenarioIds: string[];
	idempotencyKey: string;
};

async function createSelenaOrderDraft(data: OrderDraftInput) {
	{
		const context = await requireAdminContext();
		// The payment gate decides before anything is written: a desk that
		// cannot record the payment must not leave a half-built order behind.
		assertPaymentAllowed(paymentConfigFromEnv(process.env), "test");

		const plan = SELENA_CATALOG[data.planId as SelenaPlanId];
		const approved = await db
			.select({ id: svScenarios.id, text: svScenarios.text, language: svScenarios.language })
			.from(svScenarios)
			.innerJoin(svPromptFamilies, eq(svScenarios.familyId, svPromptFamilies.id))
			.where(
				and(
					inArray(svScenarios.id, data.scenarioIds),
					eq(svScenarios.organizationId, context.tenantId),
					eq(svPromptFamilies.projectId, data.projectId),
					eq(svScenarios.status, "APPROVED"),
				),
			);
		if (approved.length !== data.scenarioIds.length) throw new Error("SELENA_SCENARIOS_NOT_APPROVED");
		if (plan.scenarioLimit !== null && approved.length > plan.scenarioLimit)
			throw new Error(`SELENA_PLAN_SCENARIO_LIMIT_EXCEEDED: ${plan.scenarioLimit}`);

		const scope = scopeForPlan(plan, data.scenarioIds);
		const expectedRuns = expectedRunsFromScope(scope);
		// The pricing page quotes a monthly allowance (300/800 answers); an
		// order that would overrun it is refused with the numbers, not queued
		// quietly. Usage counts the calendar month's created cycles — orders
		// still awaiting review carry no cycle yet and are the operator's call.
		const allowance = monthlyAnswerAllowance(plan.planId);
		if (allowance !== null) {
			const monthStart = new Date();
			monthStart.setUTCDate(1);
			monthStart.setUTCHours(0, 0, 0, 0);
			const [usage] = await db
				.select({ used: sql<number>`coalesce(sum(${svCycles.expectedRuns}), 0)` })
				.from(svCycles)
				.innerJoin(svOrders, eq(svCycles.orderId, svOrders.id))
				.where(
					and(
						eq(svOrders.projectId, data.projectId),
						eq(svOrders.organizationId, context.tenantId),
						gte(svCycles.createdAt, monthStart),
					),
				);
			const used = Number(usage?.used ?? 0);
			if (used + expectedRuns > allowance)
				throw new Error(
					`SELENA_MONTHLY_ALLOWANCE_EXCEEDED: used ${used} of ${allowance} this month; this measurement needs ${expectedRuns} more`,
				);
		}

		// Frozen with the scope: analysis looks for exactly the brand and
		// competitors the customer agreed to, so a later profile edit cannot
		// change what a paid report says.
		const profile = await repositories.profiles.get(context, data.projectId);
		if (!profile) throw new Error("SELENA_PROFILE_MISSING");
		const subjects = analysisSubjectsSchema.parse({
			brand: {
				name: profile.brandName,
				domain: profile.primaryDomain,
			},
			competitors: readProfileCompetitors(profile.competitorSnapshot),
		});

		const [priorVersion] = await db
			.select({ version: sql<number>`coalesce(max(${svConfigurationLocks.version}), 0)::int` })
			.from(svConfigurationLocks)
			.where(
				and(
					eq(svConfigurationLocks.projectId, data.projectId),
					eq(svConfigurationLocks.organizationId, context.tenantId),
				),
			);

		const lock = await repositories.locks.create(context, {
			projectId: data.projectId,
			version: (priorVersion?.version ?? 0) + 1,
			snapshot: {
				measurementScope: scope,
				analysisSubjects: subjects,
				// The extraction resolver prefers this block over the live
				// profile: without it a profile edit after purchase would change
				// what the cycle's runs are measured against.
				profile: lockedProfileBlock(profile),
				planId: plan.planId,
				catalogVersion: SELENA_CATALOG_VERSION,
				scenarios: approved.map((scenario) => ({
					id: scenario.id,
					text: scenario.text,
					language: scenario.language,
				})),
			},
			// The catalog version is what a run is reproducible against until a
			// build stamp is threaded through the deployment.
			engineSha: SELENA_CATALOG_VERSION,
			expectedRuns,
			budgetCap: String(plan.providerBudgetCap),
		});

		const quote = await repositories.quotes.create(context, {
			projectId: data.projectId,
			lockId: lock.id,
			status: "ISSUED",
			priceAmount: String(plan.price),
			currency: plan.currency,
			expectedRuns,
			expiresAt: new Date(Date.now() + 7 * 86400000),
		});

		const order = await repositories.orders.create(context, {
			projectId: data.projectId,
			quoteId: quote.id,
			lockId: lock.id,
			status: "AWAITING_PAYMENT",
			// The order cap bounds provider spend, not the price: it is what
			// preflight measures the worst-case run cost against.
			orderCap: String(plan.providerBudgetCap),
		});

		const [payment] = await db
			.insert(svPayments)
			.values({
				organizationId: context.tenantId,
				orderId: order.id,
				provider: "test",
				providerEventId: data.idempotencyKey,
				status: "SUCCEEDED",
				amount: String(plan.price),
				currency: plan.currency,
			})
			.onConflictDoNothing({ target: [svPayments.provider, svPayments.providerEventId] })
			.returning({ id: svPayments.id });
		if (payment)
			await db
				.update(svOrders)
				.set({ status: "PAID_REVIEW_REQUIRED", paidAt: new Date(), updatedAt: new Date() })
				.where(and(eq(svOrders.id, order.id), eq(svOrders.organizationId, context.tenantId)));

		await db.insert(svAuditEvents).values({
			organizationId: context.tenantId,
			actorId: context.actorId,
			event: "ORDER_DRAFTED",
			subjectKind: "sv_orders",
			subjectId: order.id,
			details: {
				planId: plan.planId,
				lockId: lock.id,
				lockVersion: lock.version,
				quoteId: quote.id,
				expectedRuns,
				scenarioCount: approved.length,
				idempotencyKey: data.idempotencyKey,
				checkoutMetadata: SELENA_CHECKOUT_METADATA,
			},
		});

		return {
			orderId: order.id,
			lockId: lock.id,
			lockVersion: lock.version,
			quoteId: quote.id,
			planId: plan.planId,
			planName: plan.name,
			price: plan.price,
			currency: plan.currency,
			expectedRuns,
			budgetCap: plan.providerBudgetCap,
			status: payment ? "PAID_REVIEW_REQUIRED" : "AWAITING_PAYMENT",
			paymentRecorded: Boolean(payment),
		};
	}
}

export const createSelenaOrderDraftFn = createServerFn({ method: "POST" })
	.validator(
		projectIdSchema.extend({
			planId: z.enum(planIds),
			scenarioIds: z.array(z.string().uuid()).min(1).max(200),
			idempotencyKey: z.string().min(1).max(200),
		}),
	)
	.handler(async ({ data }) => createSelenaOrderDraft(data));

/**
 * Order, approve and queue in one action.
 *
 * The judgement an operator makes is which questions are worth measuring;
 * ordering, approving and queueing are three clicks on a decision already
 * taken. They stay three separate gates in the code — this only stops asking
 * three times for one answer, and still spends nothing without the click that
 * calls it.
 */
export const startSelenaMeasurementFn = createServerFn({ method: "POST" })
	.validator(
		projectIdSchema.extend({
			planId: z.enum(planIds),
			scenarioIds: z.array(z.string().uuid()).min(1).max(200),
			idempotencyKey: z.string().min(1).max(200),
		}),
	)
	.handler(async ({ data }) => {
		const draft = await createSelenaOrderDraft(data);
		if (!draft.paymentRecorded)
			return { ...draft, approved: null, queued: null, stoppedAt: "payment" as const };

		const context = await requireAdminContext();
		const approved = await approveOrder(context, draft.orderId, `${data.idempotencyKey}:approve`);
		const queued = await enqueueOrderRunsForOrder(context, draft.orderId, `${data.idempotencyKey}:enqueue`);
		return {
			...draft,
			approved: { permits: approved.created, expected: approved.expected },
			queued: { enqueued: queued.enqueued, skipped: queued.skipped, reason: queued.reason },
			stoppedAt: queued.reason ? ("execution" as const) : null,
		};
	});

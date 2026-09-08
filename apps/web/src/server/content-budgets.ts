import { createServerFn } from "@tanstack/react-start";
import { providerBudgetRepositories } from "@workspace/lib/provider-budget-repositories";
import { z } from "zod";
import { isContentOsStage1Enabled } from "@/lib/content-os-stage1.server";
import { resolveSessionAuthContext } from "@/lib/selena-auth-context.server";

// Provider budget server functions (Slice 3.2). Thin, like every Content OS
// handler. Reading is brand-scoped; writing a budget is an owner act the
// database enforces on its own — the handler adds nothing the policy could
// drift from. No provider is called anywhere on this path.

const brandInput = z.object({ brandId: z.string().trim().min(1).max(120) });

const setBudgetInput = z.object({
	brandId: z.string().trim().min(1).max(120),
	providerId: z.enum(["gemini", "video-radar"]),
	windowKind: z.enum(["DAY", "MONTH"]),
	ceilingCalls: z.number().int().min(1).max(1_000_000),
	ceilingCostMicros: z
		.number()
		.int()
		.min(0)
		.max(10_000_000_000_000), // ten million dollars is already a typo, not a budget
});

function assertStage1Enabled(): void {
	if (!isContentOsStage1Enabled()) throw new Error("Content OS Stage 1 is disabled");
}

export const getContentBudgetsFn = createServerFn({ method: "GET" })
	.validator(brandInput)
	.handler(async ({ data }) => {
		assertStage1Enabled();
		const context = await resolveSessionAuthContext();
		const budgets = await providerBudgetRepositories.getBudgets(context, data.brandId);
		return {
			canSet: context.authType === "session" && context.role === "owner",
			budgets,
		};
	});

export const setContentBudgetFn = createServerFn({ method: "POST" })
	.validator(setBudgetInput)
	.handler(async ({ data }) => {
		assertStage1Enabled();
		const context = await resolveSessionAuthContext();
		return providerBudgetRepositories.setBudget(context, data);
	});

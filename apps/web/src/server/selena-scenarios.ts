import { createServerFn } from "@tanstack/react-start";
import { db } from "@workspace/lib/db/db";
import { svPromptFamilies, svScenarios } from "@workspace/lib/db/schema";
import { createSelenaRepositories } from "@workspace/lib/selena-visibility-repositories";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { resolveSessionAuthContext } from "../lib/selena-auth-context";

const repositories = /* @__PURE__ */ createSelenaRepositories(db);

export type ScenarioListItem = {
	id: string;
	familyId: string;
	intentType: string;
	text: string;
	language: string;
	status: string;
};

/**
 * Step 2 of the cabinet: the questions a paid cycle would ask. The backend
 * already refuses to build an order from anything but APPROVED scenarios;
 * this read makes that state visible so the customer can decide it.
 */
export const listSelenaScenariosFn = createServerFn({ method: "GET" })
	.validator(z.object({ projectId: z.string().uuid() }))
	.handler(async ({ data }): Promise<{ scenarios: ScenarioListItem[] }> => {
		const context = await resolveSessionAuthContext();
		const project = await repositories.projects.get(context, data.projectId);
		if (!project) throw new Error("Not found: project is outside AuthContext tenant");
		const rows = await db
			.select({
				id: svScenarios.id,
				familyId: svScenarios.familyId,
				intentType: svPromptFamilies.intentType,
				text: svScenarios.text,
				language: svScenarios.language,
				status: svScenarios.status,
			})
			.from(svScenarios)
			.innerJoin(svPromptFamilies, eq(svScenarios.familyId, svPromptFamilies.id))
			.where(and(eq(svPromptFamilies.projectId, data.projectId), eq(svScenarios.organizationId, context.tenantId)))
			.orderBy(asc(svScenarios.createdAt));
		return { scenarios: rows };
	});

export const reviewSelenaScenarioFn = createServerFn({ method: "POST" })
	.validator(
		z.object({
			scenarioId: z.string().uuid(),
			decision: z.enum(["APPROVED", "REJECTED"]),
			text: z.string().max(2000).optional(),
		}),
	)
	.handler(async ({ data }) => {
		const context = await resolveSessionAuthContext();
		const updated = await repositories.scenarios.review(context, data.scenarioId, {
			decision: data.decision,
			text: data.text,
		});
		return { id: updated.id, status: updated.status, text: updated.text };
	});

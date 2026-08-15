import { createServerFn } from "@tanstack/react-start";
import { assertCanonicalDataset, ledgerToCsv } from "@workspace/lib/selena-export";
import { z } from "zod";
import { resolveSessionAuthContext } from "../lib/selena-auth-context";

const ledgerRowSchema = z.object({
	runId: z.string().min(1),
	cycleId: z.string().min(1),
	channel: z.enum(["Visitor View", "API View"]),
	brand: z.string(),
	scenarioId: z.string(),
	scenarioText: z.string(),
	system: z.string(),
	model: z.string().nullable(),
	timestamp: z.string(),
	language: z.string(),
	region: z.string().nullable(),
	validity: z.string(),
	rawResponseReference: z.string().nullable(),
	mention: z.boolean(),
	position: z.number().nullable(),
	ownedCitation: z.boolean(),
	citations: z.array(z.string()),
	competitors: z.array(z.string()),
	factualErrors: z.array(z.string()),
	tokenUsage: z.object({ input: z.number(), output: z.number(), total: z.number() }).nullable(),
	cost: z.number().nullable(),
	qcStatus: z.string(),
});

export const exportSelenaCsvFn = createServerFn({ method: "POST" })
	.validator(
		z.object({
			tenantId: z.string().optional(),
			expectedRuns: z.number().int().positive(),
			rows: z.array(ledgerRowSchema).max(10000),
		}),
	)
	.handler(async ({ data }) => {
		const context = await resolveSessionAuthContext();
		if (data.tenantId && data.tenantId !== context.tenantId)
			throw new Error("Forbidden: tenant_id is controlled by AuthContext");
		assertCanonicalDataset(data.rows, data.expectedRuns);
		return {
			filename: `selena-${context.tenantId}-evidence-ledger.csv`,
			contentType: "text/csv; charset=utf-8",
			content: ledgerToCsv(data.rows),
		};
	});

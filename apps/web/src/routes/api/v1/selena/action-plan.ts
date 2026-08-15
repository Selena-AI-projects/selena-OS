import { createFileRoute } from "@tanstack/react-router";
import { buildActionPlan, validateGrounding } from "@workspace/lib/recommendation-engine";
import { createSelenaDataset } from "@workspace/lib/selena-dataset-gateway";
import { assertCanonicalDataset, ledgerToCsv } from "@workspace/lib/selena-export";
import { z } from "zod";
import { resolveApiKeyAuthContext } from "../../../../lib/selena-auth-context";

const ledgerRowSchema = z.object({
	runId: z.string().min(1),
	cycleId: z.string().min(1),
	channel: z.enum(["Visitor View", "API View"]),
	brand: z.string(),
	scenarioId: z.string().min(1),
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

const requestSchema = z.object({
	datasetId: z.string().min(1),
	rows: z.array(ledgerRowSchema).min(1),
	expectedRuns: z.number().int().positive().optional(),
	rulepackVersion: z.string().optional(),
	capturedAt: z.string().optional(),
});

export const Route = createFileRoute("/api/v1/selena/action-plan")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				try {
					const auth = await resolveApiKeyAuthContext(request);
					if (!auth.permissions.includes("client:write"))
						return Response.json(
							{ error: "Forbidden", message: "API key lacks client:write permission" },
							{ status: 403 },
						);
					const parsed = requestSchema.safeParse(await request.json());
					if (!parsed.success)
						return Response.json({ error: "Validation Error", message: parsed.error.message }, { status: 400 });
					if (parsed.data.expectedRuns !== undefined)
						assertCanonicalDataset(parsed.data.rows, parsed.data.expectedRuns);
					const dataset = createSelenaDataset(auth.tenantId, parsed.data.datasetId, parsed.data.rows, parsed.data);
					const plan = buildActionPlan(auth.tenantId, dataset.manifest, dataset.evidence);
					return Response.json(
						{
							dataset,
							plan,
							groundingErrors: validateGrounding(plan, dataset.evidence),
							qc: {
								cardinalityChecked: parsed.data.expectedRuns !== undefined,
								canonicalCsv: ledgerToCsv(dataset.rows),
							},
						},
						{ status: 201 },
					);
				} catch (error) {
					return Response.json(
						{
							error: "Request Failed",
							message: error instanceof Error ? error.message : "Unable to build action plan",
						},
						{ status: 400 },
					);
				}
			},
		},
	},
});

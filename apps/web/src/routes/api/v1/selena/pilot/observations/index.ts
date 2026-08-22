import { createFileRoute } from "@tanstack/react-router";
import { db } from "@workspace/lib/db/db";
import { createSelenaRepositories } from "@workspace/lib/selena-visibility-repositories";
import { observerContextSchema, orderingStates } from "@workspace/selena-visibility-contracts";
import { z } from "zod";
import { createSelenaApiHandler } from "../../../../../../lib/selena-api-handler";
import { pilotDisabledResponse, pilotErrorResponse } from "../../../../../../lib/selena-pilot-gate";

const repositories = createSelenaRepositories(db);

const submissionSchema = z.object({
	captureTaskId: z.string().uuid(),
	idempotencyKey: z.string().min(1).max(200),
	capturedAt: z.iso.datetime(),
	queryText: z.string().min(1),
	context: observerContextSchema,
	orderingState: z.enum(orderingStates).optional(),
	transcript: z.string().min(1),
	// The screenshot reference stays an opaque string end to end: the server
	// records it as evidence but never dereferences it.
	screenshot: z.object({
		privateObjectReference: z.string().min(1),
		mimeType: z.string().min(1),
		sizeBytes: z.number().int().positive(),
		sha256: z.string().regex(/^[0-9a-f]{64}$/),
	}),
});

const submitObservation = createSelenaApiHandler(async ({ request, auth }) => {
	const parsed = submissionSchema.safeParse(await request.json());
	if (!parsed.success)
		return Response.json({ error: "Validation Error", message: parsed.error.message }, { status: 400 });
	try {
		return Response.json(await repositories.observations.submit(auth, parsed.data), { status: 201 });
	} catch (error) {
		return pilotErrorResponse(error);
	}
});

export const Route = createFileRoute("/api/v1/selena/pilot/observations/")({
	server: {
		handlers: {
			POST: async ({ request }) => pilotDisabledResponse() ?? submitObservation({ request }),
		},
	},
});

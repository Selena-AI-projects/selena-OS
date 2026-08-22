import { createFileRoute } from "@tanstack/react-router";
import { db } from "@workspace/lib/db/db";
import { createSelenaRepositories } from "@workspace/lib/selena-visibility-repositories";
import { observationReviewDecisions } from "@workspace/selena-visibility-contracts";
import { z } from "zod";
import { createSelenaApiHandler } from "../../../../../../../lib/selena-api-handler";
import { pilotDisabledResponse, pilotErrorResponse } from "../../../../../../../lib/selena-pilot-gate";

const repositories = createSelenaRepositories(db);

const reviewSchema = z.object({
	decision: z.enum(observationReviewDecisions),
	reason: z.string().min(1).max(2000).optional(),
	idempotencyKey: z.string().min(1).max(200),
});

const reviewObservation = (observationId: string) =>
	createSelenaApiHandler(async ({ request, auth }) => {
		const parsed = reviewSchema.safeParse(await request.json());
		if (!parsed.success)
			return Response.json({ error: "Validation Error", message: parsed.error.message }, { status: 400 });
		try {
			return Response.json(await repositories.observations.review(auth, observationId, parsed.data));
		} catch (error) {
			return pilotErrorResponse(error);
		}
	});

export const Route = createFileRoute("/api/v1/selena/pilot/observations/$observationId/review")({
	server: {
		handlers: {
			POST: async ({ request, params }) =>
				pilotDisabledResponse() ?? reviewObservation(params.observationId)({ request }),
		},
	},
});

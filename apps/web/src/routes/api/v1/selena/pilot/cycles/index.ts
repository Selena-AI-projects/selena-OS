import { createFileRoute } from "@tanstack/react-router";
import { db } from "@workspace/lib/db/db";
import { createSelenaRepositories } from "@workspace/lib/selena-visibility-repositories";
import { z } from "zod";
import { createSelenaApiHandler } from "../../../../../../lib/selena-api-handler";
import { pilotDisabledResponse, pilotErrorResponse } from "../../../../../../lib/selena-pilot-gate";

const repositories = createSelenaRepositories(db);

const cycleCreateSchema = z.object({
	projectId: z.string().uuid(),
	lockId: z.string().uuid(),
	idempotencyKey: z.string().min(1).max(200),
});

const listCycles = createSelenaApiHandler(async ({ auth }) => ({
	cycles: await repositories.pilotCycles.list(auth),
}));

const createCycle = createSelenaApiHandler(async ({ request, auth }) => {
	const parsed = cycleCreateSchema.safeParse(await request.json());
	if (!parsed.success)
		return Response.json({ error: "Validation Error", message: parsed.error.message }, { status: 400 });
	try {
		return Response.json(await repositories.pilotCycles.create(auth, parsed.data), { status: 201 });
	} catch (error) {
		return pilotErrorResponse(error);
	}
});

export const Route = createFileRoute("/api/v1/selena/pilot/cycles/")({
	server: {
		handlers: {
			GET: async ({ request }) => pilotDisabledResponse() ?? listCycles({ request }),
			POST: async ({ request }) => pilotDisabledResponse() ?? createCycle({ request }),
		},
	},
});

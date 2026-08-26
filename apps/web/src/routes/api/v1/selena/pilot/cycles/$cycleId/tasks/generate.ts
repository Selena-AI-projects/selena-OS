import { createFileRoute } from "@tanstack/react-router";
import { db } from "@workspace/lib/db/db";
import { createSelenaRepositories } from "@workspace/lib/selena-visibility-repositories";
import { z } from "zod";
import { createSelenaApiHandler } from "../../../../../../../../lib/selena-api-handler";
import { pilotDisabledResponse, pilotErrorResponse } from "../../../../../../../../lib/selena-pilot-gate";

const repositories = createSelenaRepositories(db);

const generateSchema = z.object({ idempotencyKey: z.string().min(1).max(200) });

const generateTasks = (pilotCycleId: string) =>
	createSelenaApiHandler(async ({ request, auth }) => {
		const parsed = generateSchema.safeParse(await request.json());
		if (!parsed.success)
			return Response.json({ error: "Validation Error", message: parsed.error.message }, { status: 400 });
		try {
			const tasks = await repositories.captureTasks.generate(auth, pilotCycleId, parsed.data.idempotencyKey);
			return Response.json({ pilotCycleId, created: tasks.length, tasks }, { status: 201 });
		} catch (error) {
			return pilotErrorResponse(error);
		}
	});

export const Route = createFileRoute("/api/v1/selena/pilot/cycles/$cycleId/tasks/generate")({
	server: {
		handlers: {
			POST: async ({ request, params }) => pilotDisabledResponse() ?? generateTasks(params.cycleId)({ request }),
		},
	},
});

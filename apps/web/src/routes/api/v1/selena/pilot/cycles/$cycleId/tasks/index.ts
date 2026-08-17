import { createFileRoute } from "@tanstack/react-router";
import { db } from "@workspace/lib/db/db";
import { createSelenaRepositories } from "@workspace/lib/selena-visibility-repositories";
import { createSelenaApiHandler } from "../../../../../../../../lib/selena-api-handler";
import { pilotDisabledResponse, pilotErrorResponse } from "../../../../../../../../lib/selena-pilot-gate";

const repositories = createSelenaRepositories(db);

const listTasks = (pilotCycleId: string) =>
	createSelenaApiHandler(async ({ auth }) => {
		try {
			await repositories.pilotCycles.get(auth, pilotCycleId);
			return { pilotCycleId, tasks: await repositories.captureTasks.list(auth, pilotCycleId) };
		} catch (error) {
			return pilotErrorResponse(error);
		}
	});

export const Route = createFileRoute("/api/v1/selena/pilot/cycles/$cycleId/tasks/")({
	server: {
		handlers: {
			GET: async ({ request, params }) => pilotDisabledResponse() ?? listTasks(params.cycleId)({ request }),
		},
	},
});

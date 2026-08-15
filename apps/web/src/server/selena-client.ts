import { createServerFn } from "@tanstack/react-start";
import { db } from "@workspace/lib/db/db";
import { createSelenaRepositories } from "@workspace/lib/selena-visibility-repositories";
import { projectCreateSchema } from "@workspace/selena-visibility-contracts";
import { z } from "zod";
import { resolveSessionAuthContext } from "../lib/selena-auth-context";

const repositories = createSelenaRepositories(db);

export const listSelenaProjectsFn = createServerFn({ method: "GET" }).handler(async () => {
	const context = await resolveSessionAuthContext();
	return repositories.projects.list(context);
});

export const createSelenaProjectFn = createServerFn({ method: "POST" })
	.validator(projectCreateSchema)
	.handler(async ({ data }) => {
		const context = await resolveSessionAuthContext();
		return repositories.projects.create(context, { ...data, status: "DRAFT" });
	});

export const getSelenaProjectFn = createServerFn({ method: "GET" })
	.validator(z.object({ projectId: z.string().uuid() }))
	.handler(async ({ data }) => repositories.projects.get(await resolveSessionAuthContext(), data.projectId));

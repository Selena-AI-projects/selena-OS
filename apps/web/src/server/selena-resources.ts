import { createServerFn } from "@tanstack/react-start";
import { db } from "@workspace/lib/db/db";
import { createSelenaRepositories } from "@workspace/lib/selena-visibility-repositories";
import { z } from "zod";
import { resolveSessionAuthContext } from "../lib/selena-auth-context";

const repositories = createSelenaRepositories(db);
const uuid = z.string().uuid();

export const createSelenaPromptFamilyFn = createServerFn({ method: "POST" })
	.validator(z.object({ projectId: uuid, intentType: z.string().min(1), source: z.string().min(1) }))
	.handler(async ({ data }) =>
		repositories.families.create(await resolveSessionAuthContext(), { ...data, status: "PROPOSED" }),
	);
export const listSelenaPromptFamiliesFn = createServerFn({ method: "GET" })
	.validator(z.object({ projectId: uuid }))
	.handler(async ({ data }) => repositories.families.list(await resolveSessionAuthContext(), data.projectId));
export const createSelenaScenarioFn = createServerFn({ method: "POST" })
	.validator(z.object({ familyId: uuid, text: z.string().min(1), language: z.string().min(2) }))
	.handler(async ({ data }) =>
		repositories.scenarios.create(await resolveSessionAuthContext(), { ...data, status: "PROPOSED" }),
	);
export const listSelenaScenariosFn = createServerFn({ method: "GET" })
	.validator(z.object({ familyId: uuid }))
	.handler(async ({ data }) => repositories.scenarios.list(await resolveSessionAuthContext(), data.familyId));
export const createSelenaLockFn = createServerFn({ method: "POST" })
	.validator(
		z.object({
			projectId: uuid,
			version: z.number().int().positive(),
			snapshot: z.record(z.string(), z.unknown()),
			engineSha: z.string().min(1),
			expectedRuns: z.number().int().positive(),
			budgetCap: z.number().nonnegative(),
		}),
	)
	.handler(async ({ data }) => {
		const lock = await repositories.locks.create(await resolveSessionAuthContext(), {
			projectId: data.projectId,
			version: data.version,
			snapshot: data.snapshot,
			engineSha: data.engineSha,
			expectedRuns: data.expectedRuns,
			budgetCap: String(data.budgetCap),
		});
		if (!lock) throw new Error("Unable to create configuration lock");
		return Response.json({ ...lock, createdAt: lock.createdAt.toISOString() });
	});
export const listSelenaLocksFn = createServerFn({ method: "GET" })
	.validator(z.object({ projectId: uuid }))
	.handler(async ({ data }) => {
		const locks = await repositories.locks.list(await resolveSessionAuthContext(), data.projectId);
		return Response.json(locks.map((lock) => ({ ...lock, createdAt: lock.createdAt.toISOString() })));
	});
export const createSelenaCycleFn = createServerFn({ method: "POST" })
	.validator(z.object({ orderId: uuid, lockId: uuid, expectedRuns: z.number().int().positive() }))
	.handler(async ({ data }) =>
		repositories.cycles.create(await resolveSessionAuthContext(), {
			...data,
			status: "CREATED",
			createdRuns: 0,
			completedRuns: 0,
		}),
	);
export const listSelenaCyclesFn = createServerFn({ method: "GET" })
	.validator(z.object({ orderId: uuid }))
	.handler(async ({ data }) => repositories.cycles.list(await resolveSessionAuthContext(), data.orderId));

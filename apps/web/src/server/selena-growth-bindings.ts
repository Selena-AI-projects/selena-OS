/**
 * Owner-side management of Growth project bindings: which Aether project, from
 * which environment, may deliver materials into the brand in context.
 *
 * Both writes go through SECURITY DEFINER functions that re-check the owner
 * session inside the database, so this module carries no authorization logic
 * of its own beyond refusing early with a readable error.
 */
import { randomUUID } from "node:crypto";
import { createServerFn } from "@tanstack/react-start";
import { selenaWebDb as db } from "@workspace/lib/db/db";
import { scrGrowthProjectBindings } from "@workspace/lib/db/schema";
import { isInteractiveOwnerSession } from "@workspace/lib/selena-control-room";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { assertGrowthSourcesEnabled } from "../lib/growth-engine-stage1.server";
import { resolveSessionAuthContext } from "../lib/selena-auth-context.server";
import type { AuthContext } from "../lib/selena-authz";

export const GROWTH_SOURCE_ENVIRONMENTS = ["local", "staging", "production"] as const;

const brandSchema = z.object({ brandId: z.string().min(1) });
const confirmSchema = brandSchema.extend({
	aetherProjectId: z.string().uuid(),
	aetherBusinessKey: z.string().regex(/^[a-z_]{2,32}$/),
	sourceEnvironment: z.enum(GROWTH_SOURCE_ENVIRONMENTS),
});
const revokeSchema = brandSchema.extend({ bindingId: z.string().uuid(), reason: z.string().min(1).max(500) });

function assertOwner(context: AuthContext): void {
	// The database enforces this again; failing here only makes the refusal legible.
	if (!isInteractiveOwnerSession(context)) throw new Error("Only an interactive owner may manage growth bindings");
}

async function inBrandContext<T>(
	context: AuthContext,
	brandId: string,
	operation: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>,
): Promise<T> {
	return db.transaction(async (tx) => {
		await tx.execute(sql`
			SELECT selena_registry.set_request_context(
				${context.actorId}, ${context.tenantId}, ${brandId}, ${context.role},
				${randomUUID()}, ${"web"}, ${context.authType}
			)
		`);
		return operation(tx);
	});
}

export const listGrowthBindingsFn = createServerFn({ method: "GET" })
	.validator(brandSchema)
	.handler(async ({ data }) => {
		const context = await resolveSessionAuthContext();
		return inBrandContext(context, data.brandId, async (tx) => {
			const rows = await tx
				.select()
				.from(scrGrowthProjectBindings)
				.where(
					and(
						eq(scrGrowthProjectBindings.organizationId, context.tenantId),
						eq(scrGrowthProjectBindings.brandId, data.brandId),
					),
				)
				.orderBy(desc(scrGrowthProjectBindings.confirmedAt));
			return { bindings: rows };
		});
	});

export const confirmGrowthBindingFn = createServerFn({ method: "POST" })
	.validator(confirmSchema)
	.handler(async ({ data }) => {
		// The UI hides the form while the stage is off; the server function is reachable regardless.
		assertGrowthSourcesEnabled();
		const context = await resolveSessionAuthContext();
		assertOwner(context);
		return inBrandContext(context, data.brandId, async (tx) => {
			const result = await tx.execute(sql`
				SELECT selena_registry.confirm_growth_binding(
					${data.brandId}, ${data.aetherProjectId}::uuid, ${data.aetherBusinessKey}, ${data.sourceEnvironment}
				) AS id
			`);
			const row =
				(result as unknown as { rows?: Array<{ id: string }> }).rows?.[0] ??
				(result as unknown as Array<{ id: string }>)[0];
			return { bindingId: row?.id ?? null };
		});
	});

export const revokeGrowthBindingFn = createServerFn({ method: "POST" })
	.validator(revokeSchema)
	.handler(async ({ data }) => {
		assertGrowthSourcesEnabled();
		const context = await resolveSessionAuthContext();
		assertOwner(context);
		return inBrandContext(context, data.brandId, async (tx) => {
			await tx.execute(sql`SELECT selena_registry.revoke_growth_binding(${data.bindingId}::uuid, ${data.reason})`);
			return { revoked: true };
		});
	});

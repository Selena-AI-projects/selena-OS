/**
 * Owner-side management of a brand's content policy: which version is in force,
 * and withdrawing it.
 *
 * A policy is the precondition for anything the Control Room does with a draft,
 * and until now nothing created one — the table was read in three places and
 * written in none. Both writes go through SECURITY DEFINER functions that
 * re-check the owner session inside the database, so this module carries no
 * authorization of its own beyond refusing early with a readable error.
 */
import { randomUUID } from "node:crypto";
import { createServerFn } from "@tanstack/react-start";
import { selenaWebDb as db } from "@workspace/lib/db/db";
import { scrContentPolicies } from "@workspace/lib/db/schema";
import { isInteractiveOwnerSession } from "@workspace/lib/selena-control-room";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { resolveSessionAuthContext } from "../lib/selena-auth-context.server";
import type { AuthContext } from "../lib/selena-authz";

const brandSchema = z.object({ brandId: z.string().min(1) });
const setSchema = brandSchema.extend({
	policyVersion: z
		.string()
		.trim()
		.min(1)
		.max(64)
		.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Use letters, digits, dots, dashes or underscores"),
	requireEvidence: z.boolean(),
});
const revokeSchema = brandSchema.extend({
	policyId: z.string().uuid(),
	reason: z.string().trim().min(1).max(500),
});

function assertOwner(context: AuthContext): void {
	// The database enforces this again; failing here only makes the refusal legible.
	if (!isInteractiveOwnerSession(context)) throw new Error("Only an interactive owner may manage the content policy");
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

function firstRow<T>(result: unknown): T | undefined {
	return (result as { rows?: T[] }).rows?.[0] ?? (result as T[])[0];
}

/** Every version this brand has had, newest first, with the one in force marked. */
export const listContentPoliciesFn = createServerFn({ method: "GET" })
	.validator(brandSchema)
	.handler(async ({ data }) => {
		const context = await resolveSessionAuthContext();
		return inBrandContext(context, data.brandId, async (tx) => {
			const rows = await tx
				.select()
				.from(scrContentPolicies)
				.where(
					and(eq(scrContentPolicies.organizationId, context.tenantId), eq(scrContentPolicies.brandId, data.brandId)),
				)
				.orderBy(desc(scrContentPolicies.activatedAt));
			return { policies: rows, active: rows.find((row) => row.status === "active") ?? null };
		});
	});

export const setContentPolicyFn = createServerFn({ method: "POST" })
	.validator(setSchema)
	.handler(async ({ data }) => {
		const context = await resolveSessionAuthContext();
		assertOwner(context);
		return inBrandContext(context, data.brandId, async (tx) => {
			const result = await tx.execute(sql`
				SELECT selena_registry.set_content_policy(
					${data.brandId}, ${data.policyVersion}, ${data.requireEvidence}
				) AS id
			`);
			return { policyId: firstRow<{ id: string }>(result)?.id ?? null };
		});
	});

export const revokeContentPolicyFn = createServerFn({ method: "POST" })
	.validator(revokeSchema)
	.handler(async ({ data }) => {
		const context = await resolveSessionAuthContext();
		assertOwner(context);
		return inBrandContext(context, data.brandId, async (tx) => {
			await tx.execute(sql`SELECT selena_registry.revoke_content_policy(${data.policyId}::uuid, ${data.reason})`);
			return { revoked: true };
		});
	});

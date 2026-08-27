import { randomUUID } from "node:crypto";
import { selenaWebDb as db } from "@workspace/lib/db/db";
import { scrContentAssets, scrContentVersions } from "@workspace/lib/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { type AuthContext, canWrite } from "../lib/selena-authz";

type ControlRoomDatabase = Pick<typeof db, "execute" | "select">;

function assertWritable(context: AuthContext): void {
	if (!canWrite(context)) throw new Error("Forbidden: editor, publisher, or owner access required");
}

async function withControlRoomTransaction<T>(
	context: AuthContext,
	brandId: string,
	operation: (tx: ControlRoomDatabase) => Promise<T>,
	correlationId = randomUUID(),
): Promise<T> {
	return db.transaction(async (tx) => {
		await tx.execute(sql`
			SELECT selena_registry.set_request_context(
				${context.actorId},
				${context.tenantId},
				${brandId},
				${context.role},
			${correlationId},
			${"web"},
			${context.authType}
		)
	`);
		return operation(tx);
	});
}

export async function assertControlRoomContentVersionWriteAccess(
	context: AuthContext,
	brandId: string,
	contentVersionId: string,
): Promise<void> {
	assertWritable(context);
	await withControlRoomTransaction(context, brandId, async (tx) => {
		const rows = await tx
			.select({ id: scrContentVersions.id })
			.from(scrContentVersions)
			.where(
				and(
					eq(scrContentVersions.id, contentVersionId),
					eq(scrContentVersions.organizationId, context.tenantId),
					eq(scrContentVersions.brandId, brandId),
				),
			)
			.limit(1);
		if (rows.length !== 1) throw new Error("Content version is not available for this brand");
	});
}

export async function assertControlRoomAssetReadAccess(
	context: AuthContext,
	brandId: string,
	assetId: string,
): Promise<void> {
	await withControlRoomTransaction(context, brandId, async (tx) => {
		const rows = await tx
			.select({ id: scrContentAssets.id })
			.from(scrContentAssets)
			.where(
				and(
					eq(scrContentAssets.id, assetId),
					eq(scrContentAssets.organizationId, context.tenantId),
					eq(scrContentAssets.brandId, brandId),
				),
			)
			.limit(1);
		if (rows.length !== 1) throw new Error("Asset is not available for this brand");
	});
}

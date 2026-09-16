import { createHash } from "node:crypto";
import type { selenaWebDb } from "@workspace/lib/db/db";
import { sql } from "drizzle-orm";
import type { AuthContext } from "../lib/selena-authz";
import { type LocalRestaurant, prepareLocalOrder } from "../lib/selena-local-prepayment";
import type { LocalPrepaymentStore } from "./selena-local-prepayment-api";
import { retainedReportHash } from "./selena-local-retained-report";
import { createUniversalReportHandler, universalReportSchema } from "./selena-universal-report";

type Database = typeof selenaWebDb;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
const tables = {
	restaurants: "selena_registry.local_prepayment_restaurants",
	orders: "selena_registry.local_prepayment_orders",
	reports: "selena_registry.local_retained_reports",
} as const;

export function createLocalPrepaymentStore(database: Database): LocalPrepaymentStore {
	async function scoped<T>(auth: AuthContext, work: (tx: Transaction) => Promise<T>) {
		if (auth.authType !== "session") throw new Error("Forbidden: session required");
		return database.transaction(async (tx) => {
			await tx.execute(
				sql`select set_config('app.local_organization_id',${auth.tenantId},true), set_config('app.local_actor_id',${auth.actorId},true)`,
			);
			return work(tx);
		});
	}
	async function save(
		tx: Transaction,
		auth: AuthContext,
		kind: "restaurants" | "orders",
		key: string,
		input: unknown,
		make: () => Promise<unknown>,
	) {
		const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
		await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${auth.tenantId}:${kind}:${key}`},0))`);
		const table = sql.raw(tables[kind]);
		const old = await tx.execute<{ id: string; payload: unknown; request_hash: string; createdAt: string }>(sql`
			select id,payload,request_hash,created_at::text as "createdAt" from ${table}
			where organization_id=${auth.tenantId} and request_key=${key}`);
		const row = old.rows[0];
		if (row) {
			if (row.request_hash !== hash) throw new Error("IDEMPOTENCY_CONFLICT");
			return kind === "restaurants"
				? { id: row.id, details: row.payload }
				: { id: row.id, snapshot: row.payload, createdAt: row.createdAt };
		}
		const payload = await make();
		const created = await tx.execute<{ id: string; createdAt: string }>(sql`insert into ${table}
			(organization_id,created_by,request_key,request_hash,payload)
			values (${auth.tenantId},${auth.actorId},${key},${hash},${JSON.stringify(payload)}::jsonb)
			returning id,created_at::text as "createdAt"`);
		return kind === "restaurants"
			? { id: created.rows[0].id, details: payload }
			: { ...created.rows[0], snapshot: payload };
	}
	return {
		list: (auth, kind) =>
			scoped(auth, async (tx) => {
				if (kind === "reports")
					return (
						await tx.execute(sql`select id,title,created_at::text as "createdAt"
				from selena_registry.local_retained_reports where organization_id=${auth.tenantId} and revoked_at is null order by created_at desc,id limit 50`)
					).rows;
				const table = sql.raw(tables[kind]);
				return (
					await tx.execute<{
						id: string;
						payload: unknown;
						createdAt: string;
					}>(sql`select id,payload,created_at::text as "createdAt"
				from ${table} where organization_id=${auth.tenantId} order by created_at desc,id limit 50`)
				).rows.map((row) =>
					kind === "restaurants"
						? { id: row.id, details: row.payload }
						: { id: row.id, snapshot: row.payload, createdAt: row.createdAt },
				);
			}),
		createRestaurant: (auth, input, key) =>
			scoped(auth, (tx) => save(tx, auth, "restaurants", key, input, async () => input)),
		createOrder: (auth, input, key) =>
			scoped(auth, (tx) =>
				save(tx, auth, "orders", key, input, async () => {
					const rows = await tx.execute<{
						payload: LocalRestaurant["details"];
					}>(sql`select payload from selena_registry.local_prepayment_restaurants
				where id=${input.restaurantId}::uuid and organization_id=${auth.tenantId}`);
					if (!rows.rows[0]) throw new Error("NOT_FOUND");
					return prepareLocalOrder(input, rows.rows[0].payload);
				}),
			),
		readOrder: (auth, id) =>
			scoped(
				auth,
				async (tx) =>
					(
						await tx.execute(sql`select id,payload as snapshot,created_at::text as "createdAt"
			from selena_registry.local_prepayment_orders where id=${id}::uuid and organization_id=${auth.tenantId}`)
					).rows[0] ?? null,
			),
		readReport: async (auth, id, request) => {
			const row = await scoped(
				auth,
				async (tx) =>
					(
						await tx.execute<{ payload: unknown; content_hash: string }>(sql`
				select payload,content_hash from selena_registry.local_retained_reports where id=${id}::uuid
				and organization_id=${auth.tenantId} and revoked_at is null`)
					).rows[0],
			);
			const parsed = row ? universalReportSchema.parse(row.payload) : null;
			if (row && retainedReportHash(row.payload) !== row.content_hash) throw new Error("REPORT_HASH_MISMATCH");
			return createUniversalReportHandler({
				authenticate: async () => ({
					authType: "session",
					organizationId: auth.tenantId,
					projectId: parsed?.projectId ?? "missing",
				}),
				loadPublication: async () => parsed,
			})(request, id);
		},
	};
}

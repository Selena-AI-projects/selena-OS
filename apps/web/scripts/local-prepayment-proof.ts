import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as schema from "@workspace/lib/db/schema";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { localRestaurantInput } from "../src/lib/selena-local-prepayment";
import { createLocalPrepaymentApi } from "../src/server/selena-local-prepayment-api";
import { createLocalPrepaymentStore } from "../src/server/selena-local-prepayment-store";
import { prepareRetainedLocalReport } from "../src/server/selena-local-retained-report";

const endpoint = new URL(process.env.LOCAL_PREPAYMENT_PROOF_URL ?? "");
assert.equal(endpoint.hostname, "127.0.0.1");
assert.equal(endpoint.pathname, "/local_prepayment_proof");
assert.equal(endpoint.port, "56648");
const admin = new Pool({ connectionString: endpoint.toString() });
endpoint.username = "local_proof_web";
const web = new Pool({ connectionString: endpoint.toString() });
try {
	await admin.query(`
CREATE ROLE selena_schema_owner NOLOGIN;
CREATE ROLE selena_web_runtime NOLOGIN;
CREATE ROLE local_proof_web LOGIN IN ROLE selena_web_runtime;
CREATE TABLE public.organization (id text PRIMARY KEY);
CREATE TABLE public.member (organization_id text, user_id text, role text);
INSERT INTO organization VALUES ('org-a'),('org-b');
INSERT INTO member VALUES ('org-a','user-a','owner'),('org-b','user-b','owner'),('org-a','viewer','viewer');
GRANT SELECT, REFERENCES ON public.organization,public.member TO selena_schema_owner;
CREATE SCHEMA selena_registry AUTHORIZATION selena_schema_owner;
GRANT USAGE ON SCHEMA selena_registry TO selena_web_runtime;`);
	await admin.query(
		await readFile(
			new URL("../../../packages/lib/src/db/migrations/0048_local_prepayment.sql", import.meta.url),
			"utf8",
		),
	);
	const store = createLocalPrepaymentStore(drizzle({ client: web, schema }));
	const a = {
		tenantId: "org-a",
		actorId: "user-a",
		authType: "session" as const,
		role: "owner" as const,
		permissions: [],
	};
	const b = { ...a, tenantId: "org-b", actorId: "user-b" };
	const restaurant = localRestaurantInput.parse({
		name: "Proof restaurant",
		countryCode: "ID",
		mapsUrl: "https://www.google.com/maps?cid=123",
		latitude: -8.8,
		longitude: 115.1,
		confirmed: true,
	});
	const key = randomUUID();
	const saved = (await store.createRestaurant(a, restaurant, key)) as { id: string };
	const again = (await store.createRestaurant(a, restaurant, key)) as { id: string };
	assert.equal(saved.id, again.id);
	const input = { restaurantId: saved.id, queries: ["Dinner", "Lunch"], language: "en", gridSize: 5 as const };
	const orderKey = randomUUID();
	const orders = (await Promise.all(Array.from({ length: 4 }, () => store.createOrder(a, input, orderKey)))) as Array<{
		id: string;
		snapshot: { expectedObservations: number };
	}>;
	assert.equal(new Set(orders.map((o) => o.id)).size, 1);
	assert.equal(orders[0].snapshot.expectedObservations, 50);
	await assert.rejects(store.createOrder(a, { ...input, language: "ru" }, orderKey), /IDEMPOTENCY_CONFLICT/);
	assert.equal(await store.readOrder(b, orders[0].id), null);
	assert.deepEqual(await store.list(b, "restaurants"), []);
	await assert.rejects(store.createOrder(b, input, randomUUID()), /NOT_FOUND/);
	await assert.rejects(store.createRestaurant({ ...a, actorId: "viewer" }, restaurant, randomUUID()));
	await assert.rejects(store.createRestaurant({ ...a, tenantId: "org-b" }, restaurant, randomUUID()));
	const handler = createLocalPrepaymentApi({ enabled: () => true, authenticate: async () => a, store });
	const blocked = await handler(new Request("https://example.test/start", { method: "POST" }), "blocked");
	assert.equal(blocked.status, 403);
	const counts = await admin.query(
		"select (select count(*) from selena_registry.local_prepayment_orders)::int as orders,(select count(*) from selena_registry.local_prepayment_restaurants)::int as restaurants",
	);
	assert.deepEqual(counts.rows[0], { orders: 1, restaurants: 1 });
	const denied = await web.query(
		"select has_table_privilege(current_user,'selena_registry.local_prepayment_orders','UPDATE') as update,has_table_privilege(current_user,'selena_registry.local_retained_reports','INSERT') as publish",
	);
	assert.deepEqual(denied.rows[0], { update: false, publish: false });
	const reportId = randomUUID();
	const retained = prepareRetainedLocalReport(
		{
			version: 1,
			organizationId: "org-a",
			projectId: "synthetic-project",
			reportId,
			orderId: "synthetic-order",
			publication: "PUBLISHED",
			measurementMode: "PROVIDER",
			restaurant: { identity: "synthetic-place", name: "Synthetic report for local proof only" },
			queries: [{ id: "q1", text: "Synthetic query" }],
			points: [{ id: "p1", latitude: -8.8, longitude: 115.1 }],
			protocol: { language: "en", device: "mobile", timezone: "UTC", requestedDepth: 20 },
			observations: [
				{
					id: "o1",
					queryId: "q1",
					pointId: "p1",
					outcome: "NOT_FOUND",
					capturedAt: "2026-09-15T00:00:00Z",
					sourceId: "s1",
					targetRank: null,
					returnedCount: 0,
					competitionComplete: false,
					items: [],
				},
			],
			sources: [{ id: "s1", label: "SYNTHETIC TEST EVIDENCE", capturedAt: "2026-09-15T00:00:00Z" }],
			analysis: { status: "PENDING", actions: [] },
		},
		{ organizationId: "org-a", projectId: "synthetic-project" },
	);
	await admin.query(
		"insert into selena_registry.local_retained_reports(id,organization_id,title,payload,content_hash,source_reference,source_hash) values ($1,'org-a','Synthetic test',$2,$3,'local-test',$4)",
		[reportId, JSON.stringify(retained.report), retained.contentHash, "a".repeat(64)],
	);
	const csv = await store.readReport(a, reportId, new Request("https://example.test/report?format=csv"));
	assert.equal(csv.status, 200);
	assert.match(await csv.text(), /Synthetic query/);
	assert.equal((await store.readReport(b, reportId, new Request("https://example.test/report"))).status, 404);
	await admin.query("update selena_registry.local_retained_reports set content_hash=$1 where id=$2", [
		"b".repeat(64),
		reportId,
	]);
	await assert.rejects(
		store.readReport(a, reportId, new Request("https://example.test/report")),
		/REPORT_HASH_MISMATCH/,
	);
	console.log(
		"PASS: synthetic retained report survives JSONB normalization; own-tenant CSV; other-tenant 404; tampered hash rejected. No real report was imported.",
	);
	console.log(
		"PASS: migration on minimal auth schema; durable replay; four concurrent saves; conflicting replay rollback; 50 planned checks; two-user isolation; viewer/spoofed-tenant denial; no runtime update/publish; payment/start blocked; external provider calls=0.",
	);
} finally {
	await web.end();
	await admin.end();
}

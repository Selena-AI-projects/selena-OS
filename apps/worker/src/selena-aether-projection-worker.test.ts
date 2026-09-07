/**
 * The projection worker against a real, disposable, fully migrated Postgres,
 * connected as the registry worker login — not as a superuser — so the row level
 * security and the SECURITY DEFINER functions are what is under test.
 *
 * Skipped unless SELENA_DISPOSABLE_DATABASE_URL names a database that may be
 * written to and thrown away. The superuser connection seeds a synthetic
 * organization, brand, owner and policy, then the owner session confirms the
 * binding through the standard function; the worker never sees any of that.
 */
import { randomUUID } from "node:crypto";
import fixtures from "@workspace/lib/contracts/control-room-event.v1.1.fixtures.json" with { type: "json" };
import { acceptEvent, materialAggregateId, payloadHash } from "@workspace/lib/selena-aether-bridge";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectOnce } from "./selena-aether-projection-worker";
import { recordEvent } from "./selena-aether-receiver";

const adminUrl = process.env.SELENA_DISPOSABLE_DATABASE_URL;
const run = adminUrl ? describe : describe.skip;
const SUFFIX = randomUUID().slice(0, 8);
const ORG_A = `vitest-org-a-${SUFFIX}`;
const ORG_B = `vitest-org-b-${SUFFIX}`;
const BRAND_A = `vitest-brand-a-${SUFFIX}`;
const BRAND_B = `vitest-brand-b-${SUFFIX}`;
const OWNER_A = `vitest-owner-a-${SUFFIX}`;
const WORKER_LOGIN = `selena_vitest_worker_${SUFFIX}`;
const INGEST_LOGIN = `selena_vitest_ingest_${SUFFIX}`;
const WEB_LOGIN = `selena_vitest_web_${SUFFIX}`;
const PASSWORD = `pw-${randomUUID()}`;

const accepted = (name: string) => {
	const entry = fixtures.cases.find((c) => c.name === name);
	if (!entry) throw new Error(`fixture ${name} missing`);
	return acceptEvent(
		entry.body,
		{ signature: entry.signature, timestamp: entry.timestamp },
		[fixtures.secret],
		new Date(Date.parse(entry.timestamp)),
	).envelope;
};
// The published fixtures name one fixed project and fixed event ids. A database
// reused from an earlier run would already hold that project's binding and those
// events, so every run addresses a project of its own, as the sender would.
const PROJECT_ID = randomUUID();
function ownProject<
	T extends {
		project_id: string;
		aggregate_id: string;
		event_id: string;
		payload: { brief_ref: string; content_kind: string };
	},
>(envelope: T): T {
	return {
		...envelope,
		event_id: randomUUID(),
		project_id: PROJECT_ID,
		aggregate_id: materialAggregateId(PROJECT_ID, envelope.payload.brief_ref, envelope.payload.content_kind),
	};
}
const article = ownProject(accepted("accepted_article"));
const social = ownProject(accepted("accepted_social"));

function loginUrl(login: string): string {
	const url = new URL(adminUrl as string);
	url.username = login;
	url.password = PASSWORD;
	return url.toString();
}

run("projecting materials as the registry worker", () => {
	let admin: Pool;
	let worker: Pool;
	let ingest: Pool;
	let web: Pool;

	async function asOwner<T>(brandId: string, orgId: string, task: (client: PoolClient) => Promise<T>): Promise<T> {
		const client = await web.connect();
		try {
			await client.query("BEGIN");
			await client.query("SELECT selena_registry.set_request_context($1, $2, $3, 'owner', $4, 'web', 'session')", [
				OWNER_A,
				orgId,
				brandId,
				randomUUID(),
			]);
			const result = await task(client);
			await client.query("COMMIT");
			return result;
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	async function receive(envelope: typeof article) {
		const client = await ingest.connect();
		try {
			return await recordEvent(client, envelope);
		} finally {
			client.release();
		}
	}

	async function countRows(sql: string, params: unknown[] = []): Promise<number> {
		const result = await admin.query<{ n: string }>(sql, params);
		return Number(result.rows[0]?.n ?? 0);
	}

	beforeAll(async () => {
		admin = new Pool({ connectionString: adminUrl });
		// The worker claims the oldest claimable event in the whole inbox, so events
		// left behind by an earlier run on this disposable database would be answered
		// before the ones this run records.
		await admin.query("DELETE FROM selena_ingest_raw.aether_events");
		for (const [login, group] of [
			[WORKER_LOGIN, "selena_registry_worker_runtime"],
			[INGEST_LOGIN, "selena_ingestion_runtime"],
			[WEB_LOGIN, "selena_web_runtime"],
		]) {
			await admin.query(`CREATE ROLE ${login} LOGIN PASSWORD '${PASSWORD}' NOINHERIT IN ROLE ${group}`);
			await admin.query(`ALTER ROLE ${login} SET ROLE ${group}`);
		}
		await admin.query(
			`INSERT INTO public."user" (id, name, email, email_verified, created_at, updated_at)
			 VALUES ($1, 'vitest owner', $2, true, now(), now())`,
			[OWNER_A, `${OWNER_A}@example.invalid`],
		);
		await admin.query(
			"INSERT INTO public.organization (id, name, slug, created_at) VALUES ($1, $1, $1, now()), ($2, $2, $2, now())",
			[ORG_A, ORG_B],
		);
		await admin.query(
			"INSERT INTO public.member (id, organization_id, user_id, role, created_at) VALUES ($1, $2, $3, 'owner', now())",
			[`m-${SUFFIX}`, ORG_A, OWNER_A],
		);
		await admin.query(
			"INSERT INTO public.brands (id, name, website, organization_id) VALUES ($1, $1, 'https://a.example.invalid', $2), ($3, $3, 'https://b.example.invalid', $4)",
			[BRAND_A, ORG_A, BRAND_B, ORG_B],
		);
		worker = new Pool({ connectionString: loginUrl(WORKER_LOGIN) });
		ingest = new Pool({ connectionString: loginUrl(INGEST_LOGIN) });
		web = new Pool({ connectionString: loginUrl(WEB_LOGIN) });
		// The policy the projection stamps on every version is created the way the
		// product creates it: by the owner, through the web runtime, under RLS.
		await asOwner(BRAND_A, ORG_A, (client) =>
			client.query("SELECT selena_registry.set_content_policy($1, 'vitest-policy-1', false)", [BRAND_A]),
		);
	});

	afterAll(async () => {
		await worker?.end();
		await ingest?.end();
		await web?.end();
		for (const login of [WORKER_LOGIN, INGEST_LOGIN, WEB_LOGIN]) {
			await admin.query(`DROP OWNED BY ${login}`).catch(() => undefined);
			await admin.query(`DROP ROLE IF EXISTS ${login}`).catch(() => undefined);
		}
		await admin.end();
	});

	it("connects as the restricted logins, not as a superuser", async () => {
		const who = await worker.query<{ session_user: string; current_user: string }>("SELECT session_user, current_user");
		expect(who.rows[0]).toEqual({ session_user: WORKER_LOGIN, current_user: "selena_registry_worker_runtime" });
		const rolsuper = await admin.query<{ rolsuper: boolean }>("SELECT rolsuper FROM pg_roles WHERE rolname = $1", [
			WORKER_LOGIN,
		]);
		expect(rolsuper.rows[0]?.rolsuper).toBe(false);
	});

	it("defers a material whose project has no binding yet, without writing anything", async () => {
		expect(await receive(article)).toBe("recorded");
		const outcome = await projectOnce(worker, "local");
		expect(outcome).toMatchObject({ kind: "deferred", eventId: article.event_id, code: "NO_BINDING" });
		expect(
			await countRows("SELECT count(*) AS n FROM selena_registry.content_versions WHERE brand_id = $1", [BRAND_A]),
		).toBe(0);
		// Until the next attempt is due the event is not picked up again.
		expect(await projectOnce(worker, "local")).toEqual({ kind: "idle" });
	});

	it("projects both materials of one brief into two cards once the owner has bound the project", async () => {
		await asOwner(BRAND_A, ORG_A, (client) =>
			client.query("SELECT selena_registry.confirm_growth_binding($1, $2::uuid, 'selena', 'local')", [
				BRAND_A,
				PROJECT_ID,
			]),
		);
		// The clock, stood in for by the superuser: the deferred article is due again.
		await admin.query("UPDATE selena_ingest_raw.aether_events SET projection_next_attempt_at = now()");
		expect(await receive(social)).toBe("recorded");

		const first = await projectOnce(worker, "local");
		const second = await projectOnce(worker, "local");
		expect([first.kind, second.kind]).toEqual(["projected", "projected"]);
		expect(await projectOnce(worker, "local")).toEqual({ kind: "idle" });

		const items = await admin.query<{ kind: string; external_ref: string; brief_ref: string }>(
			"SELECT kind, external_ref, brief_ref FROM selena_registry.content_items WHERE brand_id = $1 ORDER BY kind",
			[BRAND_A],
		);
		expect(items.rows.map((r) => r.kind)).toEqual(["ARTICLE", "SOCIAL_ADAPTATION"]);
		expect(new Set(items.rows.map((r) => r.brief_ref)).size).toBe(1);
		expect(items.rows.map((r) => r.external_ref).sort()).toEqual([article.aggregate_id, social.aggregate_id].sort());
		expect(
			await countRows("SELECT count(*) AS n FROM selena_registry.content_versions WHERE brand_id = $1", [BRAND_A]),
		).toBe(2);
		const versions = await admin.query<{ version: number; cta_url: string; disclosure: { synthetic: boolean } }>(
			"SELECT version, cta_url, disclosure FROM selena_registry.content_versions WHERE brand_id = $1 ORDER BY version",
			[BRAND_A],
		);
		expect(versions.rows.map((r) => r.version)).toEqual([1, 1]);
		expect(versions.rows.every((r) => r.disclosure.synthetic === true)).toBe(true);
		expect(versions.rows.every((r) => r.cta_url === "https://www.selenasystems.com/visibility")).toBe(true);
		expect(
			await countRows(
				"SELECT count(*) AS n FROM selena_audit.audit_events WHERE brand_id = $1 AND action = 'content.draft_received'",
				[BRAND_A],
			),
		).toBe(2);
	});

	it("does not add a card or a version on redelivery or on a repeated worker pass", async () => {
		expect(await receive(social)).toBe("duplicate");
		expect(await receive({ ...social, event_id: randomUUID() })).toBe("duplicate");
		expect(await projectOnce(worker, "local")).toEqual({ kind: "idle" });
		expect(
			await countRows("SELECT count(*) AS n FROM selena_registry.content_items WHERE brand_id = $1", [BRAND_A]),
		).toBe(2);
		expect(
			await countRows("SELECT count(*) AS n FROM selena_registry.content_versions WHERE brand_id = $1", [BRAND_A]),
		).toBe(2);
	});

	it("refuses the same version with different content as a conflict", async () => {
		const tampered = { ...social, event_id: randomUUID(), payload: { ...social.payload, title: "другой заголовок" } };
		tampered.payload_hash = payloadHash(tampered.payload);
		await expect(receive(tampered)).rejects.toMatchObject({ name: "RecordConflict" });
	});

	it("gives the article a new version without touching the social adaptation", async () => {
		const articleV2 = {
			...article,
			event_id: randomUUID(),
			version: 2,
			payload: { ...article.payload, title: "Редакция 2" },
		};
		articleV2.payload_hash = payloadHash(articleV2.payload);
		expect(await receive(articleV2)).toBe("recorded");
		expect((await projectOnce(worker, "local")).kind).toBe("projected");
		const versions = await admin.query<{ kind: string; version: number }>(
			`SELECT i.kind, v.version FROM selena_registry.content_versions v
			 JOIN selena_registry.content_items i ON i.id = v.content_id WHERE v.brand_id = $1 ORDER BY i.kind, v.version`,
			[BRAND_A],
		);
		expect(versions.rows).toEqual([
			{ kind: "ARTICLE", version: 1 },
			{ kind: "ARTICLE", version: 2 },
			{ kind: "SOCIAL_ADAPTATION", version: 1 },
		]);
		expect(
			await countRows("SELECT count(*) AS n FROM selena_registry.content_items WHERE brand_id = $1", [BRAND_A]),
		).toBe(2);
	});

	it("refuses a material whose business key disagrees with the owner's binding", async () => {
		const other = {
			...article,
			event_id: randomUUID(),
			version: 3,
			payload: { ...article.payload, business_key: "kora" },
		};
		other.payload_hash = payloadHash(other.payload);
		expect(await receive(other)).toBe("recorded");
		expect(await projectOnce(worker, "local")).toEqual({
			kind: "refused",
			eventId: other.event_id,
			code: "BUSINESS_KEY_MISMATCH",
		});
	});

	it("never projects into another organization's brand and stops when the binding is revoked", async () => {
		// A second project bound to brand A in staging must not resolve for local.
		const stagingOnly = { ...article, event_id: randomUUID(), project_id: randomUUID(), version: 1 };
		stagingOnly.aggregate_id = materialAggregateId(stagingOnly.project_id, stagingOnly.payload.brief_ref, "ARTICLE");
		await asOwner(BRAND_A, ORG_A, (client) =>
			client.query("SELECT selena_registry.confirm_growth_binding($1, $2::uuid, 'selena', 'staging')", [
				BRAND_A,
				stagingOnly.project_id,
			]),
		);
		expect(await receive(stagingOnly)).toBe("recorded");
		expect(await projectOnce(worker, "local")).toMatchObject({ kind: "deferred", code: "NO_BINDING" });
		expect(
			await countRows("SELECT count(*) AS n FROM selena_registry.content_items WHERE brand_id = $1", [BRAND_B]),
		).toBe(0);

		await asOwner(BRAND_A, ORG_A, (client) =>
			client.query(
				"SELECT selena_registry.revoke_growth_binding((SELECT id FROM selena_registry.growth_project_bindings WHERE brand_id = $1 AND aether_project_id = $2::uuid AND revoked_at IS NULL), 'vitest revoke')",
				[BRAND_A, PROJECT_ID],
			),
		);
		const afterRevoke = { ...article, event_id: randomUUID(), version: 4 };
		expect(await receive(afterRevoke)).toBe("recorded");
		expect(await projectOnce(worker, "local")).toMatchObject({
			kind: "deferred",
			eventId: afterRevoke.event_id,
			code: "NO_BINDING",
		});
		expect(
			await countRows("SELECT count(*) AS n FROM selena_registry.content_versions WHERE brand_id = $1", [BRAND_A]),
		).toBe(3);
	});

	it("defers a material for a bound brand that has no content policy yet", async () => {
		const BRAND_C = `vitest-brand-c-${SUFFIX}`;
		await admin.query(
			"INSERT INTO public.brands (id, name, website, organization_id) VALUES ($1, $1, 'https://c.example.invalid', $2)",
			[BRAND_C, ORG_A],
		);
		const unpoliced = { ...article, event_id: randomUUID(), project_id: randomUUID(), version: 1 };
		unpoliced.aggregate_id = materialAggregateId(unpoliced.project_id, unpoliced.payload.brief_ref, "ARTICLE");
		await asOwner(BRAND_C, ORG_A, (client) =>
			client.query("SELECT selena_registry.confirm_growth_binding($1, $2::uuid, 'selena', 'local')", [
				BRAND_C,
				unpoliced.project_id,
			]),
		);
		expect(await receive(unpoliced)).toBe("recorded");
		expect(await projectOnce(worker, "local")).toMatchObject({
			kind: "deferred",
			eventId: unpoliced.event_id,
			code: "NO_CONTENT_POLICY",
		});
		expect(
			await countRows("SELECT count(*) AS n FROM selena_registry.content_versions WHERE brand_id = $1", [BRAND_C]),
		).toBe(0);
		expect(await projectOnce(worker, "local")).toEqual({ kind: "idle" });
	});

	it("waits while the brand's policy is withdrawn and stamps the one set afterwards", async () => {
		const BRAND_D = `vitest-brand-d-${SUFFIX}`;
		await admin.query(
			"INSERT INTO public.brands (id, name, website, organization_id) VALUES ($1, $1, 'https://d.example.invalid', $2)",
			[BRAND_D, ORG_A],
		);
		const draft = { ...article, event_id: randomUUID(), project_id: randomUUID(), version: 1 };
		draft.aggregate_id = materialAggregateId(draft.project_id, draft.payload.brief_ref, "ARTICLE");
		await asOwner(BRAND_D, ORG_A, async (client) => {
			await client.query("SELECT selena_registry.confirm_growth_binding($1, $2::uuid, 'selena', 'local')", [
				BRAND_D,
				draft.project_id,
			]);
			const set = await client.query<{ id: string }>(
				"SELECT selena_registry.set_content_policy($1, 'withdrawn-1', false) AS id",
				[BRAND_D],
			);
			await client.query("SELECT selena_registry.revoke_content_policy($1::uuid, 'lifecycle test')", [set.rows[0].id]);
		});
		expect(await receive(draft)).toBe("recorded");
		// A withdrawn policy is kept for what was approved under it, never applied to new drafts.
		expect(await projectOnce(worker, "local")).toMatchObject({
			kind: "deferred",
			eventId: draft.event_id,
			code: "NO_CONTENT_POLICY",
		});
		expect(
			await countRows("SELECT count(*) AS n FROM selena_registry.content_versions WHERE brand_id = $1", [BRAND_D]),
		).toBe(0);

		await asOwner(BRAND_D, ORG_A, (client) =>
			client.query("SELECT selena_registry.set_content_policy($1, 'in-force-2', false)", [BRAND_D]),
		);
		await admin.query(
			"UPDATE selena_ingest_raw.aether_events SET projection_next_attempt_at = now() WHERE event_id = $1::uuid",
			[draft.event_id],
		);
		expect(await projectOnce(worker, "local")).toMatchObject({ kind: "projected", eventId: draft.event_id });
		const stamped = await admin.query<{ policy_version: string }>(
			"SELECT policy_version FROM selena_registry.content_versions WHERE brand_id = $1",
			[BRAND_D],
		);
		expect(stamped.rows.map((row) => row.policy_version)).toEqual(["in-force-2"]);
	});

	it("leaves the worker unable to read bindings, approvals or manifests directly", async () => {
		await expect(worker.query("SELECT * FROM selena_registry.growth_project_bindings")).rejects.toMatchObject({
			code: "42501",
		});
		await expect(worker.query("SELECT * FROM selena_registry.approvals")).rejects.toMatchObject({ code: "42501" });
		await expect(worker.query("SELECT signature FROM selena_release.release_manifests")).rejects.toMatchObject({
			code: "42501",
		});
	});
});

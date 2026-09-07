import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const disposableDatabaseUrl = process.env.SELENA_DISPOSABLE_DATABASE_URL;

/**
 * A brand's content policy, exercised the way the product reaches it: through
 * the web runtime role, under a request context, with row level security on.
 * Running these as a superuser would prove nothing — the checks being tested
 * are the ones a superuser bypasses.
 */
describe.skipIf(!disposableDatabaseUrl)("content policy lifecycle", () => {
	const suffix = randomUUID().slice(0, 8);
	const organizationId = `policy-org-${suffix}`;
	const brandId = `policy-brand-${suffix}`;
	const otherOrganizationId = `policy-other-org-${suffix}`;
	const otherBrandId = `policy-other-brand-${suffix}`;
	const ownerId = `policy-owner-${suffix}`;
	const memberId = `policy-member-${suffix}`;
	const loginName = `policy_web_login_${suffix.replace(/-/g, "")}`;
	const loginPassword = randomUUID();
	let root: Client;
	let web: Client;

	beforeAll(async () => {
		if (!disposableDatabaseUrl) throw new Error("disposable database URL is required");
		root = new Client({ connectionString: disposableDatabaseUrl });
		await root.connect();
		await root.query(
			`INSERT INTO public."user" (id, name, email, created_at, updated_at)
			 VALUES ($1, 'Policy Owner', $2, now(), now()), ($3, 'Policy Member', $4, now(), now())`,
			[ownerId, `${ownerId}@example.test`, memberId, `${memberId}@example.test`],
		);
		await root.query(
			`INSERT INTO public.organization (id, name, slug, created_at)
			 VALUES ($1, 'Policy Organization', $1, now()), ($2, 'Other Organization', $2, now())`,
			[organizationId, otherOrganizationId],
		);
		await root.query(
			`INSERT INTO public.member (id, organization_id, user_id, role, created_at)
			 VALUES ($1, $2, $3, 'owner', now()), ($4, $2, $5, 'member', now())`,
			[`policy-owner-m-${suffix}`, organizationId, ownerId, `policy-member-m-${suffix}`, memberId],
		);
		await root.query(
			`INSERT INTO public.brands (id, name, website, organization_id)
			 VALUES ($1, 'Policy Brand', 'https://policy.example.test', $2),
			        ($3, 'Other Brand', 'https://other.example.test', $4)`,
			[brandId, organizationId, otherBrandId, otherOrganizationId],
		);
		await root.query(`CREATE ROLE ${loginName} LOGIN PASSWORD '${loginPassword}' IN ROLE selena_web_runtime`);

		const url = new URL(disposableDatabaseUrl);
		url.username = loginName;
		url.password = loginPassword;
		web = new Client({ connectionString: url.toString() });
		await web.connect();
		await web.query("SET ROLE selena_web_runtime");
	});

	afterAll(async () => {
		await web?.end();
		await root?.query(`DROP ROLE IF EXISTS ${loginName}`).catch(() => undefined);
		await root?.end();
	});

	/**
	 * The request context is transaction-local, so everything a caller does under
	 * one identity has to happen inside one transaction — which is also how the
	 * application reaches it.
	 */
	async function inContext<T>(
		actorId: string,
		role: string,
		brand: string,
		organization: string,
		operation: () => Promise<T>,
	): Promise<T> {
		await web.query("BEGIN");
		try {
			await web.query("SELECT selena_registry.set_request_context($1, $2, $3, $4, $5::uuid, $6, $7)", [
				actorId,
				organization,
				brand,
				role,
				randomUUID(),
				"web",
				"session",
			]);
			const result = await operation();
			await web.query("COMMIT");
			return result;
		} catch (error) {
			await web.query("ROLLBACK");
			throw error;
		}
	}

	it("puts one version in force, keeps the ones before it, and audits both", async () => {
		const { firstId, secondId } = await inContext(ownerId, "owner", brandId, organizationId, async () => {
			const first = await web.query("SELECT selena_registry.set_content_policy($1, $2, $3) AS id", [
				brandId,
				"2026-09-a",
				true,
			]);
			// Asking again for what is already in force is not a new version.
			const repeat = await web.query("SELECT selena_registry.set_content_policy($1, $2, $3) AS id", [
				brandId,
				"2026-09-a",
				true,
			]);
			expect(repeat.rows[0].id).toBe(first.rows[0].id);
			const second = await web.query("SELECT selena_registry.set_content_policy($1, $2, $3) AS id", [
				brandId,
				"2026-09-b",
				false,
			]);
			return { firstId: first.rows[0].id as string, secondId: second.rows[0].id as string };
		});
		expect(firstId).toBeTruthy();
		expect(secondId).not.toBe(firstId);

		const rows = await root.query(
			// Both versions were set in one transaction, so they share activated_at;
			// the superseded one is the one that has been withdrawn.
			`SELECT id, policy_version, status, require_evidence, revoked_reason
			   FROM selena_registry.content_policies WHERE brand_id = $1
			  ORDER BY activated_at, revoked_at NULLS LAST`,
			[brandId],
		);
		expect(rows.rows).toHaveLength(2);
		expect(rows.rows[0]).toMatchObject({ id: firstId, status: "revoked", policy_version: "2026-09-a" });
		expect(rows.rows[0].revoked_reason).toContain("2026-09-b");
		expect(rows.rows[1]).toMatchObject({ id: secondId, status: "active", require_evidence: false });

		const audit = await root.query(
			`SELECT action, metadata FROM selena_audit.audit_events
			  WHERE organization_id = $1 AND brand_id = $2 AND action LIKE 'content.policy%'
			  ORDER BY created_at, id`,
			[organizationId, brandId],
		);
		// One transaction, one created_at for all three rows, so the order is not
		// observable here; what is, is which decisions were recorded and about what.
		expect(audit.rows.map((row) => row.action).sort()).toEqual([
			"content.policy_set",
			"content.policy_set",
			"content.policy_superseded",
		]);
		expect(
			audit.rows.find((row) => row.action === "content.policy_set" && row.metadata?.policyVersion === "2026-09-a")
				?.metadata,
		).toMatchObject({ policyVersion: "2026-09-a", requireEvidence: true });
	});

	it("never reinstates a withdrawn version", async () => {
		await expect(
			inContext(ownerId, "owner", brandId, organizationId, () =>
				web.query("SELECT selena_registry.set_content_policy($1, $2, $3)", [brandId, "2026-09-a", true]),
			),
		).rejects.toThrow(/already exists/);
	});

	it("withdraws only with a reason, and leaves the brand with none in force", async () => {
		const active = await root.query(
			"SELECT id FROM selena_registry.content_policies WHERE brand_id = $1 AND status = 'active'",
			[brandId],
		);
		const activeId = active.rows[0].id as string;
		await expect(
			inContext(ownerId, "owner", brandId, organizationId, () =>
				web.query("SELECT selena_registry.revoke_content_policy($1::uuid, $2)", [activeId, "   "]),
			),
		).rejects.toThrow(/needs a reason/);
		await inContext(ownerId, "owner", brandId, organizationId, () =>
			web.query("SELECT selena_registry.revoke_content_policy($1::uuid, $2)", [activeId, "withdrawn for the test"]),
		);
		const remaining = await root.query(
			"SELECT count(*)::int AS n FROM selena_registry.content_policies WHERE brand_id = $1 AND status = 'active'",
			[brandId],
		);
		expect(remaining.rows[0].n).toBe(0);
	});

	it("refuses a member of the same organization", async () => {
		await expect(
			inContext(memberId, "member", brandId, organizationId, () =>
				web.query("SELECT selena_registry.set_content_policy($1, $2, $3)", [brandId, "2026-09-c", true]),
			),
		).rejects.toThrow(/interactive owner/);
	});

	it("refuses another organization's brand before the policy call is even reached", async () => {
		// The request context itself rejects a brand outside the actor's organization.
		await expect(
			inContext(ownerId, "owner", otherBrandId, organizationId, () =>
				web.query("SELECT selena_registry.set_content_policy($1, $2, $3)", [otherBrandId, "2026-09-d", true]),
			),
		).rejects.toThrow(/membership or role context is invalid/);
		const leaked = await root.query(
			"SELECT count(*)::int AS n FROM selena_registry.content_policies WHERE brand_id = $1",
			[otherBrandId],
		);
		expect(leaked.rows[0].n).toBe(0);
	});
});

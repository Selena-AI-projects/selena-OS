import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const disposableDatabaseUrl = process.env.SELENA_DISPOSABLE_DATABASE_URL;

/**
 * What separates a local install that grew into a team from one anybody can
 * join. Once the first account exists, an address gets in only while an
 * invitation for it is outstanding, so every way an invitation stops being
 * outstanding — spent, called off, run out — has to close the door again.
 * These are the cases a signup form cannot be asked to enforce.
 */
describe.skipIf(!disposableDatabaseUrl)("an invitation is what admits a second account", () => {
	const suffix = randomUUID().slice(0, 8);
	const organizationId = `invite-org-${suffix}`;
	const inviterId = `invite-owner-${suffix}`;
	let root: Client;
	let hasPendingInvitation: (email: string) => Promise<boolean>;
	let hasOrganization: () => Promise<boolean>;

	const hourFromNow = () => new Date(Date.now() + 60 * 60 * 1000);
	const hourAgo = () => new Date(Date.now() - 60 * 60 * 1000);

	async function invite(input: { email: string; status?: string; expiresAt?: Date }): Promise<void> {
		await root.query(
			`INSERT INTO "invitation" (id, organization_id, email, role, status, expires_at, inviter_id)
			 VALUES ($1, $2, $3, 'member', $4, $5, $6)`,
			[
				randomUUID(),
				organizationId,
				input.email,
				input.status ?? "pending",
				input.expiresAt ?? hourFromNow(),
				inviterId,
			],
		);
	}

	beforeAll(async () => {
		if (!disposableDatabaseUrl) throw new Error("disposable database URL is required");
		process.env.DATABASE_URL = disposableDatabaseUrl;
		process.env.SELENA_WEB_DATABASE_URL ??= disposableDatabaseUrl;
		({ hasOrganization, hasPendingInvitation } = await import("./provisioning"));

		root = new Client({ connectionString: disposableDatabaseUrl });
		await root.connect();
		await root.query(`INSERT INTO "organization" (id, name, slug, created_at) VALUES ($1, $1, $1, now())`, [
			organizationId,
		]);
		await root.query(
			`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
			 VALUES ($1, 'Owner', $2, true, now(), now())`,
			[inviterId, `owner-${suffix}@example.test`],
		);
	});

	afterAll(async () => {
		if (!root) return;
		await root.query(`DELETE FROM "invitation" WHERE organization_id = $1`, [organizationId]);
		await root.query(`DELETE FROM "user" WHERE id = $1`, [inviterId]);
		await root.query(`DELETE FROM "organization" WHERE id = $1`, [organizationId]);
		await root.end();
	});

	it("reports the install as bootstrapped once an organization exists", async () => {
		await expect(hasOrganization()).resolves.toBe(true);
	});

	it("turns away an address nobody invited", async () => {
		await expect(hasPendingInvitation(`stranger-${suffix}@example.test`)).resolves.toBe(false);
	});

	it("admits an address with an outstanding invitation", async () => {
		const email = `invited-${suffix}@example.test`;
		await invite({ email });
		await expect(hasPendingInvitation(email)).resolves.toBe(true);
	});

	it("admits it however the address is capitalised, because acceptance matches that way too", async () => {
		const email = `Mixed.Case-${suffix}@Example.Test`;
		await invite({ email });
		await expect(hasPendingInvitation(email.toLowerCase())).resolves.toBe(true);
		await expect(hasPendingInvitation(email.toUpperCase())).resolves.toBe(true);
	});

	it("turns away an address whose invitation has run out", async () => {
		const email = `expired-${suffix}@example.test`;
		await invite({ email, expiresAt: hourAgo() });
		await expect(hasPendingInvitation(email)).resolves.toBe(false);
	});

	it("turns away an address whose invitation was already spent", async () => {
		const email = `accepted-${suffix}@example.test`;
		await invite({ email, status: "accepted" });
		await expect(hasPendingInvitation(email)).resolves.toBe(false);
	});

	it("turns away an address whose invitation was called off", async () => {
		const email = `cancelled-${suffix}@example.test`;
		await invite({ email, status: "canceled" });
		await expect(hasPendingInvitation(email)).resolves.toBe(false);
	});

	it("keeps admitting an address that also has a spent invitation, since the outstanding one still stands", async () => {
		const email = `repeat-${suffix}@example.test`;
		await invite({ email, status: "canceled" });
		await invite({ email });
		await expect(hasPendingInvitation(email)).resolves.toBe(true);
	});
});

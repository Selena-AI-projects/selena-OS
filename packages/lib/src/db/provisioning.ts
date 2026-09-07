/**
 * User / org / membership provisioning.
 *
 * Single place where "create a new user with an org and admin membership"
 * happens for local mode. Demo deployments reuse a database populated by
 * running the stack in local mode first, so there is no separate demo
 * provisioning path — the public demo box is just a read-only view over
 * that already-bootstrapped data.
 *
 * `provisionLocalOrg` is one-shot: it runs for the account that
 * bootstraps an install and for no other. Everyone who joins afterwards
 * arrives through an invitation, and better-auth writes their membership
 * with the invited role when they accept it. The SQL is plain INSERTs (no
 * upsert, no existence checks) to make that intent obvious — a second
 * call is a bug and should fail at the database layer rather than
 * silently rewriting rows, or hand a colleague admin rights nobody
 * granted them.
 */
import { and, count, eq, gt, sql } from "drizzle-orm";
import { db } from "./db";
import { brands, invitation, member, organization, user } from "./schema";

/**
 * The db handle or an open transaction — lets a provisioning step join a
 * caller's transaction so a later failure rolls its writes back too.
 */
export type DbConnection = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Number of users in the database.
 *
 * Used by the local-mode signup guard — "allow the first signup, reject
 * every subsequent one". Kept as its own small function so the hook
 * doesn't import drizzle directly.
 */
export async function countUsers(): Promise<number> {
	const [row] = await db.select({ count: count() }).from(user);
	return row?.count ?? 0;
}

/**
 * Whether an owner has already invited this address to an organization.
 *
 * This is what widens local mode from one account to a team without
 * opening registration: an address nobody invited still cannot create an
 * account. The comparison is case-insensitive because better-auth accepts
 * an invitation by matching the session email that way, so a stricter
 * check here would admit signups that could never accept anything.
 */
export async function hasPendingInvitation(email: string): Promise<boolean> {
	const [row] = await db
		.select({ id: invitation.id })
		.from(invitation)
		.where(
			and(
				sql`lower(${invitation.email}) = lower(${email})`,
				eq(invitation.status, "pending"),
				gt(invitation.expiresAt, new Date()),
			),
		)
		.limit(1);
	return row !== undefined;
}

/**
 * Whether this install has been bootstrapped yet.
 *
 * Sharper than counting users for deciding who owns an install: the
 * bootstrapping account is the one that arrives before any organization
 * exists. An invited colleague joins an install that already has one, and
 * an install left holding accounts but no organization would have no
 * workspace to show any of them.
 */
export async function hasOrganization(): Promise<boolean> {
	const [row] = await db.select({ id: organization.id }).from(organization).limit(1);
	return row !== undefined;
}

/**
 * The single organization created in local mode.
 *
 * Hardcoded because local mode has exactly one org per install, the user
 * never sees or interacts with this identity (they pick a brand in the
 * onboarding wizard, which is what the UI actually surfaces), and a
 * stable id makes URLs like `/app/default` predictable.
 */
const LOCAL_ORG = {
	id: "default",
	name: "Default",
	slug: "default",
} as const;

const SELENA_STAGING_ORG = {
	id: "default",
	name: "Selena Systems",
	slug: "selena-systems",
} as const;

export function isSelenaStagingMvp(env: Record<string, string | undefined> = process.env): boolean {
	return env.SELENA_STAGING_MVP === "true";
}

/**
 * Create the organization + admin membership for a freshly-created
 * local-mode user. Called from the better-auth `user.create.after`
 * database hook so the user always lands in exactly one org with admin
 * rights.
 */
export async function provisionLocalOrg(input: { userId: string }): Promise<{ orgId: string }> {
	const localOrg = isSelenaStagingMvp() ? SELENA_STAGING_ORG : LOCAL_ORG;
	await db.transaction(async (tx) => {
		await tx.insert(organization).values({
			id: localOrg.id,
			name: localOrg.name,
			slug: localOrg.slug,
			createdAt: new Date(),
		});

		await tx.insert(member).values({
			id: crypto.randomUUID(),
			organizationId: localOrg.id,
			userId: input.userId,
			role: "admin",
			createdAt: new Date(),
		});

		if (isSelenaStagingMvp()) {
			await tx.insert(brands).values({
				id: "selena",
				organizationId: localOrg.id,
				name: "Selena Systems",
				website: "https://selenasystems.com",
				enabled: false,
				onboarded: true,
			});
		}
	});

	return { orgId: localOrg.id };
}

/**
 * Slugify a brand or org name into the URL/id form used for brand ids and
 * org ids/slugs. Exported so the slug rules can be unit-tested directly
 * without a database.
 *
 * Note: leading/trailing hyphens are trimmed via index walks instead of an
 * `^-+|-+$` alternation regex — the alternation form trips ReDoS scanners
 * on inputs like `"---"` even though the JS engine handles it linearly.
 */
export function slugify(name: string): string {
	const cleaned = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
	let start = 0;
	while (start < cleaned.length && cleaned[start] === "-") start++;
	let end = cleaned.length;
	while (end > start && cleaned[end - 1] === "-") end--;
	const slug = cleaned.slice(start, end);
	return slug || "brand";
}

/**
 * Slugs that would collide with sibling routes under `/app/$brand`. A
 * user-named brand that slugifies to one of these gets a numeric suffix
 * instead so the URL stays unambiguous.
 */
const RESERVED_ORG_SLUGS = new Set(["new"]);

/**
 * Find a brand id that doesn't collide with an existing brand row or a
 * reserved route slug, appending -2, -3, … on collision. Brand ids are
 * globally unique — they appear directly in `/app/$brand` URLs — and, unlike
 * the legacy org-per-brand convention, are independent of any organization id.
 */
export async function findUniqueBrandId(baseSlug: string): Promise<string> {
	let candidate = baseSlug;
	let suffix = 2;
	for (;;) {
		const isReserved = RESERVED_ORG_SLUGS.has(candidate);
		const conflict = isReserved
			? [{ id: candidate }]
			: await db.select({ id: brands.id }).from(brands).where(eq(brands.id, candidate)).limit(1);
		if (conflict.length === 0) return candidate;
		candidate = `${baseSlug}-${suffix}`;
		suffix++;
	}
}

/**
 * Find an organization slug that doesn't collide with an existing org,
 * appending -2, -3, … on collision. Used by `provisionUmbrellaOrg`, where the
 * org id itself is a random uuid (decoupled from any brand) but the slug
 * still needs to be unique and human-readable.
 */
async function findUniqueOrgSlug(baseSlug: string, conn: DbConnection = db): Promise<string> {
	let candidate = baseSlug;
	let suffix = 2;
	for (;;) {
		const [conflict] = await conn
			.select({ id: organization.id })
			.from(organization)
			.where(eq(organization.slug, candidate))
			.limit(1);
		if (!conflict) return candidate;
		candidate = `${baseSlug}-${suffix}`;
		suffix++;
	}
}

/**
 * Ensure an organization row exists for a brand created outside the normal
 * signup / Auth0 flows — specifically the admin API (`POST /api/v1/brands`),
 * which accepts a caller-supplied brand id and no longer has a session/org to
 * lean on. Brands are hard-scoped to an org via a NOT NULL FK, so the org must
 * exist before the brand is inserted.
 *
 * No-op when the org already exists: we never overwrite an org that was synced
 * from Auth0 (whitelabel) or created on signup. The brand id is reused as the
 * org id (the long-standing convention), with a collision-free slug.
 */
export async function ensureOrganization(input: { id: string; name: string }, conn: DbConnection = db): Promise<void> {
	const [existing] = await conn
		.select({ id: organization.id })
		.from(organization)
		.where(eq(organization.id, input.id))
		.limit(1);
	if (existing) return;

	const baseSlug = slugify(input.name);
	const slug = await findUniqueOrgSlug(baseSlug, conn);

	// Target the id explicitly: the early-return above already handles "org
	// exists", so this only guards a concurrent insert of the same id (no-op).
	// An untargeted onConflictDoNothing would also swallow a slug-unique
	// collision, silently skip the insert, and leave the caller's brand FK to
	// fail with a confusing error instead.
	await conn
		.insert(organization)
		.values({ id: input.id, name: input.name, slug, createdAt: new Date() })
		.onConflictDoNothing({ target: organization.id });
}

/**
 * Create the single customer ("umbrella") org + admin membership for a new
 * user. The org id is decoupled from any brand (a random id), so brands can be
 * attached later with their own ids. Used by the cloud user.create.after hook.
 */
export async function provisionUmbrellaOrg(input: { userId: string; name: string }): Promise<{ orgId: string }> {
	const orgId = crypto.randomUUID();

	await db.transaction(async (tx) => {
		// Resolve the slug inside the transaction so the uniqueness check and the
		// insert it guards see the same snapshot. Two same-named signups can still
		// collide on the slug unique index; that surfaces as a failed signup
		// rather than a duplicate org.
		const slug = await findUniqueOrgSlug(slugify(input.name), tx);
		await tx.insert(organization).values({ id: orgId, name: input.name, slug, createdAt: new Date() });
		await tx.insert(member).values({
			id: crypto.randomUUID(),
			organizationId: orgId,
			userId: input.userId,
			role: "admin",
			createdAt: new Date(),
		});
	});

	return { orgId };
}

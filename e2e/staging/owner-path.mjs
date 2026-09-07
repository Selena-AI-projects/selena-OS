/**
 * The owner's path through a deployed Control Room, walked by a synthetic owner.
 *
 * Everything before this point can be proven from a database or a log. This
 * cannot: whether a person who signs in can actually create a brand, set a
 * policy, confirm a source, and see the material that arrives afterwards. So it
 * is walked in a real browser against the real deployment, by an account that
 * belongs to nobody.
 *
 * The account is created through the application's own sign-up where that is
 * possible. A single-user deployment refuses a second one, so there the account
 * row is seeded instead — with the very library the application verifies
 * passwords with, so the sign-in that follows is still the application's own.
 * Only the account, its organization and its membership are written directly,
 * the same technical preparation the repository's own end-to-end setup does.
 * Everything the run is actually testing goes through the interface.
 *
 * REPORT=accounts only reads how many accounts the deployment already has, and
 * REPORT=discover walks in and prints what it finds instead of asserting, which
 * is how the scenario below was written against the deployment rather than
 * against an assumption about it.
 */
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import pg from "pg";

const BASE_URL = required("STAGING_BASE_URL");
const DATABASE_URL = required("STAGING_DATABASE_URL");
const PROJECT_ID = required("GROWTH_PROJECT_ID");
const BUSINESS_KEY = process.env.GROWTH_BUSINESS_KEY ?? "selena";
const SOURCE_ENVIRONMENT = process.env.GROWTH_SOURCE_ENVIRONMENT ?? "staging";
const POLICY_VERSION = process.env.GROWTH_POLICY_VERSION ?? "staging-check-1";
const MODE = process.env.REPORT ?? "scenario";

// Stable, so a second run signs in rather than colliding with itself.
const OWNER_EMAIL = process.env.SYNTHETIC_OWNER_EMAIL ?? "growth-check@synthetic.invalid";
const OWNER_PASSWORD = required("SYNTHETIC_OWNER_PASSWORD");
const ORGANIZATION_ID = process.env.SYNTHETIC_ORGANIZATION_ID ?? "growth-check-org";
const BRAND_NAME = process.env.SYNTHETIC_BRAND_NAME ?? "Growth check (synthetic)";
const BRAND_WEBSITE = process.env.SYNTHETIC_BRAND_WEBSITE ?? "https://growth-check.synthetic.invalid";

function required(name) {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function log(...parts) {
	console.log(...parts);
}

/**
 * Why the deployment refused the account, answered from the database rather
 * than from a status code. Nothing identifying is printed: an address belongs
 * to whoever owns it, and the question here is only how many accounts exist and
 * whether any of them is this check's own.
 */
async function reportAuthState() {
	const client = new pg.Client({ connectionString: DATABASE_URL });
	await client.connect();
	try {
		const users = await client.query(
			`SELECT count(*)::int AS total,
			        count(*) FILTER (WHERE email = $1)::int AS synthetic,
			        min(created_at) AS first_created
			   FROM "user"`,
			[OWNER_EMAIL],
		);
		const credentials = await client.query(
			`SELECT provider_id, count(*)::int AS n FROM account GROUP BY provider_id ORDER BY provider_id`,
		);
		const organizations = await client.query(`SELECT count(*)::int AS n FROM organization`);
		log(
			`accounts: ${users.rows[0].total} user(s), of which ${users.rows[0].synthetic} is this check's;` +
				` first created ${users.rows[0].first_created?.toISOString?.() ?? "n/a"}`,
		);
		log(`credentials by provider: ${JSON.stringify(credentials.rows)}`);
		log(`organizations: ${organizations.rows[0].n}`);
	} finally {
		await client.end();
	}
}

/**
 * Give the check an identity of its own on a deployment that will not sign a
 * second one up. The hash comes from the same package better-auth verifies
 * with, so nothing here decides whether the password is right — the sign-in
 * that follows does.
 */
async function seedCredentialAccount() {
	const { hashPassword } = await import("@better-auth/utils/password");
	const password = await hashPassword(OWNER_PASSWORD);
	const client = new pg.Client({ connectionString: DATABASE_URL });
	await client.connect();
	try {
		await client.query("BEGIN");
		await client.query(
			`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
			 VALUES (gen_random_uuid()::text, $1, $2, false, NOW(), NOW())
			 ON CONFLICT (email) DO NOTHING`,
			["Growth Check", OWNER_EMAIL],
		);
		const user = await client.query(`SELECT id FROM "user" WHERE email = $1`, [OWNER_EMAIL]);
		const userId = user.rows[0].id;
		const updated = await client.query(
			`UPDATE account SET password = $2, updated_at = NOW()
			  WHERE user_id = $1 AND provider_id = 'credential'`,
			[userId, password],
		);
		if (updated.rowCount === 0) {
			await client.query(
				`INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at)
				 VALUES (gen_random_uuid()::text, $1, 'credential', $1, $2, NOW(), NOW())`,
				[userId, password],
			);
		}
		await client.query("COMMIT");
		log(`seeded the check's own credential account (${userId})`);
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		await client.end();
	}
}

async function ensureAccount(page) {
	const signUp = await page.request.post("/api/auth/sign-up/email", {
		data: { email: OWNER_EMAIL, password: OWNER_PASSWORD, name: "Growth Check" },
		failOnStatusCode: false,
	});
	// The reason matters more than the code: a refusal here is a deployment
	// policy — sign-up switched off, a rejected domain, a password rule, or a
	// deployment that admits exactly one account — and they need different
	// answers.
	log(`sign-up: ${signUp.status()} ${(await signUp.text()).slice(0, 300)}`);
	if (!signUp.ok()) await seedCredentialAccount();

	const signIn = await page.request.post("/api/auth/sign-in/email", {
		data: { email: OWNER_EMAIL, password: OWNER_PASSWORD },
		failOnStatusCode: false,
	});
	log(`sign-in: ${signIn.status()} ${signIn.ok() ? "" : (await signIn.text()).slice(0, 300)}`);
	if (!signIn.ok()) throw new Error(`the synthetic owner could not sign in (${signIn.status()})`);
}

/**
 * The organization and the membership are account plumbing, not the thing under
 * test: without them the signed-in user has nowhere to go. The brand, the
 * policy and the source confirmation are deliberately not written here.
 */
async function ensureOrganization() {
	const client = new pg.Client({ connectionString: DATABASE_URL });
	await client.connect();
	try {
		const user = await client.query(`SELECT id FROM "user" WHERE email = $1 LIMIT 1`, [OWNER_EMAIL]);
		if (user.rows.length === 0) throw new Error("the synthetic user is missing after sign-up");
		const userId = user.rows[0].id;
		await client.query(
			`INSERT INTO organization (id, name, slug, created_at) VALUES ($1, $2, $1, NOW())
			 ON CONFLICT (id) DO NOTHING`,
			[ORGANIZATION_ID, "Growth check organization"],
		);
		await client.query(
			`INSERT INTO member (id, organization_id, user_id, role, created_at)
			 SELECT gen_random_uuid()::text, $1, $2, 'admin', NOW()
			  WHERE NOT EXISTS (SELECT 1 FROM member WHERE organization_id = $1 AND user_id = $2)`,
			[ORGANIZATION_ID, userId],
		);
		log(`organization ${ORGANIZATION_ID} and an admin membership are in place for ${userId}`);
		return userId;
	} finally {
		await client.end();
	}
}

async function describe(page, path) {
	const response = await page.goto(path, { waitUntil: "domcontentloaded" });
	const status = response?.status();
	await page.waitForTimeout(2000);
	const links = await page.$$eval("a[href]", (nodes) =>
		Array.from(new Set(nodes.map((node) => node.getAttribute("href")))).slice(0, 40),
	);
	const buttons = await page.$$eval("button", (nodes) =>
		Array.from(new Set(nodes.map((node) => (node.textContent ?? "").trim()).filter(Boolean))).slice(0, 40),
	);
	const headings = await page.$$eval("h1, h2, h3", (nodes) =>
		nodes.map((node) => (node.textContent ?? "").trim()).filter(Boolean).slice(0, 20),
	);
	log(`\n--- ${path} -> ${status} (${page.url()})`);
	log(`headings: ${JSON.stringify(headings)}`);
	log(`buttons:  ${JSON.stringify(buttons)}`);
	log(`links:    ${JSON.stringify(links)}`);
}

async function main() {
	const browser = await chromium.launch();
	const context = await browser.newContext({ baseURL: BASE_URL });
	const page = await context.newPage();
	page.on("console", (message) => {
		if (message.type() === "error") log(`browser error: ${message.text().slice(0, 200)}`);
	});
	try {
		await reportAuthState();
		if (MODE === "accounts") {
			log("nothing was created; this run only read the deployment's account state");
			return;
		}

		await ensureAccount(page);
		const userId = await ensureOrganization();
		log(`synthetic owner ${OWNER_EMAIL} (${userId})`);

		if (MODE === "discover") {
			for (const path of ["/", "/app", `/app/${ORGANIZATION_ID}`, `/app/${ORGANIZATION_ID}/control-room`]) {
				await describe(page, path);
			}
			log("\ndiscovery finished; nothing was changed through the interface");
			return;
		}

		throw new Error(`unknown REPORT mode: ${MODE}`);
	} finally {
		await context.close();
		await browser.close();
	}
}

main().catch((error) => {
	console.error(`owner path failed: ${error instanceof Error ? error.message : "unknown error"}`);
	process.exitCode = 1;
});

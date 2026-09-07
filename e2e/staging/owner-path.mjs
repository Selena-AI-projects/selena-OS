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
	const fields = await page.$$eval("input, select, textarea", (nodes) =>
		nodes
			.map((node) => ({
				tag: node.tagName.toLowerCase(),
				type: node.getAttribute("type"),
				name: node.getAttribute("name"),
				id: node.getAttribute("id"),
				placeholder: node.getAttribute("placeholder"),
			}))
			.slice(0, 30),
	);
	log(`\n--- ${path} -> ${status} (${page.url()})`);
	log(`headings: ${JSON.stringify(headings)}`);
	log(`buttons:  ${JSON.stringify(buttons)}`);
	log(`fields:   ${JSON.stringify(fields)}`);
	log(`links:    ${JSON.stringify(links)}`);
}

/** What the application told the person, so a refusal is quoted rather than guessed at. */
async function visibleNotices(page) {
	return page.$$eval('[data-sonner-toast], [role="status"], [role="alert"], .text-destructive', (nodes) =>
		nodes.map((node) => (node.textContent ?? "").trim()).filter(Boolean).slice(0, 5),
	);
}

async function expectRow(page, testId, needles, what) {
	let row = page.locator(`[data-testid="${testId}"]`);
	for (const needle of needles) row = row.filter({ hasText: needle });
	try {
		await row.first().waitFor({ timeout: 20_000 });
	} catch {
		throw new Error(`${what} did not appear; the page said: ${JSON.stringify(await visibleNotices(page))}`);
	}
}

/**
 * The forms are controlled inputs: a value typed before the client has taken
 * over the server-rendered page is thrown away on hydration, and the form then
 * reports the field as empty. So every visit waits for the page to go quiet,
 * and every fill is checked against what the input actually holds.
 */
async function open(page, path) {
	await page.goto(path, { waitUntil: "networkidle" });
}

async function fillChecked(locator, value) {
	await locator.fill(value);
	if ((await locator.inputValue()) !== value) {
		await locator.clear();
		await locator.pressSequentially(value);
	}
	if ((await locator.inputValue()) !== value) throw new Error("the field did not keep the value typed into it");
}

/** The legacy first-brand path: the brand takes the organization's id. */
async function createBrandThroughOnboarding(page) {
	await open(page, `/app/${ORGANIZATION_ID}`);
	const website = page.locator("#website");
	if ((await website.count()) === 0) {
		log("brand: already exists, onboarding is not shown");
		return;
	}
	await fillChecked(website, BRAND_WEBSITE);
	await page.getByRole("button", { name: "Complete Setup" }).click();
	// The form goes away only once the brand exists and the route re-renders on it.
	try {
		await website.waitFor({ state: "detached", timeout: 30_000 });
	} catch {
		throw new Error(`brand was not created; the page said: ${JSON.stringify(await visibleNotices(page))}`);
	}
	log(`brand: created through onboarding for ${BRAND_WEBSITE}`);
}

async function openSources(page) {
	await open(page, `/app/${ORGANIZATION_ID}/control-room#sources`);
	await page.getByText("Content policy", { exact: true }).first().waitFor({ timeout: 30_000 });
	await page.getByText("Aether sources", { exact: true }).first().waitFor({ timeout: 30_000 });
}

async function setPolicyThroughInterface(page) {
	const inForce = page.locator('[data-testid="content-policy-row"]').filter({ hasText: POLICY_VERSION }).filter({ hasText: "IN FORCE" });
	if ((await inForce.count()) > 0) {
		log(`policy: ${POLICY_VERSION} is already in force`);
		return;
	}
	await fillChecked(page.getByPlaceholder("2026-09-a"), POLICY_VERSION);
	await page.getByRole("button", { name: "Set policy" }).click();
	await expectRow(page, "content-policy-row", [POLICY_VERSION, "IN FORCE"], `policy ${POLICY_VERSION}`);
	log(`policy: ${POLICY_VERSION} set and shown in force`);
}

async function confirmSourceThroughInterface(page) {
	const confirmed = page.locator('[data-testid="growth-binding-row"]').filter({ hasText: PROJECT_ID }).filter({ hasText: "CONFIRMED" });
	if ((await confirmed.count()) > 0) {
		log(`source: ${PROJECT_ID} is already confirmed`);
		return;
	}
	const form = page.getByText("Confirm a source", { exact: true });
	if ((await form.count()) === 0) {
		throw new Error("the confirm-a-source card is not shown: growth sources are switched off or this is not an owner");
	}
	await fillChecked(page.getByPlaceholder("00000000-0000-0000-0000-000000000000"), PROJECT_ID);
	await fillChecked(page.getByPlaceholder("selena"), BUSINESS_KEY);
	await page.locator("select").first().selectOption(SOURCE_ENVIRONMENT);
	await page.getByRole("button", { name: "Confirm source" }).click();
	await expectRow(page, "growth-binding-row", [PROJECT_ID, "CONFIRMED"], `source ${PROJECT_ID}`);
	log(`source: ${PROJECT_ID} (${BUSINESS_KEY}, ${SOURCE_ENVIRONMENT}) confirmed and shown`);
}

/** The database's own account of what the interface just did, read as the same login the check seeds with. */
async function reportOutcome() {
	const client = new pg.Client({ connectionString: DATABASE_URL });
	await client.connect();
	try {
		const brand = await client.query(`SELECT id, name, website, organization_id FROM brands WHERE id = $1`, [ORGANIZATION_ID]);
		const policies = await client.query(
			`SELECT policy_version, status, require_evidence FROM selena_registry.content_policies WHERE brand_id = $1 ORDER BY created_at`,
			[ORGANIZATION_ID],
		);
		const bindings = await client.query(
			`SELECT aether_project_id, aether_business_key, source_environment, revoked_at IS NOT NULL AS revoked
			   FROM selena_registry.growth_project_bindings WHERE brand_id = $1 ORDER BY confirmed_at`,
			[ORGANIZATION_ID],
		);
		const audit = await client.query(
			`SELECT action, count(*)::int AS n FROM selena_audit.audit_events WHERE brand_id = $1 GROUP BY action ORDER BY action`,
			[ORGANIZATION_ID],
		);
		log(`\noutcome: brand=${JSON.stringify(brand.rows[0] ?? null)}`);
		log(`outcome: policies=${JSON.stringify(policies.rows)}`);
		log(`outcome: bindings=${JSON.stringify(bindings.rows)}`);
		log(`outcome: audit events for this brand=${JSON.stringify(audit.rows)}`);
	} finally {
		await client.end();
	}
}

/**
 * What arrived after the source was confirmed: the events by outcome, and the
 * materials they became, grouped by the brief they share. Read-only.
 */
async function reportMaterials() {
	const client = new pg.Client({ connectionString: DATABASE_URL });
	await client.connect();
	try {
		const events = await client.query(
			`SELECT source_project_id, event_type, version,
			        CASE WHEN projected_content_version_id IS NOT NULL THEN 'projected'
			             WHEN projection_error IS NOT NULL AND projected_at IS NOT NULL THEN 'refused'
			             WHEN projection_error IS NOT NULL THEN 'deferred'
			             ELSE 'pending' END AS outcome,
			        projection_error, projection_attempts
			   FROM selena_ingest_raw.aether_events ORDER BY received_at`,
		);
		const items = await client.query(
			`SELECT i.id, i.title, i.status, i.kind, i.external_source, i.brief_ref,
			        (SELECT json_agg(json_build_object('version', v.version, 'policy', v.policy_version, 'created_by', v.created_by) ORDER BY v.version)
			           FROM selena_registry.content_versions v WHERE v.content_id = i.id) AS versions
			   FROM selena_registry.content_items i WHERE i.brand_id = $1 ORDER BY i.brief_ref, i.kind`,
			[ORGANIZATION_ID],
		);
		const elsewhere = await client.query(
			`SELECT count(*)::int AS n FROM selena_registry.content_items WHERE brand_id <> $1 AND external_source IS NOT NULL`,
			[ORGANIZATION_ID],
		);
		log(`\nevents (${events.rows.length}):`);
		for (const row of events.rows) {
			log(
				`  ${row.source_project_id} ${row.event_type} v${row.version}: ${row.outcome}` +
					`${row.projection_error ? ` ${row.projection_error}` : ""} (attempts ${row.projection_attempts})`,
			);
		}
		log(`materials for ${ORGANIZATION_ID} (${items.rows.length}):`);
		for (const row of items.rows) {
			log(`  brief ${row.brief_ref} ${row.kind} "${row.title}" ${row.status} versions=${JSON.stringify(row.versions)}`);
		}
		log(`materials from external sources under any other brand: ${elsewhere.rows[0].n}`);
		// The effects that must stay at zero for the whole acceptance run.
		const effects = await client.query(`
			SELECT (SELECT count(*) FROM selena_registry.approvals) AS approvals,
			       (SELECT count(*) FROM selena_release.release_intents) AS release_intents,
			       (SELECT count(*) FROM selena_release.release_manifests) AS release_manifests,
			       (SELECT count(*) FROM selena_release.publication_attempts) AS publication_attempts,
			       (SELECT count(*) FROM selena_release.workflow_dispatches) AS workflow_dispatches,
			       (SELECT count(*) FROM selena_registry.content_versions WHERE version > 1) AS later_versions,
			       (SELECT count(DISTINCT brief_ref) FROM selena_registry.content_items WHERE brand_id = $1) AS briefs
		`, [ORGANIZATION_ID]);
		log(`effects: ${JSON.stringify(effects.rows[0])}`);
	} finally {
		await client.end();
	}
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

		if (MODE === "verify") {
			await reportMaterials();
			for (const section of ["inbox", "review"]) {
				await open(page, `/app/${ORGANIZATION_ID}/control-room#${section}`);
				await page.waitForTimeout(2000);
				const rows = await page.$$eval('[data-testid="review-queue-row"]', (nodes) =>
					nodes.map((node) => ({ kind: node.getAttribute("data-kind"), text: (node.textContent ?? "").trim().slice(0, 160) })),
				);
				log(`\n${section}: rows the synthetic owner sees (${rows.length}):`);
				for (const row of rows) log(`  [${row.kind}] ${row.text}`);
				await describe(page, `/app/${ORGANIZATION_ID}/control-room#${section}`);
			}
			log("\nverification finished; nothing was changed");
			return;
		}

		// Withdraw the policy in force through the interface, so that what arrives
		// next has to wait — the deferral and its backoff are then observable.
		if (MODE === "withdraw") {
			await openSources(page);
			const inForce = page.locator('[data-testid="content-policy-row"]').filter({ hasText: "IN FORCE" });
			if ((await inForce.count()) === 0) {
				log("policy: nothing is in force, nothing to withdraw");
			} else {
				await fillChecked(page.getByPlaceholder("Why this policy should stop applying"), "staging lifecycle check");
				await inForce.first().getByRole("button", { name: "Withdraw" }).click();
				await expectRow(page, "content-policy-row", [POLICY_VERSION, "WITHDRAWN"], "the withdrawn policy");
				log(`policy: ${POLICY_VERSION} withdrawn and shown as such`);
			}
			await reportOutcome();
			return;
		}

		if (MODE === "scenario") {
			await createBrandThroughOnboarding(page);
			await openSources(page);
			await setPolicyThroughInterface(page);
			await confirmSourceThroughInterface(page);
			await reportOutcome();
			log("\nowner path finished: brand, policy and source were all done through the interface");
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

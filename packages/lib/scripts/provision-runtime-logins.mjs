/**
 * Creates the login roles the runtimes connect as.
 *
 * The migrations create the runtime roles themselves, but they are NOLOGIN
 * groups: nothing can connect as one. Each deployment still needs a login role
 * that is a member of the group, and that step lived only in someone's head —
 * which is part of why the Control Room had never been stood up.
 *
 * The runtime groups are NOINHERIT on purpose, so membership alone grants
 * nothing; the session has to assume the role. `ALTER ROLE ... SET ROLE` makes
 * that automatic, so a runtime cannot forget to do it and end up connected with
 * more rights than it should have.
 *
 * Passwords come from the environment and are never written to the repository
 * or echoed. A login whose password variable is absent is skipped, so a
 * deployment provisions only the identities it actually runs.
 */
import { pathToFileURL } from "node:url";
import { Client } from "pg";

/**
 * Column privileges a login must and must not have, checked over its own
 * connection after provisioning.
 *
 * The web runtime reads release history through a projection: the signed
 * manifest body, its signature and its signing key stay unreadable. A GRANT
 * that widens the projection is a one-line change in a migration and looks
 * harmless in review, so the boundary is asserted where it can actually be
 * observed — as the runtime itself, against the real database.
 */
const PRIVILEGE_EXPECTATIONS = {
	selena_web_login: {
		table: "selena_release.release_manifests",
		readable: ["status", "content_version_id", "channel_account_id"],
		unreadable: ["manifest", "signature", "signing_key_version", "approval_id"],
	},
};

const LOGINS = [
	{ group: "selena_web_runtime", login: "selena_web_login", passwordEnv: "SELENA_WEB_DB_PASSWORD" },
	{ group: "selena_gateway_runtime", login: "selena_gateway_login", passwordEnv: "SELENA_GATEWAY_DB_PASSWORD" },
	{ group: "selena_scanner_runtime", login: "selena_scanner_login", passwordEnv: "SELENA_SCANNER_DB_PASSWORD" },
	{
		group: "selena_registry_worker_runtime",
		login: "selena_worker_login",
		passwordEnv: "SELENA_WORKER_DB_PASSWORD",
	},
	{
		group: "selena_ingestion_runtime",
		login: "selena_ingestion_login",
		passwordEnv: "SELENA_INGESTION_DB_PASSWORD",
	},
];

/** The same server and database as the admin connection, as a runtime login. */
function runtimeConnectionString(adminUrl, login, password) {
	const url = new URL(adminUrl);
	url.username = encodeURIComponent(login);
	url.password = encodeURIComponent(password);
	return url.toString();
}

/**
 * Connects as the login just provisioned and checks it is both usable and
 * constrained.
 *
 * Provisioning that produces a login nobody can connect with, or one that
 * connects with more rights than intended, both used to surface only later —
 * the first as a deployment that would not start, the second not at all.
 */
async function verifyRuntimeLogin(adminUrl, ssl, { group, login, password }) {
	const client = new Client({
		connectionString: runtimeConnectionString(adminUrl, login, password),
		...(ssl ? { ssl } : {}),
	});
	await client.connect();
	try {
		const { rows } = await client.query("SELECT session_user, current_user");
		if (rows[0]?.session_user !== login) {
			throw new Error(`${login} connected as ${rows[0]?.session_user}`);
		}
		// The groups are NOINHERIT, so a session that has not assumed the role
		// holds none of its rights. Connecting is therefore not enough.
		if (rows[0]?.current_user !== group) {
			throw new Error(`${login} runs as ${rows[0]?.current_user}, not ${group}`);
		}

		const expected = PRIVILEGE_EXPECTATIONS[login];
		if (!expected) return;
		for (const [column, shouldRead] of [
			...expected.readable.map((column) => [column, true]),
			...expected.unreadable.map((column) => [column, false]),
		]) {
			const { rows: privilege } = await client.query(
				"SELECT has_column_privilege($1::text, $2::text, 'SELECT') AS allowed",
				[expected.table, column],
			);
			if (privilege[0]?.allowed !== shouldRead) {
				throw new Error(
					shouldRead
						? `${login} cannot read ${expected.table}.${column}`
						: `${login} can read ${expected.table}.${column}`,
				);
			}
		}
	} finally {
		await client.end();
	}
}

/**
 * Runs against an already-open connection so the migration runner can call it
 * as the last step of bringing a database up to what the application needs.
 * Nothing happens unless a password variable is present, so a deployment that
 * does not use runtime separation is unaffected.
 */
export async function provisionRuntimeLogins(client, databaseName, { adminUrl, ssl } = {}) {
	const provisioned = [];
	const skipped = [];

	for (const { group, login, passwordEnv } of LOGINS) {
		const password = process.env[passwordEnv];
		if (!password) {
			skipped.push(login);
			continue;
		}

		const { rows } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [group]);
		if (rows.length === 0) {
			throw new Error(`${group} does not exist — run the migrations before provisioning logins`);
		}

		// CREATE ROLE takes no parameters, and the password would land in
		// pg_stat_activity either way, so it is passed as a quoted literal
		// through the server's own quoting rather than by string building.
		const quoted = await client.query(
			"SELECT quote_literal($1::text) AS value, quote_ident($2::text) AS name, quote_ident($3::text) AS db",
			[password, login, databaseName],
		);
		const passwordLiteral = quoted.rows[0].value;
		const loginIdent = quoted.rows[0].name;

		await client.query(`
			DO $$
			BEGIN
				CREATE ROLE ${loginIdent} LOGIN PASSWORD ${passwordLiteral};
			EXCEPTION WHEN duplicate_object THEN
				ALTER ROLE ${loginIdent} LOGIN PASSWORD ${passwordLiteral};
			END $$;
		`);
		await client.query(`GRANT ${group} TO ${loginIdent}`);
		await client.query(`GRANT CONNECT ON DATABASE ${quoted.rows[0].db} TO ${loginIdent}`);
		await client.query(`ALTER ROLE ${loginIdent} SET ROLE = ${group}`);
		provisioned.push(login);
		if (adminUrl) await verifyRuntimeLogin(adminUrl, ssl, { group, login, password });
	}

	console.log(`runtime logins provisioned: ${provisioned.join(", ") || "(none)"}`);
	if (adminUrl && provisioned.length > 0) console.log("each one verified over its own connection");
	if (skipped.length > 0) console.log(`skipped, no password set: ${skipped.join(", ")}`);
	return { provisioned, skipped };
}

export function databaseNameFrom(databaseUrl) {
	return new URL(databaseUrl).pathname.replace(/^\//, "") || "postgres";
}

async function main() {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) throw new Error("DATABASE_URL is required to provision runtime logins");
	const client = new Client({ connectionString: databaseUrl });
	await client.connect();
	try {
		await provisionRuntimeLogins(client, databaseNameFrom(databaseUrl), { adminUrl: databaseUrl });
	} finally {
		await client.end();
	}
}

// Only when run as a command. The migration runner imports the function, and an
// unguarded call here would provision twice in one run — concurrently enough for
// Postgres to refuse the second ALTER ROLE with "tuple concurrently updated".
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : "provisioning failed");
		process.exitCode = 1;
	});
}

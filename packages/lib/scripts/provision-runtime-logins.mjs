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
import { Client } from "pg";

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

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required to provision runtime logins");

const databaseName = new URL(databaseUrl).pathname.replace(/^\//, "") || "postgres";

async function main() {
	const client = new Client({ connectionString: databaseUrl });
	await client.connect();
	const provisioned = [];
	const skipped = [];

	try {
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
			const quoted = await client.query("SELECT quote_literal($1::text) AS value, quote_ident($2::text) AS name", [
				password,
				login,
			]);
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
			await client.query(`GRANT CONNECT ON DATABASE ${(await client.query("SELECT quote_ident($1::text) AS name", [databaseName])).rows[0].name} TO ${loginIdent}`);
			await client.query(`ALTER ROLE ${loginIdent} SET ROLE = ${group}`);
			provisioned.push(login);
		}
	} finally {
		await client.end();
	}

	console.log(`runtime logins provisioned: ${provisioned.join(", ") || "(none)"}`);
	if (skipped.length > 0) console.log(`skipped, no password set: ${skipped.join(", ")}`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : "provisioning failed");
	process.exitCode = 1;
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";

const isStagingMvp = process.env.SELENA_STAGING_MVP === "true";
const databaseUrl = process.env.SELENA_MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;

if (!databaseUrl) {
	throw new Error("DATABASE_URL is required for the migration runner");
}

function createClient() {
	if (!isStagingMvp) return new Client({ connectionString: databaseUrl });

	const rootCertificatePath = process.env.PGSSLROOTCERT;
	if (!rootCertificatePath) {
		throw new Error("PGSSLROOTCERT is required for staging migrations");
	}

	const url = new URL(databaseUrl);
	for (const key of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) {
		url.searchParams.delete(key);
	}

	return new Client({
		connectionString: url.toString(),
		ssl: {
			ca: readFileSync(rootCertificatePath, "utf8"),
			rejectUnauthorized: true,
		},
	});
}

async function main() {
	const client = createClient();
	await client.connect();

	try {
		if (isStagingMvp) {
			const { rows } = await client.query("SELECT session_user");
			if (rows[0]?.session_user !== "selena_staging_migrator_login") {
				throw new Error("staging migration runner requires the dedicated migration login");
			}

			await client.query("SET ROLE selena_schema_owner");
			const { rows: roleRows } = await client.query("SELECT current_user");
			if (roleRows[0]?.current_user !== "selena_schema_owner") {
				throw new Error("staging migration runner could not assume selena_schema_owner");
			}
		}

		await migrate(drizzle({ client }), {
			migrationsFolder: resolve(process.cwd(), "src/db/migrations"),
		});
		console.log("migrations applied successfully");
	} finally {
		await client.end();
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : "migration runner failed");
	process.exitCode = 1;
});

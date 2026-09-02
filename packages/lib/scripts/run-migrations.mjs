import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

const migrationsFolder = resolve(process.cwd(), "src/db/migrations");

function schemaOwnerExists(client) {
	return client.query("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'selena_schema_owner') AS exists");
}

/**
 * Roles live in the cluster, not in the database. A second database beside an
 * existing one therefore starts with the roles already present and no ledger of
 * its own, so the role alone cannot answer "has this database been set up yet".
 */
function migrationLedgerExists(client) {
	return client.query("SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS exists");
}

function createBootstrapMigrationsFolder() {
	const bootstrapFolder = mkdtempSync(join(tmpdir(), "selena-migration-bootstrap-"));
	const metaFolder = join(bootstrapFolder, "meta");
	mkdirSync(metaFolder, { recursive: true });
	const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"));
	const entries = journal.entries.filter((entry) => entry.idx <= 21);
	writeFileSync(join(metaFolder, "_journal.json"), `${JSON.stringify({ ...journal, entries }, null, 2)}\n`);
	for (const entry of entries) copyFileSync(join(migrationsFolder, `${entry.tag}.sql`), join(bootstrapFolder, `${entry.tag}.sql`));
	return bootstrapFolder;
}

async function assumeSchemaOwner(client) {
	await client.query("SET ROLE selena_schema_owner");
	const { rows: roleRows } = await client.query("SELECT current_user");
	if (roleRows[0]?.current_user !== "selena_schema_owner") {
		throw new Error("migration runner could not assume selena_schema_owner");
	}
}

async function grantSchemaOwnerMigrationLedgerAccess(client) {
	await client.query("GRANT USAGE, CREATE ON SCHEMA drizzle TO selena_schema_owner");
	await client.query("GRANT SELECT, INSERT, UPDATE ON drizzle.__drizzle_migrations TO selena_schema_owner");
	await client.query("GRANT USAGE, SELECT ON SEQUENCE drizzle.__drizzle_migrations_id_seq TO selena_schema_owner");
}

async function main() {
	const client = createClient();
	await client.connect();

	try {
		// Drizzle records migration hashes in its own ledger schema. Selena's
		// private schemas remain owned by selena_schema_owner; this bootstrap is
		// only for an empty local/disposable database.
		if (!isStagingMvp) await client.query("CREATE SCHEMA IF NOT EXISTS drizzle");

		if (isStagingMvp) {
			const { rows } = await client.query("SELECT session_user");
			if (rows[0]?.session_user !== "selena_staging_migrator_login") {
				throw new Error("staging migration runner requires the dedicated migration login");
			}
		}

		const roleCheck = await schemaOwnerExists(client);
		if (isStagingMvp && !roleCheck.rows[0]?.exists) {
			throw new Error("staging migration login requires the pre-provisioned selena_schema_owner role");
		}
		const ledgerCheck = isStagingMvp ? null : await migrationLedgerExists(client);
		if (!isStagingMvp && (!ledgerCheck?.rows[0]?.exists || !roleCheck.rows[0]?.exists)) {
			const bootstrapFolder = createBootstrapMigrationsFolder();
			try {
				await migrate(drizzle({ client }), { migrationsFolder: bootstrapFolder });
			} finally {
				rmSync(bootstrapFolder, { recursive: true, force: true });
			}
		}

		await grantSchemaOwnerMigrationLedgerAccess(client);
		await assumeSchemaOwner(client);
		await migrate(drizzle({ client }), {
			migrationsFolder,
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

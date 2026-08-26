import { defineConfig } from "drizzle-kit";

const isStagingMvp = process.env.SELENA_STAGING_MVP === "true";
const migrationDatabaseUrl = process.env.SELENA_MIGRATION_DATABASE_URL;
if (isStagingMvp && !migrationDatabaseUrl) {
	throw new Error("SELENA_MIGRATION_DATABASE_URL is required for the Selena staging migration runner");
}

const databaseUrl = migrationDatabaseUrl ?? process.env.DATABASE_URL;
if (!databaseUrl) {
	throw new Error("DATABASE_URL is required for the migration runner");
}
const stagingDatabaseUrl = new URL(databaseUrl);

const dbCredentials = isStagingMvp
	? {
		host: stagingDatabaseUrl.hostname,
		port: stagingDatabaseUrl.port ? Number(stagingDatabaseUrl.port) : undefined,
		user: decodeURIComponent(stagingDatabaseUrl.username),
		password: decodeURIComponent(stagingDatabaseUrl.password),
		database: decodeURIComponent(stagingDatabaseUrl.pathname.slice(1)),
		// Supavisor's staging chain is encrypted but cannot currently be
		// verified by Node. Keep this exception strictly inside the staging MVP.
		ssl: { rejectUnauthorized: false },
	}
	: { url: databaseUrl };

export default defineConfig({
	schema: ["./src/db/schema.ts", "./src/db/schema-auth.ts"],
	out: "./src/db/migrations",
	dialect: "postgresql",
	dbCredentials,
});

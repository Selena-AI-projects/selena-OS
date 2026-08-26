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
const stagingRole = stagingDatabaseUrl.searchParams.get("options") ?? process.env.PGOPTIONS;
const usesAllowedStagingEndpoint =
	stagingDatabaseUrl.hostname.startsWith("db.") || stagingDatabaseUrl.hostname.endsWith(".pooler.supabase.com");
if (
	isStagingMvp &&
	(stagingDatabaseUrl.port !== "5432" ||
		!usesAllowedStagingEndpoint ||
		!stagingRole?.includes("role=selena_schema_owner"))
) {
	throw new Error(
		"SELENA_MIGRATION_DATABASE_URL must use a direct or session-mode Supabase endpoint on port 5432 with the selena_schema_owner startup role",
	);
}

const dbCredentials = { url: databaseUrl };

export default defineConfig({
	schema: ["./src/db/schema.ts", "./src/db/schema-auth.ts"],
	out: "./src/db/migrations",
	dialect: "postgresql",
	dbCredentials,
});

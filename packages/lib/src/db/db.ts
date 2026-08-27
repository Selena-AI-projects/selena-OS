import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import { assertStagingDatabaseTls } from "./staging-tls";

function createDatabasePool(connectionString: string): Pool {
	const isStagingMvp = process.env.SELENA_STAGING_MVP === "true";
	assertStagingDatabaseTls(connectionString, isStagingMvp);
	return new Pool({ connectionString });
}

const databaseUrl = process.env.DATABASE_URL as string;

export const db = drizzle({ client: createDatabasePool(databaseUrl), schema });

// Selena's private control-plane tables are reached through a separate,
// restricted runtime identity. Control Room server functions do not share the
// application's general database connection.
export const selenaWebDb = drizzle({
	client: createDatabasePool(process.env.SELENA_WEB_DATABASE_URL as string),
	schema,
});

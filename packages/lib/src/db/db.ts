import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

function createDatabasePool(connectionString: string): Pool {
	const isStagingMvp = process.env.SELENA_STAGING_MVP === "true";
	if (!isStagingMvp) return new Pool({ connectionString });

	const connectionUrl = new URL(connectionString);
	connectionUrl.searchParams.delete("sslmode");

	return new Pool({
		connectionString: connectionUrl.toString(),
		// The isolated staging project currently presents a Supavisor chain that
		// Node cannot validate. Keep traffic encrypted, scope the exception to the
		// explicit staging bootstrap, and never enable it for production.
		...(isStagingMvp ? { ssl: { rejectUnauthorized: false } } : {}),
	});
}

export const db = drizzle({ client: createDatabasePool(process.env.DATABASE_URL!), schema });

// Selena's private control-plane tables are reached through a separate,
// restricted runtime identity. Control Room server functions do not share the
// application's general database connection.
export const selenaWebDb = drizzle({
	client: createDatabasePool(process.env.SELENA_WEB_DATABASE_URL!),
	schema,
});

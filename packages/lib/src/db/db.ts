import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

export const db = drizzle(process.env.DATABASE_URL!, { schema });

// Selena's private control-plane tables are reached through a separate,
// restricted runtime identity. Control Room server functions do not share the
// application's general database connection.
export const selenaWebDb = drizzle(process.env.SELENA_WEB_DATABASE_URL!, { schema });

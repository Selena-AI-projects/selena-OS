import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

// Annotated pure so a bundle that never reaches the handle can drop it, and
// with it the Postgres driver. Server-function modules build their repositories
// at module scope, and the browser build keeps that module: without this the
// driver shipped to the browser, where `Buffer` does not exist, and the bundle
// threw before React could hydrate.
export const db = /* @__PURE__ */ drizzle(process.env.DATABASE_URL!, { schema });

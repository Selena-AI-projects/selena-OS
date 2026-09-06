import { readFileSync } from "node:fs";

/**
 * The connection settings every connection to a Selena database must use.
 *
 * Kept apart from the scripts that use it because the migration runner runs its
 * work at import time: anything that reached for these settings by importing it
 * would migrate the database as a side effect of asking how to connect.
 */
export function connectionSettings(databaseUrl, stagingMvp = process.env.SELENA_STAGING_MVP === "true") {
	if (!stagingMvp) return { connectionString: databaseUrl };

	const rootCertificatePath = process.env.PGSSLROOTCERT;
	if (!rootCertificatePath) {
		throw new Error("PGSSLROOTCERT is required for staging connections");
	}

	const url = new URL(databaseUrl);
	for (const key of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) {
		url.searchParams.delete(key);
	}

	return {
		connectionString: url.toString(),
		ssl: {
			ca: readFileSync(rootCertificatePath, "utf8"),
			rejectUnauthorized: true,
		},
	};
}

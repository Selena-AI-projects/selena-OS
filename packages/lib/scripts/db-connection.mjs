import { readFileSync } from "node:fs";

/**
 * The connection settings every connection to a Selena database must use.
 *
 * Kept apart from the scripts that use it because the migration runner runs its
 * work at import time: anything that reached for these settings by importing it
 * would migrate the database as a side effect of asking how to connect.
 */
export function connectionSettings(
	databaseUrl,
	verifyTls = process.env.SELENA_RUNTIME_DB_VERIFY_TLS === "true" || process.env.SELENA_STAGING_MVP === "true",
) {
	if (!verifyTls) return { connectionString: databaseUrl };

	const rootCertificatePath = process.env.PGSSLROOTCERT;
	if (!rootCertificatePath) {
		throw new Error("PGSSLROOTCERT is required when database TLS must be verified");
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

/**
 * A driver error names what it could not reach: `ECONNREFUSED 10.x.x.x:5432`
 * puts an internal address in a log that is read and quoted elsewhere. The
 * reason is worth keeping, the address is not.
 */
export function redact(message) {
	return message
		.replace(/\b[a-z+]+:\/\/\S+/gi, "<url>")
		.replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "<address>")
		.replace(/\b(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?::\d+)?\b/gi, "<address>")
		.replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?\b/gi, "<host>");
}

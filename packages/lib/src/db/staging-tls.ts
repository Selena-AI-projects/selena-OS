/**
 * Whether a runtime must verify the database's TLS certificate chain.
 *
 * Verified TLS and "this deployment is the Selena staging box" are separate
 * questions that one variable used to answer together, so a contour that
 * wanted the first inherited the second: the staging organization and brand,
 * a migrator login only staging has, and a Supabase-shaped host. A contour
 * asks for the certificate check on its own with
 * `SELENA_RUNTIME_DB_VERIFY_TLS`.
 *
 * `SELENA_STAGING_MVP` still implies it, because a staging box that stopped
 * verifying its certificate the moment someone split the variables would be a
 * silent downgrade of the one control standing between a runtime and an
 * impostor database.
 */
export function requiresVerifiedDatabaseTls(env: Record<string, string | undefined> = process.env): boolean {
	return env.SELENA_RUNTIME_DB_VERIFY_TLS === "true" || env.SELENA_STAGING_MVP === "true";
}

export function assertDatabaseTlsVerified(
	connectionString: string,
	env: Record<string, string | undefined> = process.env,
): void {
	if (!requiresVerifiedDatabaseTls(env)) return;

	const url = new URL(connectionString);
	if (url.searchParams.get("sslmode") !== "verify-full" || !url.searchParams.get("sslrootcert")) {
		throw new Error("Selena database connections require verify-full TLS with a root certificate");
	}
}

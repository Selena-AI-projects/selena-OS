export function assertStagingDatabaseTls(connectionString: string, isStagingMvp: boolean): void {
	if (!isStagingMvp) return;

	const url = new URL(connectionString);
	if (url.searchParams.get("sslmode") !== "verify-full" || !url.searchParams.get("sslrootcert")) {
		throw new Error("Selena staging database connections require verify-full TLS with a root certificate");
	}
}

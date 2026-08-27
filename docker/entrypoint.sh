#!/bin/sh

# The staging database accepts only verify-full TLS. The root CA is supplied
# per runtime service and materialized with owner-only permissions at startup;
# it is never placed in the image or sent to the browser.
if [ "${SELENA_STAGING_MVP:-}" = "true" ]; then
	: "${SELENA_RUNTIME_DATABASE_CA_PEM:?SELENA_RUNTIME_DATABASE_CA_PEM is required for Selena staging runtimes}"

	umask 077
	certificate_path="$(mktemp "${TMPDIR:-/tmp}/selena-runtime-ca.XXXXXX")"
	printf '%s\n' "$SELENA_RUNTIME_DATABASE_CA_PEM" > "$certificate_path"
	unset SELENA_RUNTIME_DATABASE_CA_PEM

	configure_database_url() {
		variable_name="$1"
		connection_string="$2"
		[ -n "$connection_string" ] || return 0

		secure_url="$(
			node -e 'const [connectionString, certificatePath] = process.argv.slice(1); const url = new URL(connectionString); url.searchParams.set("sslmode", "verify-full"); url.searchParams.set("sslrootcert", certificatePath); process.stdout.write(url.toString());' "$connection_string" "$certificate_path"
		)"
		export "$variable_name=$secure_url"
	}

	configure_database_url "DATABASE_URL" "${DATABASE_URL:-}"
	configure_database_url "SELENA_WEB_DATABASE_URL" "${SELENA_WEB_DATABASE_URL:-}"
fi

# Database migrations are handled by the db-migrate init container.
# Execute the main command
exec "$@"

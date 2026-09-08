#!/bin/sh

set -eu

certificate_path=""

cleanup() {
	if [ -n "$certificate_path" ]; then
		rm -f "$certificate_path"
	fi
}

trap cleanup EXIT

if [ "${SELENA_STAGING_MVP:-}" = "true" ] || [ "${SELENA_RUNTIME_DB_VERIFY_TLS:-}" = "true" ]; then
	: "${SELENA_MIGRATION_DATABASE_URL:?SELENA_MIGRATION_DATABASE_URL is required for staging migrations}"
	: "${SELENA_MIGRATION_DATABASE_CA_PEM:?SELENA_MIGRATION_DATABASE_CA_PEM is required for staging migrations}"

	umask 077
	certificate_path="$(mktemp "${TMPDIR:-/tmp}/selena-migration-ca.XXXXXX")"
	printf '%s\n' "$SELENA_MIGRATION_DATABASE_CA_PEM" > "$certificate_path"

	export PGSSLMODE="verify-full"
	export PGSSLROOTCERT="$certificate_path"
	export SELENA_MIGRATION_DATABASE_URL="$(
		node -e 'const url = new URL(process.env.SELENA_MIGRATION_DATABASE_URL); url.searchParams.set("sslmode", "verify-full"); url.searchParams.set("sslrootcert", process.env.PGSSLROOTCERT); process.stdout.write(url.toString());'
	)"
fi

"$@"

#!/usr/bin/env bash
# Runs the guarded repository integration tests against a disposable database.
#
# The ordinary test suites skip these: they need a real database with the full
# migration chain AND a login that is a member of selena_web_runtime, because
# the point of the tests is that RLS refuses what it should. Running them as a
# superuser would pass while proving nothing.
#
#   packages/lib/scripts/run-integration.sh [database-name]
#
# The runtime login's password is generated here and never printed, stored or
# committed. It is carried into the connection string the tests use, because a
# cluster that authenticates loopback connections (scram, md5) refuses a URL
# that omits it — and a harness that only works under `trust` silently stops
# being runnable on the machines that have it turned on.
set -euo pipefail

DATABASE="${1:-selena_integration_run}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE="$(cd "${HERE}/.." && pwd)"
PSQL=(su postgres -c)

"${PSQL[@]}" "psql -q -d postgres -c 'drop database if exists ${DATABASE}'" >/dev/null 2>&1 || true
for role in selena_web_login selena_gateway_login selena_scanner_login selena_worker_login selena_ingestion_login; do
  "${PSQL[@]}" "psql -q -d postgres -c 'drop role if exists ${role}'" >/dev/null 2>&1 || true
done
"${PSQL[@]}" "psql -q -d postgres -c 'create database ${DATABASE}'"

# Hex, so it needs no percent-encoding to sit in a URL.
WEB_PASSWORD="$(openssl rand -hex 24)"
ADMIN_URL="postgresql://postgres@127.0.0.1:5432/${DATABASE}"
WEB_URL="postgresql://selena_web_login:${WEB_PASSWORD}@127.0.0.1:5432/${DATABASE}"

(
  cd "${PACKAGE}"
  SELENA_WEB_DB_PASSWORD="${WEB_PASSWORD}" DATABASE_URL="${ADMIN_URL}" node scripts/run-migrations.mjs
)

cd "${PACKAGE}"
DATABASE_URL="${WEB_URL}" \
SELENA_WEB_DATABASE_URL="${WEB_URL}" \
SELENA_DISPOSABLE_DATABASE_URL="${ADMIN_URL}" \
  pnpm exec vitest run src/*.integration.test.ts

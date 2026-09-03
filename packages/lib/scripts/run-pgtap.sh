#!/usr/bin/env bash
# Runs every pgTAP suite against a disposable database.
#
# The suites assert privileges, so they create roles — and roles live in the
# cluster, not in the database. Dropping the database leaves them behind, and
# the next run fails at "role already exists" with dozens of errors that look
# like a broken schema and are nothing of the kind. That has now cost two
# investigations, so the cleanup is here rather than in a note someone reads
# afterwards.
#
#   packages/lib/scripts/run-pgtap.sh [database-name]
#
# Requires a local Postgres with the pgtap extension available, and the
# migration runner's DATABASE_URL pointing at the same server.
set -euo pipefail

DATABASE="${1:-selena_pgtap_run}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUITES="${HERE}/../src/db/tests"
PSQL=(su postgres -c)

run_sql() { "${PSQL[@]}" "psql -q -d ${1} -c \"${2}\""; }

drop_test_roles() {
  local role
  for role in $("${PSQL[@]}" "psql -tAc \"select rolname from pg_roles where rolname like 'selena_pgtap%'\""); do
    "${PSQL[@]}" "psql -q -d ${DATABASE} -c 'drop owned by ${role} cascade'" >/dev/null 2>&1 || true
    "${PSQL[@]}" "psql -q -d postgres -c 'drop role if exists ${role}'" >/dev/null 2>&1 || true
  done
}

"${PSQL[@]}" "psql -q -d postgres -c 'drop database if exists ${DATABASE}'" >/dev/null 2>&1 || true
drop_test_roles
"${PSQL[@]}" "psql -q -d postgres -c 'create database ${DATABASE}'"

# The migration runner resolves its migrations folder from the working
# directory, so it is run from the package rather than from wherever this
# script was invoked.
(cd "${HERE}/.." && DATABASE_URL="postgresql://postgres@127.0.0.1:5432/${DATABASE}" node scripts/run-migrations.mjs)
run_sql "${DATABASE}" "create extension if not exists pgtap" >/dev/null

total=0
failures=0
for suite in "${SUITES}"/*.pgtap.sql; do
  drop_test_roles
  output="$("${PSQL[@]}" "psql -d ${DATABASE} -f ${suite}" 2>&1 || true)"
  passed="$(grep -c '^ ok' <<<"${output}" || true)"
  # A suite that dies on the first statement reports zero of both, so errors
  # are counted as well as explicit "not ok" lines.
  failed="$(grep -cE '^ not ok|ERROR' <<<"${output}" || true)"
  printf '%-56s ok=%-4s failed=%s\n' "$(basename "${suite}")" "${passed}" "${failed}"
  if [ "${failed}" -gt 0 ]; then printf '%s\n' "${output}" | grep -E '^ not ok|ERROR' | head -5; fi
  total=$((total + passed))
  failures=$((failures + failed))
done

drop_test_roles
echo "assertions=${total} failures=${failures}"
[ "${failures}" -eq 0 ]

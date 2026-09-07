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

# Supabase creates these; a bare cluster does not. Suites 0021 and 0023 assert
# grants against them, and without them those assertions do not fail — they
# abort the transaction, which reports as an error that reads like a broken
# schema and is nothing of the kind.
for role in anon authenticated service_role; do
  "${PSQL[@]}" "psql -q -d postgres -c 'create role ${role} nologin'" >/dev/null 2>&1 || true
done

# The migration runner resolves its migrations folder from the working
# directory, so it is run from the package rather than from wherever this
# script was invoked.
(cd "${HERE}/.." && DATABASE_URL="postgresql://postgres@127.0.0.1:5432/${DATABASE}" node scripts/run-migrations.mjs)
run_sql "${DATABASE}" "create extension if not exists pgtap" >/dev/null

# A harness that passes when it runs nothing is not a harness. An unmatched glob
# would otherwise report assertions=0 failures=0 and exit 0.
shopt -s nullglob
suites=("${SUITES}"/*.pgtap.sql)
if [ ${#suites[@]} -eq 0 ]; then
  echo "no pgTAP suites found under ${SUITES}" >&2
  exit 1
fi

total=0
failures=0
for suite in "${suites[@]}"; do
  drop_test_roles
  output="$("${PSQL[@]}" "psql -d ${DATABASE} -f ${suite}" 2>&1 || true)"
  passed="$(grep -c '^ ok' <<<"${output}" || true)"
  # A suite that dies on the first statement reports zero of both, so errors
  # are counted as well as explicit "not ok" lines.
  failed="$(grep -cE '^ not ok|ERROR' <<<"${output}" || true)"
  # A suite that stops short of its plan emits neither "not ok" nor ERROR — it
  # emits a diagnostic. Without this, a suite that quietly ran half its
  # assertions reports failures=0.
  failed=$((failed + $(grep -cE '^ *# Looks like you planned' <<<"${output}" || true)))
  printf '%-56s ok=%-4s failed=%s\n' "$(basename "${suite}")" "${passed}" "${failed}"
  if [ "${failed}" -gt 0 ]; then
    printf '%s\n' "${output}" | grep -E '^ not ok|ERROR|^ *# Looks like you planned' | head -5
  fi
  total=$((total + passed))
  failures=$((failures + failed))
done

drop_test_roles
echo "assertions=${total} failures=${failures}"
[ "${failures}" -eq 0 ]

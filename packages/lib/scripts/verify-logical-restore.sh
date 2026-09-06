#!/bin/sh
# Take a logical archive of a database and restore it somewhere isolated, then
# prove the copy is the same database.
#
# A snapshot that has never been restored is a promise, not a backup. This makes
# the archive, restores it into a throwaway instance, and compares a fingerprint
# of both: the migration ledger, every table's row count, the roles, the grants,
# the policies, and whether row level security is still on. Data is streamed
# from one server into the other and is never written to a log or a file that
# outlives the run — the output is counts, names and hashes only.
#
# Reads:  SOURCE_DATABASE_URL   the database to copy (read-only use)
#         TARGET_DATABASE_URL   where to restore it (must be empty)
#         COMPARE_ONLY=true     skip the copy and only compare what is there,
#                               which is how an existing copy is re-checked
#
# Both sides are fingerprinted by the same SQL, so a difference is a real
# difference and not two implementations disagreeing.
set -eu

: "${SOURCE_DATABASE_URL:?SOURCE_DATABASE_URL is required}"
: "${TARGET_DATABASE_URL:?TARGET_DATABASE_URL is required}"

SCHEMAS="'public','drizzle','selena_registry','selena_release','selena_audit','selena_ingest_raw'"

fingerprint_sql() {
	cat <<SQL
\\pset footer off
\\pset tuples_only on
SELECT 'ledger.rows      ' || count(*) FROM drizzle.__drizzle_migrations;
SELECT 'ledger.hashes    ' || coalesce(md5(string_agg(hash, ',' ORDER BY hash)), 'none') FROM drizzle.__drizzle_migrations;
SELECT 'ledger.newest    ' || coalesce(max(created_at)::text, 'none') FROM drizzle.__drizzle_migrations;
SELECT 'schemas          ' || string_agg(nspname, ',' ORDER BY nspname) FROM pg_namespace WHERE nspname IN ($SCHEMAS);
SELECT 'tables           ' || count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r' AND n.nspname IN ($SCHEMAS);
SELECT 'rls.enabled      ' || count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relrowsecurity AND n.nspname IN ($SCHEMAS);
SELECT 'rls.forced       ' || count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relforcerowsecurity AND n.nspname IN ($SCHEMAS);
SELECT 'policies         ' || count(*) FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ($SCHEMAS);
SELECT 'policies.hash    ' || coalesce(md5(string_agg(n.nspname || '.' || c.relname || '.' || p.polname, ',' ORDER BY n.nspname, c.relname, p.polname)), 'none')
  FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ($SCHEMAS);
SELECT 'functions        ' || count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ($SCHEMAS);
SELECT 'functions.hash   ' || coalesce(md5(string_agg(n.nspname || '.' || p.proname, ',' ORDER BY n.nspname, p.proname)), 'none')
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ($SCHEMAS);
SELECT 'roles.selena     ' || coalesce(string_agg(rolname, ',' ORDER BY rolname), 'none') FROM pg_roles WHERE rolname LIKE 'selena%';
SELECT 'grants           ' || count(*) FROM information_schema.role_table_grants WHERE grantee LIKE 'selena%' AND table_schema IN ($SCHEMAS);
SELECT 'grants.hash      ' || coalesce(md5(string_agg(grantee || '.' || table_schema || '.' || table_name || '.' || privilege_type, ',' ORDER BY grantee, table_schema, table_name, privilege_type)), 'none')
  FROM information_schema.role_table_grants WHERE grantee LIKE 'selena%' AND table_schema IN ($SCHEMAS);
SELECT 'column.grants    ' || count(*) FROM information_schema.column_privileges WHERE grantee LIKE 'selena%' AND table_schema IN ($SCHEMAS);
-- Every table's row count, so a restore that lost rows cannot look identical.
SELECT 'rows.' || rpad(t, 40) || ' ' || n FROM (
  SELECT n.nspname || '.' || c.relname AS t,
         (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint AS n
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r' AND n.nspname IN ($SCHEMAS)
) counted WHERE n > 0 ORDER BY t;
SELECT 'rows.total       ' || sum(n) FROM (
  SELECT (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint AS n
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r' AND n.nspname IN ($SCHEMAS)
) counted;
SQL
}

echo "=== fingerprinting the source ==="
fingerprint_sql | psql "$SOURCE_DATABASE_URL" -v ON_ERROR_STOP=1 -q | sed '/^$/d' > /tmp/source.fingerprint
cat /tmp/source.fingerprint

if [ "${COMPARE_ONLY:-}" = "true" ]; then
	echo ""
	echo "=== comparing only; nothing was copied ==="
else

echo ""
echo "=== restoring roles (no passwords are read or written) ==="
# Roles live in the cluster, not the database, so a dump of the database alone
# restores grants that refer to roles nobody has created. Passwords are not
# copied: this copy is never a place anyone signs in to.
pg_dumpall --roles-only --no-role-passwords --dbname "$SOURCE_DATABASE_URL" \
	| grep -v '^CREATE ROLE postgres;' \
	| psql "$TARGET_DATABASE_URL" -q 2>&1 \
	| grep -v 'already exists' || true

echo "=== copying the database ==="
# Streamed from one server to the other: the archive is never a file on disk and
# never reaches a log.
pg_dump --format=custom --dbname "$SOURCE_DATABASE_URL" \
	| pg_restore --dbname "$TARGET_DATABASE_URL" --exit-on-error --verbose 2>/tmp/restore.log \
	|| { echo "restore failed; last lines of its log:"; tail -20 /tmp/restore.log; exit 1; }
echo "restore completed without error"
fi

echo ""
echo "=== fingerprinting the restored copy ==="
fingerprint_sql | psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 -q | sed '/^$/d' > /tmp/target.fingerprint
cat /tmp/target.fingerprint

echo ""
echo "=== comparison ==="
if diff -u /tmp/source.fingerprint /tmp/target.fingerprint > /tmp/fingerprint.diff; then
	echo "VERDICT: the restored copy matches the source on every checked property"
else
	echo "VERDICT: the restored copy differs from the source"
	cat /tmp/fingerprint.diff
	exit 1
fi

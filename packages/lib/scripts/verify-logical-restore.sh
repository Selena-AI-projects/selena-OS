#!/bin/sh
# Take a logical archive of a database, restore it somewhere isolated, and
# compare the two.
#
# A snapshot that has never been restored is a promise, not a backup. This makes
# the archive, restores it into a throwaway instance, and compares a fingerprint
# of both. What the fingerprint covers, exactly: the migration ledger, the
# schemas, the number of tables, whether row level security is enabled and
# forced, the policies by name, the functions by signature and body, the roles,
# object ownership, table and column privileges granted to anyone but the owner,
# the indexes and constraints by name,
# and every table's row count. What it does NOT cover: column types and
# defaults, sequence values, triggers, and the content of any row. A match means
# those listed properties agree, not that every byte does.
#
# Reads:  SOURCE_DATABASE_URL   the database to copy (read-only use)
#         TARGET_DATABASE_URL   where to restore it (must be empty, must not be
#                               the source)
#         COMPARE_ONLY=true     skip the copy and only compare what is there,
#                               which is how an existing copy is re-checked
#
# Both URLs must name a role that bypasses row level security — a superuser or
# a BYPASSRLS role. Several of these tables force row level security, under
# which even the owner reads zero rows and `pg_dump` refuses outright.
#
# Nothing here writes the archive to disk: it is streamed from one server into
# the other. Temporary files hold fingerprints, role
# definitions and error logs only, under a directory removed when the script
# exits.
set -eu

: "${SOURCE_DATABASE_URL:?SOURCE_DATABASE_URL is required}"
: "${TARGET_DATABASE_URL:?TARGET_DATABASE_URL is required}"

work=$(mktemp -d)
# Restore output can quote a row it failed to insert, so nothing here outlives
# the run even when it fails.
trap 'rm -rf "$work"' EXIT INT TERM

SCHEMAS="'public','drizzle','selena_registry','selena_release','selena_audit','selena_ingest_raw'"

# `psql` in a pipeline hands its exit status to the last command, and this is
# /bin/sh, where `set -o pipefail` does not exist. So every psql runs on its own
# and its status is checked.
# Postgres puts the offending value in the primary error line as often as in the
# DETAIL below it, so the safe direction is to keep the shape of the failure and
# drop the rest, rather than to strip the lines known to be dangerous.
withhold_row_content() {
	sed -e 's/\(ERROR:[^:]*\):.*/\1: (message withheld)/' \
	    -e '/^DETAIL/d' -e '/^CONTEXT/d' -e '/Failing row/d' "$1" | tail -20
}

run_sql() {
	psql "$1" -v ON_ERROR_STOP=1 -q -f "$2" -o "$3"
}

identity_of() {
	psql "$1" -v ON_ERROR_STOP=1 -tAc \
		"SELECT system_identifier || '/' || current_database() FROM pg_control_system()"
}

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
-- Signature and body, so a function restored with different code is a difference.
SELECT 'functions.hash   ' || coalesce(md5(string_agg(p.oid::regprocedure::text || ':' || md5(coalesce(p.prosrc, '')), ',' ORDER BY p.oid::regprocedure::text)), 'none')
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ($SCHEMAS);
SELECT 'indexes.hash     ' || coalesce(md5(string_agg(n.nspname || '.' || c.relname, ',' ORDER BY n.nspname, c.relname)), 'none')
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'i' AND n.nspname IN ($SCHEMAS);
SELECT 'constraints.hash ' || coalesce(md5(string_agg(n.nspname || '.' || t.conname || ':' || t.contype::text, ',' ORDER BY n.nspname, t.conname)), 'none')
  FROM pg_constraint t JOIN pg_namespace n ON n.oid = t.connamespace WHERE n.nspname IN ($SCHEMAS);
SELECT 'roles.selena     ' || coalesce(string_agg(rolname, ',' ORDER BY rolname), 'none') FROM pg_roles WHERE rolname LIKE 'selena%';
-- Privileges are read from the catalogue rather than information_schema, whose
-- rows depend on who is asking; these do not. Grants to an object's own owner
-- are excluded: the owner holds them whether the ACL is stored explicitly or
-- left null, and a dump and restore legitimately turns the one into the other.
SELECT 'owners.hash      ' || coalesce(md5(string_agg(n.nspname || '.' || c.relname || '=' || pg_get_userbyid(c.relowner), ',' ORDER BY n.nspname, c.relname)), 'none')
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r','v','m','S') AND n.nspname IN ($SCHEMAS);
SELECT 'grants           ' || count(*) FROM (
  SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
       LATERAL aclexplode(c.relacl) a
  WHERE c.relkind IN ('r','v','m','S') AND n.nspname IN ($SCHEMAS) AND a.grantee <> c.relowner
) granted;
SELECT 'grants.hash      ' || coalesce(md5(string_agg(entry, ',' ORDER BY entry)), 'none') FROM (
  SELECT n.nspname || '.' || c.relname || ':' || pg_get_userbyid(a.grantee) || ':' || a.privilege_type AS entry
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace,
       LATERAL aclexplode(c.relacl) a
  WHERE c.relkind IN ('r','v','m','S') AND n.nspname IN ($SCHEMAS) AND a.grantee <> c.relowner
) granted;
SELECT 'column.grants    ' || count(*) FROM (
  SELECT 1 FROM pg_attribute att JOIN pg_class c ON c.oid = att.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace,
       LATERAL aclexplode(att.attacl) a
  WHERE n.nspname IN ($SCHEMAS) AND a.grantee <> c.relowner
) granted;
SELECT 'column.grants.hash ' || coalesce(md5(string_agg(entry, ',' ORDER BY entry)), 'none') FROM (
  SELECT n.nspname || '.' || c.relname || '.' || att.attname || ':' || pg_get_userbyid(a.grantee) || ':' || a.privilege_type AS entry
  FROM pg_attribute att JOIN pg_class c ON c.oid = att.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace,
       LATERAL aclexplode(att.attacl) a
  WHERE n.nspname IN ($SCHEMAS) AND a.grantee <> c.relowner
) granted;
-- Every table, including the empty ones: a table dropped from one side only
-- would otherwise vanish from both fingerprints and compare equal.
SELECT 'rows.' || rpad(t, 40) || ' ' || n FROM (
  SELECT n.nspname || '.' || c.relname AS t,
         (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint AS n
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r' AND n.nspname IN ($SCHEMAS)
) counted ORDER BY t;
SELECT 'rows.total       ' || sum(n) FROM (
  SELECT (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint AS n
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r' AND n.nspname IN ($SCHEMAS)
) counted;
SQL
}

fingerprint_sql > "$work/fingerprint.sql"

echo "=== fingerprinting the source ==="
run_sql "$SOURCE_DATABASE_URL" "$work/fingerprint.sql" "$work/source.fingerprint"
sed -i '/^$/d' "$work/source.fingerprint"
[ -s "$work/source.fingerprint" ] || { echo "the source fingerprint came back empty; refusing to compare nothing"; exit 1; }
cat "$work/source.fingerprint"

# Two databases, always. Comparing a database with itself would otherwise print
# this script's strongest verdict having proved nothing at all — and on the copy
# path it would create roles and tables in the database being copied.
# Assigned rather than inlined into `[ ]`, where a failure would escape `set -e`.
echo ""
echo "=== checking the target is a different database ==="
source_identity=$(identity_of "$SOURCE_DATABASE_URL")
target_identity=$(identity_of "$TARGET_DATABASE_URL")
[ -n "$source_identity" ] || { echo "could not read the source's identity"; exit 1; }
[ -n "$target_identity" ] || { echo "could not read the target's identity"; exit 1; }
if [ "$source_identity" = "$target_identity" ]; then
	echo "the target is the same database as the source; there is nothing to compare"
	exit 1
fi
echo "target is not the source"

if [ "${COMPARE_ONLY:-}" = "true" ]; then
	echo ""
	echo "=== comparing only; nothing was copied ==="
else
	echo ""
	echo "=== checking the target is empty ==="
	occupied=$(psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 -tAc \
		"SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ($SCHEMAS)")
	if [ "$occupied" != "0" ]; then
		echo "the target already holds $occupied object(s) in the schemas being restored; refusing to write over them"
		exit 1
	fi
	echo "target is empty"

	echo ""
	echo "=== restoring roles (no passwords are read or written) ==="
	# Roles live in the cluster, not the database, so a dump of the database
	# alone restores grants that refer to roles nobody has created. Passwords are
	# not copied: this copy is never a place anyone signs in to.
	if ! pg_dumpall --roles-only --no-role-passwords --dbname "$SOURCE_DATABASE_URL" > "$work/roles.all"; then
		echo "could not read the source's roles"
		exit 1
	fi
	grep -v '^CREATE ROLE postgres;' "$work/roles.all" > "$work/roles.sql"
	# A role that already exists is the expected case, not a failure; anything
	# else is, so the status is checked rather than discarded by a pipe.
	if ! psql "$TARGET_DATABASE_URL" -q -f "$work/roles.sql" > "$work/roles.log" 2>&1; then
		if grep -qv 'already exists' "$work/roles.log"; then
			echo "restoring roles failed:"
			grep -v 'already exists' "$work/roles.log" | tail -10
			exit 1
		fi
	fi

	echo "=== copying the database ==="
	# Streamed from one server to the other through a named pipe, so the archive
	# is never a file: a file would survive a SIGKILL that the cleanup trap
	# cannot answer, and it holds every row in the database. The pipe also lets
	# both exit statuses be read, which a plain shell pipeline in /bin/sh
	# cannot — it reports only the last command's.
	# A real pipeline, so the archive is never a file: a file would survive a
	# SIGKILL the cleanup trap cannot answer, and it holds every row in the
	# database. /bin/sh reports only the last command's status and has no
	# pipefail, so pg_dump records its own failure in a file the pipeline's
	# subshell can write and this shell can read. (A named pipe does not work
	# here: given an archive as a path, pg_restore seeks.)
	restore_status=0
	{ pg_dump --format=custom --dbname "$SOURCE_DATABASE_URL" 2> "$work/dump.log" \
		|| echo $? > "$work/dump.failed"; } \
		| pg_restore --dbname "$TARGET_DATABASE_URL" --exit-on-error > "$work/restore.log" 2>&1 \
		|| restore_status=$?
	if [ -f "$work/dump.failed" ]; then
		echo "pg_dump failed; the copy is incomplete:"
		withhold_row_content "$work/dump.log"
		exit 1
	fi
	if [ "$restore_status" != "0" ]; then
		echo "restore failed. Its log can quote a row it could not insert, so only what names no data:"
		withhold_row_content "$work/restore.log"
		exit 1
	fi
	echo "restore completed without error"
fi

echo ""
echo "=== fingerprinting the restored copy ==="
run_sql "$TARGET_DATABASE_URL" "$work/fingerprint.sql" "$work/target.fingerprint"
sed -i '/^$/d' "$work/target.fingerprint"
[ -s "$work/target.fingerprint" ] || { echo "the copy's fingerprint came back empty; refusing to call that a match"; exit 1; }
cat "$work/target.fingerprint"

echo ""
echo "=== comparison ==="
if diff -u "$work/source.fingerprint" "$work/target.fingerprint" > "$work/fingerprint.diff"; then
	echo "VERDICT: the restored copy matches the source on every checked property"
else
	echo "VERDICT: the restored copy differs from the source"
	cat "$work/fingerprint.diff"
	exit 1
fi

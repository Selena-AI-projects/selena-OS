/**
 * Read-only inspection of a Selena database before anything is migrated.
 *
 * The question this answers is the one a deploy log cannot: which migrations
 * this database actually holds, whether each recorded hash is the file in this
 * checkout, which migrations from another branch have landed here, whether the
 * migrations this checkout would add can still apply at all, and which objects
 * and roles exist. A count and a deploy date do not answer any of that.
 *
 * Everything runs in one READ ONLY transaction with a statement timeout, so it
 * cannot write and cannot hold a lock for long. The report carries names,
 * booleans, counts and migration-file hashes only: never a connection string,
 * never a role password, never the content of a row.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "pg";
import { connectionSettings, redact } from "./db-connection.mjs";

const databaseUrl = process.env.SELENA_MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the inspector");

const migrationsFolder = resolve(process.cwd(), "src/db/migrations");
const STATEMENT_TIMEOUT_MS = 15_000;

/**
 * Migrations known to belong to another branch, by the hash drizzle records.
 * Empty while every branch's migrations live in this checkout; an entry here
 * turns "a row nobody can name" into "the row that branch is responsible for",
 * which is the difference between a mystery and a coordination problem.
 */
const KNOWN_FOREIGN = new Map();

/**
 * Objects each migration is responsible for, so "applied" is checked against the
 * schema too. Read from the catalogue rather than `information_schema`, whose
 * views hide anything the querying role has no privilege on — a missing column
 * and an unreadable one would otherwise look the same.
 */
const OBJECT_CHECKS = [
	["0021 content registry", "to_regclass('selena_registry.content_items') IS NOT NULL"],
	["0021 content versions", "to_regclass('selena_registry.content_versions') IS NOT NULL"],
	["0027 content policies", "to_regclass('selena_registry.content_policies') IS NOT NULL"],
	["0035 aether inbox", "to_regclass('selena_ingest_raw.aether_events') IS NOT NULL"],
	[
		"0035 record_aether_event",
		"to_regprocedure('selena_ingest_raw.record_aether_event(uuid,text,text,uuid,uuid,integer,timestamptz,uuid,jsonb,text)') IS NOT NULL",
	],
	["0036 gateway signing keys", "to_regclass('selena_release.gateway_signing_keys') IS NOT NULL"],
	[
		"0037 (foreign) brand content profiles",
		"to_regclass('selena_registry.brand_content_profile_versions') IS NOT NULL",
	],
	["0037 (foreign) content channels", "to_regclass('selena_registry.content_channels') IS NOT NULL"],
	["0038 growth bindings", "to_regclass('selena_registry.growth_project_bindings') IS NOT NULL"],
	[
		"0038 confirm_growth_binding",
		"to_regprocedure('selena_registry.confirm_growth_binding(text,uuid,text,text)') IS NOT NULL",
	],
	["0038 resolve_growth_binding", "to_regprocedure('selena_registry.resolve_growth_binding(uuid,text)') IS NOT NULL"],
	[
		"0039 aether_events.projected_content_version_id",
		"EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid " +
			"JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'selena_ingest_raw' AND c.relname = 'aether_events' " +
			"AND a.attname = 'projected_content_version_id' AND a.attnum > 0 AND NOT a.attisdropped)",
	],
	[
		"0039 aether_events.projection_attempts",
		"EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid " +
			"JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'selena_ingest_raw' AND c.relname = 'aether_events' " +
			"AND a.attname = 'projection_attempts' AND a.attnum > 0 AND NOT a.attisdropped)",
	],
	// 0039 adds this column outright, so a "yes" before migrating is not evidence
	// that 0039 ran — it is a warning that 0039 will fail.
	[
		"0039 content_items.kind",
		"EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid " +
			"JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'selena_registry' AND c.relname = 'content_items' " +
			"AND a.attname = 'kind' AND a.attnum > 0 AND NOT a.attisdropped)",
	],
	[
		"0039 claim_next_aether_draft_event",
		"to_regprocedure('selena_ingest_raw.claim_next_aether_draft_event()') IS NOT NULL",
	],
	[
		"0039 defer_aether_event_projection",
		"to_regprocedure('selena_ingest_raw.defer_aether_event_projection(uuid,text)') IS NOT NULL",
	],
];

/** Group roles and their logins. Only the name and whether it can log in — never a password. */
const ROLES = [
	"selena_schema_owner",
	"selena_web_runtime",
	"selena_registry_worker_runtime",
	"selena_ingestion_runtime",
	"selena_gateway_runtime",
	"selena_web_login",
	"selena_worker_login",
	"selena_ingestion_login",
	"selena_gateway_login",
];

/** Tables the Growth run touches. Counts only, so an unexpected population is visible without reading it. */
const COUNTED_TABLES = [
	"public.organization",
	"public.brands",
	"selena_registry.content_policies",
	"selena_registry.content_items",
	"selena_registry.content_versions",
	"selena_registry.growth_project_bindings",
	"selena_registry.approvals",
	"selena_ingest_raw.aether_events",
	"selena_release.release_intents",
	"selena_release.release_manifests",
	"selena_release.publication_attempts",
];

/**
 * Lock modes a migration takes and ordinary reads and writes do not. `pg_locks`
 * is readable by every role, unlike the query text in `pg_stat_activity`, so
 * this answers "is someone migrating right now" without depending on privilege.
 *
 * `ShareUpdateExclusiveLock` is deliberately absent: it is what VACUUM and
 * ANALYZE take, so autovacuum would raise this alarm continuously on a live
 * database. Nothing is lost by leaving it out — altering a table takes
 * `AccessExclusiveLock`, which is listed.
 */
const DDL_LOCK_MODES = ["AccessExclusiveLock", "ExclusiveLock", "ShareRowExclusiveLock", "ShareLock"];

const WATCHED_SCHEMAS = ["public", "drizzle", "selena_registry", "selena_release", "selena_audit", "selena_ingest_raw"];

function readLocalMigrations() {
	const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"));
	return journal.entries.map((entry) => ({
		idx: entry.idx,
		tag: entry.tag,
		when: entry.when,
		hash: createHash("sha256")
			.update(readFileSync(join(migrationsFolder, `${entry.tag}.sql`)))
			.digest("hex"),
	}));
}

function journalGaps(local) {
	const onDisk = readdirSync(migrationsFolder)
		.filter((name) => name.endsWith(".sql"))
		.map((name) => name.replace(/\.sql$/, ""));
	const inJournal = new Set(local.map((entry) => entry.tag));
	const missing = onDisk.filter((tag) => !inJournal.has(tag));
	return missing;
}

async function main() {
	const local = readLocalMigrations();
	const untracked = journalGaps(local);
	const byHash = new Map(local.map((entry) => [entry.hash, entry]));

	// The same transport rules the migration runner enforces on this database,
	// plus a connect timeout: the statement and lock timeouts below only start
	// once a connection exists, so a host that never answers would hang past both.
	const client = new Client({ ...connectionSettings(databaseUrl), connectionTimeoutMillis: 15_000 });
	await client.connect();
	const report = {
		database: null,
		ledger: [],
		applied: [],
		missing: [],
		foreign: [],
		concurrency: {},
		objects: {},
		roles: {},
		counts: {},
		untracked_files: untracked,
		newest_recorded: null,
		would_be_skipped: [],
	};
	try {
		await client.query("BEGIN TRANSACTION READ ONLY");
		await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
		await client.query("SET LOCAL lock_timeout = 2000");
		await client.query("SET LOCAL idle_in_transaction_session_timeout = 60000");

		const identity = await client.query(
			"SELECT current_database() AS database, current_user AS role, session_user AS login, version() AS server",
		);
		report.database = identity.rows[0].database;
		console.log(`database: ${identity.rows[0].database}`);
		console.log(`connected as: session_user=${identity.rows[0].login} current_user=${identity.rows[0].role}`);
		console.log(`server: ${identity.rows[0].server.split(" on ")[0]}`);
		console.log("");

		// Whether anything else is mid-migration right now. A finished deploy says
		// nothing about a process still running, and two migrators on one database
		// is the failure this is here to prevent.
		const others = await client.query(
			`SELECT usename, coalesce(state, 'not visible to this login') AS state, count(*)::int AS sessions
			   FROM pg_stat_activity
			  WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'
			  GROUP BY 1, 2 ORDER BY 1, 2`,
		);
		// `pg_locks` spans the cluster, and its `relation` is an OID that means
		// nothing outside its own database — hence the explicit database filter.
		const ledgerLocks = await client.query(
			`SELECT l.pid, l.mode, l.granted
			   FROM pg_locks l JOIN pg_class c ON c.oid = l.relation JOIN pg_namespace n ON n.oid = c.relnamespace
			  WHERE l.pid <> pg_backend_pid()
			    AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
			    AND n.nspname = 'drizzle' AND c.relname = '__drizzle_migrations'`,
		);
		const ddlLocks = await client.query(
			`SELECT l.pid, l.mode, n.nspname || '.' || c.relname AS relation
			   FROM pg_locks l
			   JOIN pg_class c ON c.oid = l.relation
			   JOIN pg_namespace n ON n.oid = c.relnamespace
			   JOIN pg_stat_activity a ON a.pid = l.pid
			  WHERE l.pid <> pg_backend_pid()
			    AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
			    AND a.backend_type = 'client backend'
			    AND l.mode = ANY($1::text[]) AND n.nspname = ANY($2::text[])
			  ORDER BY 3, 2`,
			[DDL_LOCK_MODES, WATCHED_SCHEMAS],
		);
		report.concurrency = {
			sessions: others.rows.map((row) => ({ user: row.usename, state: row.state, count: row.sessions })),
			ledger_locks: ledgerLocks.rows.map((row) => ({ pid: row.pid, mode: row.mode, granted: row.granted })),
			ddl_locks: ddlLocks.rows.map((row) => ({ pid: row.pid, mode: row.mode, relation: row.relation })),
		};
		console.log("other sessions in this database (no query text is read):");
		if (others.rows.length === 0) console.log("  none");
		for (const row of others.rows) console.log(`  ${String(row.sessions).padStart(3)}  ${row.usename} — ${row.state}`);
		console.log(
			ledgerLocks.rows.length === 0
				? "locks on the migration ledger by another session: none"
				: `LOCKS ON THE MIGRATION LEDGER BY ANOTHER SESSION: ${ledgerLocks.rows.length}`,
		);
		for (const row of ledgerLocks.rows) console.log(`  pid=${row.pid} ${row.mode} granted=${row.granted}`);
		console.log(
			ddlLocks.rows.length === 0
				? "migration-shaped locks held elsewhere: none"
				: `MIGRATION-SHAPED LOCKS HELD ELSEWHERE: ${ddlLocks.rows.length}`,
		);
		for (const row of ddlLocks.rows) console.log(`  pid=${row.pid} ${row.mode} ${row.relation}`);
		console.log("");

		const ledgerExists = await client.query("SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS exists");
		if (!ledgerExists.rows[0].exists) {
			console.log("ledger: drizzle.__drizzle_migrations does not exist — this database has never been migrated");
			report.ledger = null;
		} else {
			const rows = await client.query(
				"SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at, id",
			);
			report.ledger = rows.rows.map((row) => ({ hash: row.hash, created_at: Number(row.created_at) }));
			const recorded = new Map(report.ledger.map((row) => [row.hash, row]));

			console.log(`ledger rows: ${report.ledger.length}`);
			console.log("");
			console.log("this checkout's migrations against the ledger:");
			for (const entry of local) {
				const row = recorded.get(entry.hash);
				const state = row ? "applied" : "NOT applied";
				if (row) report.applied.push(entry.tag);
				else report.missing.push(entry.tag);
				console.log(
					`  ${entry.tag.padEnd(46)} when=${entry.when} ${state}${row ? ` recorded_at=${row.created_at}` : ""}`,
				);
			}

			console.log("");
			const unknown = report.ledger.filter((row) => !byHash.has(row.hash));
			if (unknown.length === 0) {
				console.log("ledger rows not in this checkout: none");
			} else {
				console.log(`ledger rows not in this checkout: ${unknown.length}`);
				for (const row of unknown) {
					const label = KNOWN_FOREIGN.get(row.hash) ?? "UNKNOWN to this checkout and to its foreign list";
					report.foreign.push({ hash: row.hash, created_at: row.created_at, label });
					console.log(`  created_at=${row.created_at} ${label}`);
					console.log(`    hash=${row.hash}`);
				}
			}

			// The ordering question: drizzle applies a migration only when its journal
			// `when` is greater than the newest created_at already recorded. A pending
			// migration below that line is skipped in silence, and the run still reports
			// success — which is the failure this whole inspection exists to catch.
			// Drizzle takes the first row of `ORDER BY created_at DESC`, and a null
			// sorts first there, so a maximum would quietly disagree with it.
			const nullDated = rows.rows.filter((row) => row.created_at === null).length;
			if (nullDated > 0) {
				console.log(`WARNING: ${nullDated} ledger row(s) have no created_at; drizzle would treat the newest as absent`);
			}
			const { rows: newestRows } = await client.query(
				"SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1",
			);
			const newest = Number(newestRows[0]?.created_at ?? 0);
			report.null_dated_ledger_rows = nullDated;
			report.newest_recorded = newest;
			console.log("");
			console.log(`newest created_at in ledger: ${newest}`);
			const pending = local.filter((entry) => !recorded.has(entry.hash));
			const skippable = pending.filter((entry) => entry.when <= newest);
			report.would_be_skipped = skippable.map((entry) => entry.tag);
			if (pending.length === 0) {
				console.log("pending migrations: none");
			} else if (skippable.length === 0) {
				console.log(`pending migrations: ${pending.map((entry) => entry.tag).join(", ")} — all newer, all would apply`);
			} else {
				console.log("PENDING MIGRATIONS THAT WOULD BE SILENTLY SKIPPED:");
				for (const entry of skippable) {
					console.log(`  ${entry.tag} when=${entry.when} <= newest=${newest}`);
				}
			}
		}

		console.log("");
		console.log("objects:");
		for (const [label, predicate] of OBJECT_CHECKS) {
			// Same savepoint as the counts: a predicate can raise rather than return
			// null — `to_regclass` on a schema this login cannot use, for one — and
			// a read-only transaction refuses everything after its first error.
			await client.query("SAVEPOINT checked");
			try {
				const { rows } = await client.query(`SELECT (${predicate}) AS present`);
				await client.query("RELEASE SAVEPOINT checked");
				report.objects[label] = rows[0].present === true;
				console.log(`  ${rows[0].present ? "yes" : "no "}  ${label}`);
			} catch (error) {
				await client.query("ROLLBACK TO SAVEPOINT checked");
				report.objects[label] = { error: error?.code ?? "error" };
				console.log(`  ???  ${label} (${error?.code ?? "error"})`);
			}
		}

		console.log("");
		console.log("roles:");
		const roleRows = await client.query(
			"SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname",
			[ROLES],
		);
		const present = new Map(roleRows.rows.map((row) => [row.rolname, row.rolcanlogin]));
		for (const role of ROLES) {
			const exists = present.has(role);
			report.roles[role] = exists ? { login: present.get(role) } : null;
			console.log(`  ${exists ? "yes" : "no "}  ${role}${exists ? (present.get(role) ? " (login)" : " (group)") : ""}`);
		}

		console.log("");
		// A count is what this login is allowed to see, not what the table holds.
		// Most of these force row level security, and under it even the table's
		// owner is filtered unless a request context is set — so the flag is
		// printed beside the number rather than leaving a 0 to be misread.
		console.log("rows visible to this login (no content is read):");
		const tableFacts = await client.query(
			`SELECT n.nspname || '.' || c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
			        has_table_privilege(c.oid, 'SELECT') AS readable
			   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
			  WHERE c.relkind = 'r' AND n.nspname || '.' || c.relname = ANY($1::text[])`,
			[COUNTED_TABLES],
		);
		const facts = new Map(tableFacts.rows.map((row) => [row.name, row]));
		for (const table of COUNTED_TABLES) {
			const fact = facts.get(table);
			if (!fact) {
				report.counts[table] = null;
				console.log(`  ${"absent".padStart(8)}  ${table}`);
				continue;
			}
			const note = fact.forced ? " (forced RLS)" : fact.rls ? " (RLS)" : "";
			if (!fact.readable) {
				report.counts[table] = { readable: false, forced_rls: fact.forced };
				console.log(`  ${"no read".padStart(8)}  ${table}${note}`);
				continue;
			}
			// One savepoint per count. A read-only transaction refuses everything
			// after its first error, so without this a single lock timeout — the
			// very thing worth reporting — would destroy the rest of the report.
			await client.query("SAVEPOINT counted");
			try {
				const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
				await client.query("RELEASE SAVEPOINT counted");
				report.counts[table] = { rows: rows[0].n, forced_rls: fact.forced };
				console.log(`  ${String(rows[0].n).padStart(8)}  ${table}${note}`);
			} catch (error) {
				await client.query("ROLLBACK TO SAVEPOINT counted");
				const code = error?.code ?? "error";
				report.counts[table] = { error: code, forced_rls: fact.forced };
				console.log(`  ${String(code).padStart(8)}  ${table}${note}`);
			}
		}
	} finally {
		await client.query("ROLLBACK").catch(() => undefined);
		await client.end();
	}

	if (untracked.length > 0) {
		console.log("");
		console.log(`WARNING: migration files not in this checkout's journal: ${untracked.join(", ")}`);
	}
	console.log("");
	console.log(`INSPECTOR_JSON ${JSON.stringify(report)}`);
	console.log("inspection complete; nothing was written");
}

main().catch((error) => {
	// The message only, and scrubbed: a stack from `pg` carries the connection target.
	console.error(`inspection failed: ${redact(error instanceof Error ? error.message : "unknown error")}`);
	process.exitCode = 1;
});

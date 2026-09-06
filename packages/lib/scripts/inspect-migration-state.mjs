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

const databaseUrl = process.env.SELENA_MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the inspector");

const migrationsFolder = resolve(process.cwd(), "src/db/migrations");
const STATEMENT_TIMEOUT_MS = 15_000;

/**
 * Migrations known to belong to another branch. Drizzle records a hash of the
 * file, so a row whose hash matches none of ours is either one of these or
 * something nobody in this checkout can name — and the difference matters.
 */
const KNOWN_FOREIGN = new Map([
	[
		"bd0e108b86f71137ffb530a9d234fc34a529aaf3c813d8b2e21a840ca79310d7",
		"0037_content_project_profiles (branch feat/content-os-slice1)",
	],
]);

/** Objects each migration is responsible for, so "applied" is checked against the schema too. */
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
		"EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'selena_ingest_raw' AND table_name = 'aether_events' AND column_name = 'projected_content_version_id')",
	],
	[
		"0039 aether_events.projection_attempts",
		"EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'selena_ingest_raw' AND table_name = 'aether_events' AND column_name = 'projection_attempts')",
	],
	[
		"0039 content_items.kind",
		"EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'selena_registry' AND table_name = 'content_items' AND column_name = 'kind')",
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
 */
const DDL_LOCK_MODES = [
	"AccessExclusiveLock",
	"ExclusiveLock",
	"ShareRowExclusiveLock",
	"ShareLock",
	"ShareUpdateExclusiveLock",
];

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

function assertJournalCoversFolder(local) {
	const onDisk = readdirSync(migrationsFolder)
		.filter((name) => name.endsWith(".sql"))
		.map((name) => name.replace(/\.sql$/, ""));
	const inJournal = new Set(local.map((entry) => entry.tag));
	const missing = onDisk.filter((tag) => !inJournal.has(tag));
	return missing;
}

async function main() {
	const local = readLocalMigrations();
	const untracked = assertJournalCoversFolder(local);
	const byHash = new Map(local.map((entry) => [entry.hash, entry]));

	const client = new Client({ connectionString: databaseUrl });
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
		const ledgerLocks = await client.query(
			`SELECT l.pid, l.mode, l.granted
			   FROM pg_locks l JOIN pg_class c ON c.oid = l.relation JOIN pg_namespace n ON n.oid = c.relnamespace
			  WHERE l.pid <> pg_backend_pid() AND n.nspname = 'drizzle' AND c.relname = '__drizzle_migrations'`,
		);
		const ddlLocks = await client.query(
			`SELECT l.pid, l.mode, n.nspname || '.' || c.relname AS relation
			   FROM pg_locks l JOIN pg_class c ON c.oid = l.relation JOIN pg_namespace n ON n.oid = c.relnamespace
			  WHERE l.pid <> pg_backend_pid() AND l.mode = ANY($1::text[]) AND n.nspname = ANY($2::text[])
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
			const newest = report.ledger.reduce((max, row) => Math.max(max, row.created_at), 0);
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
			const { rows } = await client.query(`SELECT (${predicate}) AS present`);
			report.objects[label] = rows[0].present === true;
			console.log(`  ${rows[0].present ? "yes" : "no "}  ${label}`);
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
		console.log("row counts (counts only, no content is read):");
		const existing = await client.query(
			"SELECT c.relname, n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'r' AND n.nspname || '.' || c.relname = ANY($1::text[])",
			[COUNTED_TABLES],
		);
		const existingNames = new Set(existing.rows.map((row) => `${row.nspname}.${row.relname}`));
		for (const table of COUNTED_TABLES) {
			if (!existingNames.has(table)) {
				report.counts[table] = null;
				console.log(`  ${"absent".padStart(7)}  ${table}`);
				continue;
			}
			const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
			report.counts[table] = rows[0].n;
			console.log(`  ${String(rows[0].n).padStart(7)}  ${table}`);
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

/**
 * A driver error names what it could not reach: `ECONNREFUSED 10.x.x.x:5432`
 * puts an internal address in a log that is read and quoted elsewhere. The
 * reason is worth keeping, the address is not.
 */
function redact(message) {
	return message
		.replace(/\b[a-z+]+:\/\/\S+/gi, "<url>")
		.replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "<address>")
		.replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?\b/gi, "<host>");
}

main().catch((error) => {
	// The message only, and scrubbed: a stack from `pg` carries the connection target.
	console.error(`inspection failed: ${redact(error instanceof Error ? error.message : "unknown error")}`);
	process.exit(1);
});

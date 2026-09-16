import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";

const endpoint = new URL(process.env.LOCAL_PREPAYMENT_PROOF_URL ?? "");
assert.equal(endpoint.hostname, "127.0.0.1");
assert.equal(endpoint.port, "56648");
assert.equal(endpoint.pathname, "/local_prepayment_proof");
endpoint.pathname = "/local_prepayment_migrations";
const pool = new Pool({ connectionString: endpoint.toString() });
const client = await pool.connect();
try {
	const base = new URL("../../../packages/lib/src/db/migrations/", import.meta.url);
	const journal = JSON.parse(await readFile(new URL("meta/_journal.json", base), "utf8"));
	for (const entry of journal.entries) {
		await client.query("BEGIN");
		try {
			const sql = await readFile(new URL(`${entry.tag}.sql`, base), "utf8");
			for (const statement of sql.split("--> statement-breakpoint"))
				if (statement.trim()) await client.query(statement);
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw new Error(`Migration failed: ${entry.tag}`, { cause: error });
		}
	}
	assert.equal(journal.entries.at(-1).tag, "0048_local_prepayment");
	console.log(
		`PASS: ${journal.entries.length} complete Selena-OS migrations applied to a fresh local database, including Local Visibility.`,
	);
} finally {
	client.release();
	await pool.end();
}

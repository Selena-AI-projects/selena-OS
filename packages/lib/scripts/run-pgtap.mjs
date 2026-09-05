import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";

const databaseUrl = process.env.SELENA_DISPOSABLE_DATABASE_URL;
const suitePath = resolve(process.cwd(), process.argv[2] ?? "src/db/tests/0037_content_project_profiles.pgtap.sql");

if (!databaseUrl) {
	throw new Error(
		"SELENA_DISPOSABLE_DATABASE_URL is required; refusing to run pgTAP without an explicitly disposable database",
	);
}

const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
	const sql = await readFile(suitePath, "utf8");
	const results = await client.query(sql);
	const rows = Array.isArray(results) ? results.flatMap((result) => result.rows) : results.rows;
	const tapLines = rows.flatMap((row) =>
		Object.values(row).filter((value) => typeof value === "string" && /^(?:1\.\.|ok |not ok |#)/.test(value)),
	);
	for (const line of tapLines) console.log(line);
	const failures = tapLines.filter((line) => line.startsWith("not ok "));
	if (failures.length > 0) throw new Error(`pgTAP reported ${failures.length} failed assertion(s)`);
} finally {
	await client.end();
}

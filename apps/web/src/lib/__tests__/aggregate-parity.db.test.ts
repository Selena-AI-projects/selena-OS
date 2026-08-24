/**
 * Parity: the hourly-rollup read path must return exactly what the raw
 * prompt_runs path returns, for every whole-hour timezone. Needs a real
 * Postgres with migrations applied — set PARITY_DATABASE_URL to run, e.g.:
 *
 *   PARITY_DATABASE_URL=postgres://localhost/parity pnpm --filter web test aggregate-parity
 *
 * Without the variable the suite is skipped, so the regular unit run stays
 * database-free.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.PARITY_DATABASE_URL;

/** null = real behavior; true/false = force the aggregate or the raw path. */
let forcedPath: boolean | null = null;

vi.mock("@/lib/timezone-offsets", async (importOriginal) => {
	const real = await importOriginal<typeof import("@/lib/timezone-offsets")>();
	return {
		...real,
		usesWholeHourOffsets: (tz: string, from: string | null, to: string | null) =>
			forcedPath ?? real.usesWholeHourOffsets(tz, from, to),
	};
});

describe.skipIf(!url)("prompt_run_hourly_aggregates parity", () => {
	const BRAND = "parity-brand";
	const FROM = "2026-07-01";
	const TO = "2026-07-30";
	const MODELS = ["chatgpt", "perplexity"];
	const ZONES = ["UTC", "Europe/Berlin", "America/New_York", "Asia/Makassar"];

	let pg: import("pg").Pool;
	let promptIds: string[] = [];
	let postgresRead: typeof import("@/lib/postgres-read");
	let aggregates: typeof import("@workspace/lib/prompt-run-aggregates");

	/** Deterministic PRNG so every run seeds the same dataset. */
	const mulberry32 = (seed: number) => () => {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};

	beforeAll(async () => {
		Reflect.set(process.env, "DATABASE_URL", url);
		const { Pool } = await import("pg");
		pg = new Pool({ connectionString: url });
		postgresRead = await import("@/lib/postgres-read");
		aggregates = await import("@workspace/lib/prompt-run-aggregates");

		await pg.query(`DELETE FROM prompt_run_hourly_aggregates WHERE brand_id = $1`, [BRAND]);
		await pg.query(`DELETE FROM prompt_runs WHERE brand_id = $1`, [BRAND]);
		await pg.query(`DELETE FROM prompts WHERE brand_id = $1`, [BRAND]);
		await pg.query(`DELETE FROM brands WHERE id = $1`, [BRAND]);
		await pg.query(`DELETE FROM organization WHERE id = $1`, [BRAND]);

		await pg.query(`INSERT INTO organization (id, name, slug, created_at) VALUES ($1, $1, $1, now())`, [BRAND]);
		await pg.query(
			`INSERT INTO brands (id, name, website, organization_id) VALUES ($1, 'Parity', 'https://parity.example', $1)`,
			[BRAND],
		);
		const inserted = await pg.query(
			`INSERT INTO prompts (brand_id, value)
			 SELECT $1, 'prompt ' || g FROM generate_series(1, 6) g
			 RETURNING id`,
			[BRAND],
		);
		promptIds = inserted.rows.map((r: { id: string }) => r.id);

		// ~1500 runs over 30 days at odd minutes, including hours that cross
		// local midnight in the tested zones.
		const rand = mulberry32(20260823);
		const values: string[] = [];
		for (let i = 0; i < 1500; i++) {
			const day = Math.floor(rand() * 30);
			const minuteOfDay = Math.floor(rand() * 24 * 60);
			const at = new Date(Date.UTC(2026, 6, 1 + day, 0, minuteOfDay));
			const promptId = promptIds[Math.floor(rand() * promptIds.length)];
			const model = MODELS[Math.floor(rand() * MODELS.length)];
			const mentioned = rand() < 0.4;
			// Mix of grounded API runs, scraped runs, and legacy NULL-provider
			// rows — the model filter distinguishes all three.
			const r = rand();
			const provider = r < 0.25 ? "'openai-api'" : r < 0.6 ? "'brightdata'" : "NULL";
			const webSearch = rand() < 0.5;
			values.push(
				`('${promptId}', '${BRAND}', '${model}', ${provider}, ${webSearch}, 'test', '{}'::json, '{}', ${mentioned}, '{}', '${at.toISOString()}')`,
			);
		}
		await pg.query(
			`INSERT INTO prompt_runs
				(prompt_id, brand_id, model, provider, web_search_enabled, version, raw_output, web_queries, brand_mentioned, competitors_mentioned, created_at)
			 VALUES ${values.join(",")}`,
		);

		// Runs were seeded behind the write path's back, exactly the drift the
		// reconciler exists for — building the rollup through it is the test.
		const { drizzle } = await import("drizzle-orm/node-postgres");
		await aggregates.reconcilePromptRunAggregates(drizzle(url as string), 24 * 90);
	}, 120_000);

	afterAll(async () => {
		await pg?.end();
	});

	it("getPerPromptVisibilityTimeSeries matches the raw path in every zone", async () => {
		for (const zone of ZONES) {
			forcedPath = true;
			const agg = await postgresRead.getPerPromptVisibilityTimeSeries(BRAND, FROM, TO, zone, promptIds);
			forcedPath = false;
			const raw = await postgresRead.getPerPromptVisibilityTimeSeries(BRAND, FROM, TO, zone, promptIds);
			forcedPath = null;
			expect(agg.length).toBeGreaterThan(0);
			expect(agg).toEqual(raw);
		}
	});

	it("getVisibilityDailyAggregate matches the raw path in every zone", async () => {
		const branded = promptIds.slice(0, 2);
		for (const zone of ZONES) {
			forcedPath = true;
			const agg = await postgresRead.getVisibilityDailyAggregate(BRAND, FROM, TO, zone, promptIds, branded);
			forcedPath = false;
			const raw = await postgresRead.getVisibilityDailyAggregate(BRAND, FROM, TO, zone, promptIds, branded);
			forcedPath = null;
			expect(agg.length).toBeGreaterThan(0);
			expect(agg).toEqual(raw);
		}
	});

	it("matches with standard and premium model filters", async () => {
		for (const filter of ["chatgpt", "chatgpt::premium"]) {
			forcedPath = true;
			const agg = await postgresRead.getPerPromptVisibilityTimeSeries(BRAND, FROM, TO, "UTC", promptIds, filter);
			forcedPath = false;
			const raw = await postgresRead.getPerPromptVisibilityTimeSeries(BRAND, FROM, TO, "UTC", promptIds, filter);
			forcedPath = null;
			expect(agg.length).toBeGreaterThan(0);
			expect(agg).toEqual(raw);
		}
	});

	it("the same-transaction upsert produces what the reconciler produces", async () => {
		const { drizzle } = await import("drizzle-orm/node-postgres");
		const dbc = drizzle(url as string);
		const at = new Date("2026-07-31T10:17:00Z");
		await aggregates.upsertPromptRunAggregate(dbc, {
			promptId: promptIds[0],
			brandId: BRAND,
			model: "chatgpt",
			provider: null,
			webSearchEnabled: false,
			createdAt: at,
			brandMentioned: true,
		});
		await aggregates.upsertPromptRunAggregate(dbc, {
			promptId: promptIds[0],
			brandId: BRAND,
			model: "chatgpt",
			provider: null,
			webSearchEnabled: false,
			createdAt: new Date("2026-07-31T10:44:00Z"),
			brandMentioned: false,
		});
		const { rows } = await pg.query(
			`SELECT total_runs, brand_mentioned_count FROM prompt_run_hourly_aggregates
			 WHERE prompt_id = $1 AND model = 'chatgpt' AND hour_bucket = '2026-07-31T10:00:00Z'`,
			[promptIds[0]],
		);
		expect(rows).toEqual([{ total_runs: 2, brand_mentioned_count: 1 }]);
		// No prompt_runs rows back these two upserts, so the reconciler must
		// remove the orphan — proving the delete side of the drift guard.
		await aggregates.reconcilePromptRunAggregates(dbc, 24 * 90);
		const after = await pg.query(
			`SELECT 1 FROM prompt_run_hourly_aggregates
			 WHERE prompt_id = $1 AND model = 'chatgpt' AND hour_bucket = '2026-07-31T10:00:00Z'`,
			[promptIds[0]],
		);
		expect(after.rowCount).toBe(0);
	});
});

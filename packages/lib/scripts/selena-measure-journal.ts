/**
 * Measures the owner's own projects where the product runs.
 *
 * This is the same chain a paid order takes — configuration lock, order, run
 * permits, the executor, the evidence ledger — driven from a command instead of
 * from the order desk, because the projects being measured are the owner's own
 * and the decision to spend is the act of running it.
 *
 * It exists to get off a CI runner. A runner is billed by the wall clock and
 * spends nearly all of it idle, waiting on a collector to think: the answers
 * cost about ninety cents and the machine that waited for them cost six
 * dollars. Here the compute is already paid for and already running.
 *
 * It is not a scheduler. Nothing calls it on a timer, one invocation measures
 * the projects named in one variable, and it refuses to start without a spend
 * ceiling it can check before the first request.
 *
 * Usage:
 *   DATABASE_URL=postgres://... BRIGHTDATA_API_TOKEN=... \
 *   SELENA_MEASUREMENT_ENABLED=true SELENA_MEASUREMENT_ADAPTER=brightdata \
 *   SELENA_JOURNAL_TENANT=<organization id> \
 *   SELENA_JOURNAL_PROJECTS=korafoodhall SELENA_JOURNAL_MAX_COST_USD=0.5 \
 *   pnpm -C packages/lib exec tsx scripts/selena-measure-journal.ts
 */

import { visitorSurfaces } from "@workspace/selena-visibility-contracts";
import { and, eq } from "drizzle-orm";
import { createBrightDataAdapter } from "../src/adapters/brightdata-measurement-adapter";
import { db } from "../src/db/db";
import * as schema from "../src/db/schema";
import { createSelenaMeasurementResolvers, lockedProfileBlock } from "../src/selena-extraction-context";
import { journalScenario, journalScenarioSlugs } from "../src/selena-journal-scenarios";
import {
	type MeasurementAdapterRegistry,
	measurementAdapterNamesFor,
	measurementConfigFromEnv,
	runMeasurementForPermit,
} from "../src/selena-run-executor";
import { createSelenaRepositories, type SelenaRepositoryContext } from "../src/selena-visibility-repositories";

/** What Bright Data's pricing page showed per answer; the ceiling is checked against it. */
const PRICE_PER_ANSWER_USD = 0.0015;

/** The collector is the bottleneck and it is patient, so many can wait at once. */
const CONCURRENCY = 10;

const BRIGHTDATA_ENDPOINT = "https://api.brightdata.com/datasets/v3/scrape";
const BRIGHTDATA_SURFACES = ["chatgpt", "gemini", "perplexity"] as const;
const BRIGHTDATA_DATASET_IDS: Record<(typeof BRIGHTDATA_SURFACES)[number], string> = {
	chatgpt: "gd_m7aof0k82r803d5bjm",
	gemini: "gd_mbz66arm2mf9cu856y",
	perplexity: "gd_m7dhdot1vw9a7gc1n",
};

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) {
		console.error(`${name} is required`);
		process.exit(2);
	}
	return value;
}

const DATABASE_URL = required("DATABASE_URL");
const apiKey = required("BRIGHTDATA_API_TOKEN");
const tenantId = required("SELENA_JOURNAL_TENANT");
const maxCostUsd = Number(required("SELENA_JOURNAL_MAX_COST_USD"));
if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
	console.error("SELENA_JOURNAL_MAX_COST_USD must be a positive number");
	process.exit(2);
}
void DATABASE_URL;

const config = measurementConfigFromEnv(process.env);
if (!config.enabled) {
	console.error("SELENA_MEASUREMENT_ENABLED must be true — this spends money on the Bright Data account");
	process.exit(2);
}

const requested = (process.env.SELENA_JOURNAL_PROJECTS ?? "").trim();
const slugs =
	requested === "" || requested === "all" ? journalScenarioSlugs : requested.split(",").map((s) => s.trim());
const unknown = slugs.filter((slug) => !journalScenarioSlugs.includes(slug));
if (unknown.length > 0) {
	console.error(`Unknown project(s): ${unknown.join(", ")}. Known: ${journalScenarioSlugs.join(", ")}`);
	process.exit(2);
}

const ctx: SelenaRepositoryContext = {
	actorId: "selena-measure-journal",
	tenantId,
	role: "owner",
	authType: "session",
	permissions: ["client:write"],
};

const repositories = createSelenaRepositories(db);
const resolvers = createSelenaMeasurementResolvers(db);

/** Only the surfaces the configured name can actually route to are built. */
const selected = new Set(measurementAdapterNamesFor(config.adapter));
const adapters: MeasurementAdapterRegistry = Object.fromEntries(
	BRIGHTDATA_SURFACES.filter((surface) => selected.has(`brightdata-${surface}`)).map((surface) => [
		`brightdata-${surface}`,
		createBrightDataAdapter({
			apiKey,
			endpoint: BRIGHTDATA_ENDPOINT,
			datasetId:
				process.env[`SELENA_BRIGHTDATA_DATASET_${surface.toUpperCase()}`]?.trim() || BRIGHTDATA_DATASET_IDS[surface],
			system: surface,
			fetchImpl: fetch,
			resolveScenarioText: resolvers.resolveScenarioText,
			resolveExtractionContext: resolvers.resolveExtractionContext,
		}),
	]),
);
if (Object.keys(adapters).length === 0) {
	console.error(`SELENA_MEASUREMENT_ADAPTER=${config.adapter} reaches no Visitor View collector`);
	process.exit(2);
}

/** Find the project by the name this script gives it, or make it. */
async function projectFor(slug: string) {
	const scenario = journalScenario(slug);
	const existing = (await repositories.projects.list(ctx)).find((project) => project.name === scenario.brand);
	const project =
		existing ??
		(await repositories.projects.create(ctx, {
			name: scenario.brand,
			category: "journal",
			country: "ID",
			region: scenario.market,
			languages: [scenario.language],
		}));
	// Confirmed every time: the profile is what extraction reads, and a set
	// whose questions changed must not be measured against a stale brand.
	await repositories.profiles.confirm(ctx, {
		projectId: project.id,
		brandName: scenario.brand,
		primaryDomain: `https://${scenario.site}`,
		publicProfiles: [],
		competitorSnapshot: [],
		scenarioSnapshot: scenario.questions.map((text) => ({ text, language: scenario.language })),
	});
	return { project, scenario };
}

/** The question rows, approved. Idempotent by text, so a re-run adds only what is new. */
async function scenarioRowsFor(projectId: string, slug: string) {
	const scenario = journalScenario(slug);
	const [existingFamily] = await db
		.select({ id: schema.svPromptFamilies.id })
		.from(schema.svPromptFamilies)
		.where(
			and(
				eq(schema.svPromptFamilies.projectId, projectId),
				eq(schema.svPromptFamilies.organizationId, tenantId),
				eq(schema.svPromptFamilies.source, scenario.version),
			),
		)
		.limit(1);
	const family =
		existingFamily ??
		(await repositories.families.create(ctx, {
			projectId,
			intentType: "discovery",
			// The version is the family's identity: a new question set is a new
			// series, never more rows on the old one.
			source: scenario.version,
			status: "APPROVED",
		}));

	const existing = await repositories.scenarios.list(ctx, family.id);
	const known = new Map(existing.map((row) => [row.text, row]));
	const rows = [];
	for (const text of scenario.questions) {
		const row =
			known.get(text) ??
			(await repositories.scenarios.create(ctx, {
				familyId: family.id,
				text,
				language: scenario.language,
				status: "APPROVED",
			}));
		rows.push(row);
	}
	return rows;
}

async function inPool<T, R>(items: T[], size: number, worker: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = [];
	for (let index = 0; index < items.length; index += size) {
		results.push(...(await Promise.all(items.slice(index, index + size).map(worker))));
	}
	return results;
}

async function measure(slug: string): Promise<void> {
	const { project, scenario } = await projectFor(slug);
	const rows = await scenarioRowsFor(project.id, slug);
	const systems = visitorSurfaces.map((systemId) => ({ systemId, channel: "VISITOR" as const }));
	const expectedRuns = rows.length * systems.length;
	const cost = expectedRuns * PRICE_PER_ANSWER_USD;
	if (cost > maxCostUsd) {
		console.error(
			`${slug}: ${expectedRuns} answers cost about $${cost.toFixed(4)}, ceiling is $${maxCostUsd.toFixed(4)}`,
		);
		process.exitCode = 1;
		return;
	}

	console.log(`\n${scenario.brand} — ${rows.length} questions × ${systems.length} surfaces (~$${cost.toFixed(4)})`);
	if (scenario.ownership === "third-party") {
		console.log("  third-party: measurable, but not publishable without that owner's recorded yes");
	}

	const profile = await repositories.profiles.get(ctx, project.id);
	if (!profile) throw new Error(`SELENA_PROFILE_MISSING: ${slug}`);
	const [prior] = await db
		.select({ version: schema.svConfigurationLocks.version })
		.from(schema.svConfigurationLocks)
		.where(
			and(
				eq(schema.svConfigurationLocks.projectId, project.id),
				eq(schema.svConfigurationLocks.organizationId, tenantId),
			),
		)
		.orderBy(schema.svConfigurationLocks.version);

	const lock = await repositories.locks.create(ctx, {
		projectId: project.id,
		version: (prior?.version ?? 0) + 1,
		snapshot: {
			measurementScope: { scenarios: rows.map((row) => row.id), systems, repeats: 1 },
			// Frozen with the scope so a later profile edit cannot change what
			// this measurement is read against.
			profile: lockedProfileBlock(profile),
			questionSetVersion: scenario.version,
		},
		engineSha: scenario.version,
		expectedRuns,
		budgetCap: String(maxCostUsd),
	});
	const quote = await repositories.quotes.create(ctx, {
		projectId: project.id,
		lockId: lock.id,
		status: "ACCEPTED",
		priceAmount: "0",
		currency: "USD",
		expectedRuns,
		expiresAt: new Date(Date.now() + 60 * 60 * 1000),
	});
	const order = await repositories.orders.create(ctx, {
		projectId: project.id,
		quoteId: quote.id,
		lockId: lock.id,
		orderCap: String(maxCostUsd),
	});
	// The owner measuring her own projects: there is no customer payment to
	// record, and running this command is the decision the desk would ask for.
	await db.update(schema.svOrders).set({ status: "PAID_REVIEW_REQUIRED" }).where(eq(schema.svOrders.id, order.id));

	const dispatch = await repositories.dispatch.createPermits(ctx, order.id, {
		approval: {
			fromStatus: "PAID_REVIEW_REQUIRED",
			auditEvent: "ORDER_APPROVED",
			auditDetails: { source: "selena-measure-journal", slug, questionSetVersion: scenario.version },
		},
	});

	let done = 0;
	const outcomes = await inPool(dispatch.permits, CONCURRENCY, async (permit) => {
		const result = await runMeasurementForPermit({
			permitId: permit.id,
			ctx,
			store: repositories.runs,
			adapters,
			config,
		});
		done += 1;
		if (done % CONCURRENCY === 0 || done === dispatch.permits.length) {
			console.log(`  ${done}/${dispatch.permits.length}`);
		}
		return result;
	});

	const failed = outcomes.filter((outcome) => outcome.status !== "completed").length;
	const { rows: ledger, mentions } = await repositories.runs.ledgerForCycle(ctx, dispatch.cycleId);
	const valid = ledger.filter((row) => row.validity === "VALID").length;
	console.log(
		`  cycle ${dispatch.cycleId}: ${valid} valid of ${dispatch.permits.length} asked, ${mentions.length} mention rows` +
			(failed > 0 ? `, ${failed} did not complete` : ""),
	);
	// Coverage before conclusions: a rate over a fraction of the sample is a
	// different number wearing the same sign.
	if (valid / dispatch.permits.length < 0.8) {
		console.log("  coverage below four fifths — read the counts, not a rate");
	}
}

async function main(): Promise<void> {
	console.log(`Measuring ${slugs.length} project(s) through ${Object.keys(adapters).join(", ")}`);
	for (const slug of slugs) {
		try {
			await measure(slug);
		} catch (error) {
			console.error(`${slug}: ${error instanceof Error ? error.message : String(error)}`);
			process.exitCode = 1;
		}
	}
}

main().then(
	() => process.exit(process.exitCode ?? 0),
	(error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	},
);

/**
 * End-to-end rehearsal of a measurement cycle against a REAL Postgres, with
 * no provider and no spend: seed a project, plan permits the way an approved
 * order does, execute every permit through the stub adapter, then read back
 * what landed and compute the §12 metrics over it.
 *
 * What it is for: proving that runs, normalized mention rows and cost-ledger
 * rows are written together and that the ledger reads them, before any of it
 * is trusted with a paid cycle. Nothing it writes is an observation — the
 * model is `stub`, every charge is zero, and the whole seeded organization is
 * deleted again at the end.
 *
 * Usage:
 *   DATABASE_URL=postgres://... pnpm -C packages/lib exec tsx scripts/selena-stub-cycle.ts
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createStubMeasurementAdapter } from "../src/adapters/stub-measurement-adapter";
import { db } from "../src/db/db";
import * as schema from "../src/db/schema";
import { createSelenaMeasurementResolvers } from "../src/selena-extraction-context";
import { computeLedgerReport, type LedgerScenarioKind } from "../src/selena-ledger-metrics";
import { runMeasurementForPermit } from "../src/selena-run-executor";
import { createSelenaRepositories, type SelenaRepositoryContext } from "../src/selena-visibility-repositories";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
	console.error("DATABASE_URL is required");
	process.exit(2);
}
if (!/localhost|127\.0\.0\.1/.test(DATABASE_URL) && process.env.ALLOW_REMOTE_DB !== "1") {
	console.error("Refusing to run against a non-local database (set ALLOW_REMOTE_DB=1 to override)");
	process.exit(2);
}

const ORG = `stub-cycle-${randomUUID()}`;
const REPEATS = 3;

const ctx: SelenaRepositoryContext = {
	actorId: "stub-cycle-script",
	tenantId: ORG,
	role: "owner",
	authType: "session",
	permissions: ["client:write"],
};

let failures = 0;
function check(condition: boolean, message: string): void {
	if (condition) console.log(`✓ ${message}`);
	else {
		console.error(`✗ ${message}`);
		failures += 1;
	}
}

async function cleanup(): Promise<void> {
	// Child-first, so every foreign key still resolves while the rows go.
	const tables = [
		schema.svAuditEvents,
		schema.svCostEvents,
		schema.svResponseMentions,
		schema.svRuns,
		schema.svRunPermits,
		schema.svIncidents,
		schema.svCycles,
		schema.svOrders,
		schema.svQuotes,
		schema.svProjectProfiles,
		schema.svConfigurationLocks,
		schema.svScenarios,
		schema.svPromptFamilies,
		schema.svProjects,
	];
	for (const table of tables) await db.delete(table).where(eq(table.organizationId, ORG));
	await db.delete(schema.organization).where(eq(schema.organization.id, ORG));
}

async function main(): Promise<void> {
	const repositories = createSelenaRepositories(db);
	const resolvers = createSelenaMeasurementResolvers(db);
	const adapters = {
		stub: createStubMeasurementAdapter({ resolveExtractionContext: resolvers.resolveExtractionContext }),
	};

	await db.insert(schema.organization).values({ id: ORG, name: "Stub Cycle", slug: ORG, createdAt: new Date() });

	const project = await repositories.projects.create(ctx, {
		name: "Stub Cycle Project",
		category: "restaurant",
		country: "ID",
		region: "Bali",
		languages: ["en"],
	});
	await repositories.profiles.confirm(ctx, {
		projectId: project.id,
		brandName: "KORA Food Hall",
		primaryDomain: "https://korafoodhall.com",
		publicProfiles: [],
		competitorSnapshot: [
			{ name: "Rival Cafe", domains: ["rivalcafe.id"] },
			{ name: "Other Place", domains: [] },
		],
		scenarioSnapshot: [],
	});

	const scenarioKinds = new Map<string, LedgerScenarioKind>();
	for (const kind of ["branded", "discovery"] as const) {
		const family = await repositories.families.create(ctx, {
			projectId: project.id,
			intentType: kind,
			source: "stub-cycle",
			status: "APPROVED",
		});
		const scenario = await repositories.scenarios.create(ctx, {
			familyId: family.id,
			text:
				kind === "branded"
					? "What do people say about KORA Food Hall in Canggu?"
					: "Where should I have breakfast in Canggu?",
			language: "en",
			status: "APPROVED",
		});
		scenarioKinds.set(scenario.id, kind);
	}

	const scenarios = [...scenarioKinds.keys()];
	const systems = [
		{ systemId: "chatgpt", channel: "API" as const },
		{ systemId: "perplexity", channel: "VISITOR" as const },
	];
	const expectedRuns = scenarios.length * systems.length * REPEATS;
	const lock = await repositories.locks.create(ctx, {
		projectId: project.id,
		version: 1,
		snapshot: { measurementScope: { scenarios, systems, repeats: REPEATS } },
		engineSha: "stub-cycle",
		expectedRuns,
		budgetCap: "0",
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
		orderCap: "0",
	});
	// Payment and admin approval are a different chain; this rehearsal is about
	// what happens after an order is approved, so it starts from that state.
	await db.update(schema.svOrders).set({ status: "APPROVED" }).where(eq(schema.svOrders.id, order.id));

	const dispatch = await repositories.dispatch.createPermits(ctx, order.id);
	check(dispatch.permits.length === expectedRuns, `planned ${expectedRuns} permits`);
	check(
		dispatch.permits.every((permit) => permit.systemId !== null),
		"every permit carries the system it was sold as",
	);

	for (const permit of dispatch.permits) {
		const result = await runMeasurementForPermit({
			permitId: permit.id,
			ctx,
			store: repositories.runs,
			adapters,
			config: { enabled: true, adapter: "stub" },
		});
		if (result.status !== "completed") console.error(`  permit ${permit.dispatchKey}: ${JSON.stringify(result)}`);
	}

	const { rows, mentions } = await repositories.runs.ledgerForCycle(ctx, dispatch.cycleId);
	const costEvents = await repositories.costEvents.listForCycle(ctx, dispatch.cycleId);
	const runIds = new Set(rows.map((row) => row.runId));

	check(rows.length === expectedRuns, `${expectedRuns} runs recorded`);
	check(
		rows.every((row) => row.validity === "VALID" && row.extractorVersion !== null),
		"every run is VALID and carries an extractor version",
	);
	check(mentions.length > 0, `${mentions.length} mention rows written`);
	check(
		mentions.every((mention) => runIds.has(mention.runId)),
		"every mention row belongs to a run of this cycle",
	);
	check(
		mentions.every((mention) => mention.ordinalPosition === null || mention.ordinalPosition >= 1),
		"no mention row carries a position below 1",
	);
	check(costEvents.length === expectedRuns, `${expectedRuns} cost-ledger rows written`);
	check(
		costEvents.every((event) => event.provider === "stub" && Number(event.amountUsd) === 0),
		"every charge is zero and attributed to the stub provider",
	);

	const [cycle] = await db
		.select()
		.from(schema.svCycles)
		.where(and(eq(schema.svCycles.id, dispatch.cycleId), eq(schema.svCycles.organizationId, ORG)));
	check(cycle?.completedRuns === expectedRuns, "the cycle counted every completed run");
	check(cycle?.status === "QC_REQUIRED", "a finished cycle waits for human QC");

	const report = computeLedgerReport(rows, mentions, scenarioKinds);
	check(report.unclassifiedRuns === 0, "every run belongs to a classified scenario");
	console.log("\nbranded:", JSON.stringify(report.branded, null, 2));
	console.log("discovery:", JSON.stringify(report.discovery, null, 2));
}

main()
	.then(cleanup, async (error) => {
		console.error(error);
		failures += 1;
		await cleanup();
	})
	.finally(() => {
		console.log(failures === 0 ? "\nRehearsal passed" : `\nRehearsal failed: ${failures} check(s)`);
		process.exit(failures === 0 ? 0 : 1);
	});

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
		schema.svCitationGapSnapshots,
		schema.svObservationEvidenceAssets,
		schema.svObservationMentions,
		schema.svLocalObservations,
		schema.svCaptureTasks,
		schema.svPilotCycles,
		schema.svResponseMentions,
		schema.svRuns,
		schema.svRunPermits,
		schema.svIncidents,
		schema.svQcRecords,
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

/**
 * The manual pilot has its own cardinality boundary, reached by a person
 * submitting one observation too many rather than by a scheduler. Its guard
 * fires inside a transaction, so this proves the incident survives the
 * rollback that contained it — a safeguard whose firing leaves no trace is
 * indistinguishable from one that never fired.
 */
async function rehearsePilotOverflow(
	repositories: ReturnType<typeof createSelenaRepositories>,
	projectId: string,
	scenarioId: string,
): Promise<void> {
	const observerContext = {
		observerCountryCode: "ID",
		observerGeoMode: "DECLARED_AREA" as const,
		appLocale: "en-US",
		queryLanguage: "en",
		deviceClass: "MOBILE_ANDROID" as const,
		accountState: "SIGNED_OUT" as const,
		personalizationState: "OFF" as const,
		timezone: "Asia/Makassar",
		capturedAt: "2026-08-21T02:00:00.000Z",
	};
	const entityId = randomUUID();
	const lock = await repositories.locks.create(ctx, {
		projectId,
		version: 2,
		snapshot: {
			localAiDiscovery: {
				schemaVersion: 1,
				surface: "GOOGLE_ASK_MAPS",
				captureMethod: "MANUAL_OBSERVATION",
				externalCallsAllowed: false,
				placesApiAllowed: false,
				policyVersion: "stub-cycle",
				captureProtocolVersion: "stub-cycle/1",
				entities: [{ entityId, name: "KORA Food Hall", entityKind: "MASTER_BRAND", prelaunch: false }],
				entityRelationships: [],
				businessLocations: [],
				scenarios: [
					{
						scenarioId,
						queryText: "Where should I have breakfast in Canggu?",
						language: "en",
						targetEntityIds: [entityId],
					},
				],
				observerContexts: [observerContext],
				repeats: 1,
				expectedObservations: 1,
				evidencePolicy: {
					queryRequired: true,
					contextRequired: true,
					timestampRequired: true,
					transcriptRequired: true,
					screenshotRequired: true,
					visibleSourcesOptional: true,
				},
			},
		},
		engineSha: "stub-cycle",
		expectedRuns: 1,
		budgetCap: "0",
	});
	const pilot = await repositories.pilotCycles.create(ctx, { projectId, lockId: lock.id });
	const tasks = await repositories.captureTasks.generate(ctx, pilot.id);
	// Stand the cycle at its boundary, which is where a concurrent submit
	// leaves it, and then submit the observation that must be refused.
	await db
		.update(schema.svPilotCycles)
		.set({ createdObservations: pilot.expectedObservations })
		.where(eq(schema.svPilotCycles.id, pilot.id));
	let blocked = "";
	try {
		await repositories.observations.submit(ctx, {
			captureTaskId: tasks[0].id,
			capturedAt: observerContext.capturedAt,
			queryText: "Where should I have breakfast in Canggu?",
			context: observerContext,
			transcript: "1. Rival Cafe\n2. Other Place",
			screenshot: {
				privateObjectReference: "stub://screenshot",
				mimeType: "image/png",
				sizeBytes: 1024,
				sha256: "0".repeat(64),
			},
		});
	} catch (error) {
		blocked = error instanceof Error ? error.message : String(error);
	}
	check(
		blocked === "OBSERVATION_CARDINALITY_BLOCKED",
		`an observation past the boundary is refused (${blocked || "not refused"})`,
	);
	const incidents = await repositories.incidents.list(ctx);
	check(
		incidents.some((incident) => incident.kind === "PILOT_CARDINALITY_OVERFLOW" && incident.detail.includes(pilot.id)),
		"the refused observation left an incident behind",
	);
	const [after] = await db.select().from(schema.svPilotCycles).where(eq(schema.svPilotCycles.id, pilot.id));
	check(after?.createdObservations === pilot.expectedObservations, "the refused observation did not move the counter");
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
	// Payment is a different chain; the rehearsal starts where an order has been
	// paid and is waiting for a human to approve it.
	await db.update(schema.svOrders).set({ status: "PAID_REVIEW_REQUIRED" }).where(eq(schema.svOrders.id, order.id));

	const dispatch = await repositories.dispatch.createPermits(ctx, order.id, {
		approval: {
			fromStatus: "PAID_REVIEW_REQUIRED",
			auditEvent: "ORDER_APPROVED",
			auditDetails: { idempotencyKey: "stub-cycle" },
		},
	});
	const approvalAudit = await db
		.select()
		.from(schema.svAuditEvents)
		.where(and(eq(schema.svAuditEvents.organizationId, ORG), eq(schema.svAuditEvents.event, "ORDER_APPROVED")));
	check(approvalAudit.length === 1, "the approval left exactly one audit row");
	check(
		(approvalAudit[0]?.details as { cycleId?: string })?.cycleId === dispatch.cycleId,
		"the audit row names what the approval authorized",
	);
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
	check(
		report.branded.status === "MEASURED" && report.nonBranded.status === "MEASURED",
		"branded and non-branded questions each carry their own coverage",
	);
	check(
		rows.every((row) => row.captureMode !== null) && mentions.every((mention) => mention.captureMode !== null),
		"every run and mention records how the answer was obtained",
	);

	const snapshots = await repositories.citationGaps.snapshot(ctx, dispatch.cycleId);
	const gaps = snapshots.filter((snapshot) => snapshot.gapType !== null);
	check(snapshots.length > 0, `${snapshots.length} source(s) aggregated, ${gaps.length} of them a citation gap`);
	check(
		snapshots.every((snapshot) => snapshot.evidenceRunIds.every((runId) => runIds.has(runId))),
		"every stored source points at runs of this cycle",
	);
	check(
		gaps.every((snapshot) => snapshot.competitorCitationCount > 0 && snapshot.ownedCitationCount === 0),
		"every gap has competitors on one side and nothing owned on the other",
	);
	const recomputed = await repositories.citationGaps.snapshot(ctx, dispatch.cycleId);
	check(recomputed.length === snapshots.length, "recomputing the same formula updates rather than duplicates");

	// Delivery is gated on the human sign-off, so prove the gate holds before
	// proving the door opens.
	let refused = "";
	try {
		await repositories.orders.deliver(ctx, order.id);
	} catch (error) {
		refused = error instanceof Error ? error.message : String(error);
	}
	check(refused === "SELENA_ORDER_NOT_READY", `delivery before QC is refused (${refused || "not refused"})`);

	await repositories.qcRecords.create(ctx, {
		orderId: order.id,
		cycleId: dispatch.cycleId,
		reviewedAt: new Date(),
		scope: "stub rehearsal",
		decision: "rejected",
	});
	const [rejected] = await db
		.select()
		.from(schema.svOrders)
		.where(and(eq(schema.svOrders.id, order.id), eq(schema.svOrders.organizationId, ORG)));
	check(rejected?.status === "QC_REQUIRED", "a rejected review leaves the order where the reviewer left it");

	await repositories.qcRecords.create(ctx, {
		orderId: order.id,
		cycleId: dispatch.cycleId,
		reviewedAt: new Date(),
		scope: "stub rehearsal",
		decision: "approved",
	});
	const [reviewed] = await db
		.select()
		.from(schema.svOrders)
		.where(and(eq(schema.svOrders.id, order.id), eq(schema.svOrders.organizationId, ORG)));
	const [readyCycle] = await db
		.select()
		.from(schema.svCycles)
		.where(and(eq(schema.svCycles.id, dispatch.cycleId), eq(schema.svCycles.organizationId, ORG)));
	check(reviewed?.status === "READY", "an approved QC record publishes the order in the same transaction");
	check(readyCycle?.status === "READY", "the reviewed cycle is published with its order");

	const delivered = await repositories.orders.deliver(ctx, order.id);
	check(delivered.status === "DELIVERED", "a signed-off order can be delivered");
	const redelivered = await repositories.orders.deliver(ctx, order.id);
	check(redelivered.status === "DELIVERED", "delivering twice is the same delivery");

	await rehearsePilotOverflow(repositories, project.id, scenarios[0]);

	const evidence = await repositories.runs.rawEvidenceFor(ctx, rows[0].runId);
	check(evidence.rawResponseReference !== null, "raw evidence resolves for the tenant that owns the run");
	let denied = "";
	try {
		await repositories.runs.rawEvidenceFor({ ...ctx, tenantId: "some-other-org" }, rows[0].runId);
	} catch (error) {
		denied = error instanceof Error ? error.message : String(error);
	}
	check(denied.startsWith("Not found"), `raw evidence is refused to another organization (${denied || "not refused"})`);
	console.log("\nbranded:", JSON.stringify(report.branded, null, 2));
	console.log("non-branded:", JSON.stringify(report.nonBranded, null, 2));
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

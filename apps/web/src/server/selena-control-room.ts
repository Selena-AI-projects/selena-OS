import { createServerFn } from "@tanstack/react-start";
import { randomUUID } from "node:crypto";
import { selenaWebDb as db } from "@workspace/lib/db/db";
import { isSelenaStagingMvp } from "@workspace/lib/db/provisioning";
import {
	brands,
	scrApprovals,
	scrAuditEvents,
	scrChannelAccounts,
	scrContentAssets,
	scrContentItems,
	scrContentVersions,
	scrIncidents,
	scrKillSwitches,
	scrMetricSnapshots,
	scrReleaseIntents,
	scrPublicationAttempts,
	scrReleaseManifests,
	scrReleaseOutboxEvents,
} from "@workspace/lib/db/schema";
import {
	approvalBindingHash,
	assetBundleHash,
	contentVersionHash,
	isInteractiveOwnerSession,
	releaseIntentIdempotencyKey,
	sha256,
} from "@workspace/lib/selena-control-room";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { canWrite, resolveSessionAuthContext, type AuthContext } from "../lib/selena-auth-context";

type ControlRoomDatabase = Pick<typeof db, "execute" | "insert" | "select" | "update">;
type AuditDatabase = Pick<ControlRoomDatabase, "execute" | "insert" | "select">;

const uuidSchema = z.string().uuid();
const brandSchema = z.object({ brandId: z.string().min(1).max(120) });
const policyVersionSchema = z.string().trim().min(1).max(120);
const STAGING_DEMO_BRAND_ID = "selena";
const STAGING_DEMO_ORGANIZATION_ID = "default";
const STAGING_DEMO_ACCOUNT_REF = "Postiz local dry run";
const STAGING_DEMO_CONTENT_TITLE = "Selena Systems LinkedIn Page dry run";

function isLocalLinkedInDryRunAccount(account: {
	platform: string;
	providerAccountRef: string;
	providerIntegrationId: string | null;
	status: string;
	allowlisted: boolean;
}): boolean {
	return (
		account.platform === "linkedin_page_dry_run" &&
		account.providerAccountRef === STAGING_DEMO_ACCOUNT_REF &&
		account.providerIntegrationId === null &&
		account.status === "DRY_RUN" &&
		account.allowlisted === false
	);
}

function isSelenaStagingDemo(context: AuthContext, brandId: string): boolean {
	return isSelenaStagingMvp() && context.tenantId === STAGING_DEMO_ORGANIZATION_ID && brandId === STAGING_DEMO_BRAND_ID;
}

function assertWritable(context: AuthContext): void {
	if (!canWrite(context)) throw new Error("Forbidden: editor, publisher, or owner access required");
}

function assertHumanReviewer(context: AuthContext): void {
	if (!isInteractiveOwnerSession(context)) {
		throw new Error("Forbidden: an interactive owner session is required for human approval");
	}
}

async function requireBrand(database: Pick<ControlRoomDatabase, "select">, context: AuthContext, brandId: string) {
	const [brand] = await database
		.select({ id: brands.id, organizationId: brands.organizationId, name: brands.name })
		.from(brands)
		.where(and(eq(brands.id, brandId), eq(brands.organizationId, context.tenantId)))
		.limit(1);
	if (!brand) throw new Error("Forbidden: brand is outside the active organization");
	return brand;
}

async function withControlRoomTransaction<T>(
	context: AuthContext,
	brandId: string,
	operation: (tx: ControlRoomDatabase) => Promise<T>,
): Promise<T> {
	return db.transaction(async (tx) => {
		await tx.execute(sql`
			SELECT selena_registry.set_request_context(
				${context.actorId},
				${context.tenantId},
				${brandId},
				${context.role},
				${randomUUID()},
				${"web"},
				${context.authType}
			)
		`);
		await requireBrand(tx, context, brandId);
		return operation(tx);
	});
}

async function appendAudit(
	database: AuditDatabase,
	input: {
		context: AuthContext;
		brandId: string | null;
		action: string;
		aggregateType: string;
		aggregateId: string;
		metadata: Record<string, unknown>;
	},
): Promise<void> {
	const auditScope = `${input.context.tenantId}:${input.brandId ?? "organization"}`;
	await database.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${auditScope}))`);
	const [previous] = await database
		.select({ eventHash: scrAuditEvents.eventHash })
		.from(scrAuditEvents)
		.where(
			and(
				eq(scrAuditEvents.organizationId, input.context.tenantId),
				input.brandId ? eq(scrAuditEvents.brandId, input.brandId) : isNull(scrAuditEvents.brandId),
			),
		)
		.orderBy(desc(scrAuditEvents.createdAt))
		.limit(1);
	const eventHash = sha256({
		action: input.action,
		aggregateId: input.aggregateId,
		aggregateType: input.aggregateType,
		actorId: input.context.actorId,
		brandId: input.brandId,
		metadata: input.metadata,
		previousHash: previous?.eventHash ?? null,
	});
	await database.insert(scrAuditEvents).values({
		organizationId: input.context.tenantId,
		brandId: input.brandId,
		actorId: input.context.actorId,
		action: input.action,
		aggregateType: input.aggregateType,
		aggregateId: input.aggregateId,
		previousHash: previous?.eventHash ?? null,
		eventHash,
		metadata: input.metadata,
	});
}

function validFutureDate(value: Date | null | undefined): Date | null {
	if (!value) return null;
	if (Number.isNaN(value.getTime())) throw new Error("Invalid timestamp");
	return value;
}

export const getControlRoomWorkspaceFn = createServerFn({ method: "GET" })
	.validator(brandSchema)
	.handler(async ({ data }) => {
		const context = await resolveSessionAuthContext();
		return withControlRoomTransaction(context, data.brandId, async (tx) => {
			const db = tx;
			const scope = and(
				eq(scrContentItems.organizationId, context.tenantId),
				eq(scrContentItems.brandId, data.brandId),
			);
			const [
				content,
				releaseIntents,
				outboxEvents,
				versions,
				assets,
				accounts,
				approvals,
				manifests,
				publications,
				incidents,
				audits,
				metrics,
				killSwitches,
			] = await Promise.all([
				db.select().from(scrContentItems).where(scope).orderBy(desc(scrContentItems.updatedAt)).limit(40),
				db
					.select({
						id: scrReleaseIntents.id,
						approvalId: scrReleaseIntents.approvalId,
						platform: scrReleaseIntents.platform,
						status: scrReleaseIntents.status,
						createdAt: scrReleaseIntents.createdAt,
					})
					.from(scrReleaseIntents)
					.where(
						and(eq(scrReleaseIntents.organizationId, context.tenantId), eq(scrReleaseIntents.brandId, data.brandId)),
					)
					.orderBy(desc(scrReleaseIntents.createdAt))
					.limit(40),
				db
					.select({
						id: scrReleaseOutboxEvents.id,
						releaseIntentId: scrReleaseOutboxEvents.releaseIntentId,
						eventType: scrReleaseOutboxEvents.eventType,
						status: scrReleaseOutboxEvents.status,
						attemptCount: scrReleaseOutboxEvents.attemptCount,
						availableAt: scrReleaseOutboxEvents.availableAt,
					})
					.from(scrReleaseOutboxEvents)
					.where(
						and(
							eq(scrReleaseOutboxEvents.organizationId, context.tenantId),
							eq(scrReleaseOutboxEvents.brandId, data.brandId),
						),
					)
					.orderBy(desc(scrReleaseOutboxEvents.createdAt))
					.limit(40),
				db
					.select({
						id: scrContentVersions.id,
						contentId: scrContentVersions.contentId,
						version: scrContentVersions.version,
						policyVersion: scrContentVersions.policyVersion,
						contentHash: scrContentVersions.contentHash,
						evidenceExpiresAt: scrContentVersions.evidenceExpiresAt,
						createdAt: scrContentVersions.createdAt,
					})
					.from(scrContentVersions)
					.where(
						and(eq(scrContentVersions.organizationId, context.tenantId), eq(scrContentVersions.brandId, data.brandId)),
					)
					.orderBy(desc(scrContentVersions.createdAt))
					.limit(40),
				db
					.select({
						id: scrContentAssets.id,
						contentVersionId: scrContentAssets.contentVersionId,
						scanStatus: scrContentAssets.scanStatus,
						createdAt: scrContentAssets.createdAt,
					})
					.from(scrContentAssets)
					.where(and(eq(scrContentAssets.organizationId, context.tenantId), eq(scrContentAssets.brandId, data.brandId)))
					.orderBy(desc(scrContentAssets.createdAt))
					.limit(80),
				db
					.select({
						id: scrChannelAccounts.id,
						platform: scrChannelAccounts.platform,
						providerAccountRef: scrChannelAccounts.providerAccountRef,
						status: scrChannelAccounts.status,
						allowlisted: scrChannelAccounts.allowlisted,
						createdAt: scrChannelAccounts.createdAt,
					})
					.from(scrChannelAccounts)
					.where(
						and(eq(scrChannelAccounts.organizationId, context.tenantId), eq(scrChannelAccounts.brandId, data.brandId)),
					)
					.orderBy(desc(scrChannelAccounts.createdAt))
					.limit(20),
				db
					.select({
						id: scrApprovals.id,
						contentVersionId: scrApprovals.contentVersionId,
						channelAccountId: scrApprovals.channelAccountId,
						decision: scrApprovals.decision,
						contentHash: scrApprovals.contentHash,
						expiresAt: scrApprovals.expiresAt,
						createdAt: scrApprovals.createdAt,
					})
					.from(scrApprovals)
					.where(and(eq(scrApprovals.organizationId, context.tenantId), eq(scrApprovals.brandId, data.brandId)))
					.orderBy(desc(scrApprovals.createdAt))
					.limit(80),
				db
					.select({
						id: scrReleaseManifests.id,
						status: scrReleaseManifests.status,
						platform: scrReleaseManifests.platform,
						manifestHash: scrReleaseManifests.manifestHash,
						expiresAt: scrReleaseManifests.expiresAt,
						createdAt: scrReleaseManifests.createdAt,
					})
					.from(scrReleaseManifests)
					.where(
						and(
							eq(scrReleaseManifests.organizationId, context.tenantId),
							eq(scrReleaseManifests.brandId, data.brandId),
						),
					)
					.orderBy(desc(scrReleaseManifests.createdAt))
					.limit(40),
				db
					.select({
						id: scrPublicationAttempts.id,
						status: scrPublicationAttempts.status,
						platform: scrPublicationAttempts.platform,
						platformObjectId: scrPublicationAttempts.providerReferenceId,
						updatedAt: scrPublicationAttempts.occurredAt,
					})
					.from(scrPublicationAttempts)
					.where(
						and(
							eq(scrPublicationAttempts.organizationId, context.tenantId),
							eq(scrPublicationAttempts.brandId, data.brandId),
						),
					)
					.orderBy(desc(scrPublicationAttempts.occurredAt))
					.limit(40),
				db
					.select({
						id: scrIncidents.id,
						severity: scrIncidents.severity,
						code: scrIncidents.code,
						summary: scrIncidents.summary,
						status: scrIncidents.status,
					})
					.from(scrIncidents)
					.where(and(eq(scrIncidents.organizationId, context.tenantId), eq(scrIncidents.brandId, data.brandId)))
					.orderBy(desc(scrIncidents.createdAt))
					.limit(40),
				db
					.select({
						id: scrAuditEvents.id,
						action: scrAuditEvents.action,
						actorId: scrAuditEvents.actorId,
						aggregateType: scrAuditEvents.aggregateType,
						eventHash: scrAuditEvents.eventHash,
						createdAt: scrAuditEvents.createdAt,
					})
					.from(scrAuditEvents)
					.where(and(eq(scrAuditEvents.organizationId, context.tenantId), eq(scrAuditEvents.brandId, data.brandId)))
					.orderBy(desc(scrAuditEvents.createdAt))
					.limit(80),
				db
					.select({
						id: scrMetricSnapshots.id,
						quality: scrMetricSnapshots.quality,
						observedAt: scrMetricSnapshots.observedAt,
						dataCutoffAt: scrMetricSnapshots.dataCutoffAt,
						definitionVersion: scrMetricSnapshots.definitionVersion,
					})
					.from(scrMetricSnapshots)
					.where(
						and(eq(scrMetricSnapshots.organizationId, context.tenantId), eq(scrMetricSnapshots.brandId, data.brandId)),
					)
					.orderBy(desc(scrMetricSnapshots.observedAt))
					.limit(80),
				db
					.select({
						id: scrKillSwitches.id,
						scope: scrKillSwitches.scope,
						brandId: scrKillSwitches.brandId,
						channelAccountId: scrKillSwitches.channelAccountId,
						reason: scrKillSwitches.reason,
						createdAt: scrKillSwitches.createdAt,
					})
					.from(scrKillSwitches)
					.where(and(eq(scrKillSwitches.organizationId, context.tenantId), eq(scrKillSwitches.active, true)))
					.orderBy(desc(scrKillSwitches.createdAt))
					.limit(20),
			]);

			const contentById = new Map(content.map((item) => [item.id, item]));
			const assetsByVersion = new Map<string, typeof assets>();
			for (const asset of assets) {
				assetsByVersion.set(asset.contentVersionId, [...(assetsByVersion.get(asset.contentVersionId) ?? []), asset]);
			}
			const latestApprovalByVersion = new Map<string, (typeof approvals)[number]>();
			for (const approval of approvals) {
				if (!latestApprovalByVersion.has(approval.contentVersionId))
					latestApprovalByVersion.set(approval.contentVersionId, approval);
			}

			return {
				role: context.role,
				stagingMvp: isSelenaStagingDemo(context, data.brandId),
				content,
				versions,
				assets,
				accounts,
				approvals,
				releaseIntents,
				outboxEvents,
				manifests,
				publications,
				incidents,
				audits,
				metrics,
				killSwitches,
				reviewQueue: versions.map((version) => ({
					id: version.id,
					title: contentById.get(version.contentId)?.title ?? "Archived content",
					version: version.version,
					contentHash: version.contentHash,
					assetCount: assetsByVersion.get(version.id)?.length ?? 0,
					latestDecision: latestApprovalByVersion.get(version.id)?.decision ?? null,
					createdAt: version.createdAt,
				})),
			};
		});
	});

export const bootstrapStagingControlRoomFn = createServerFn({ method: "POST" })
	.validator(brandSchema)
	.handler(async ({ data }) => {
		const context = await resolveSessionAuthContext();
		assertHumanReviewer(context);
		if (!isSelenaStagingDemo(context, data.brandId)) {
			throw new Error("The local LinkedIn dry run is available only in the Selena staging workspace");
		}

		const now = new Date();
		const evidenceExpiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
		const evidence = [
			{
				source: "Selena staging fixture",
				purpose: "LinkedIn Page dry run",
				verifiedAt: now.toISOString(),
				expiresAt: evidenceExpiresAt.toISOString(),
			},
		];
		const disclosure = { noPublish: true, stagingFixture: true };
		const body =
			"Selena Systems is preparing a controlled LinkedIn Page workflow. This staging item validates human approval and release intent handling only.";
		const ctaUrl = "https://selenasystems.com";
		const policyVersion = "selena-staging-dry-run/v1";
		const contentHash = contentVersionHash({ body, ctaUrl, claims: [], evidence, disclosure, policyVersion });

		return withControlRoomTransaction(context, data.brandId, async (tx) => {
			let [account] = await tx
				.select()
				.from(scrChannelAccounts)
				.where(
					and(
						eq(scrChannelAccounts.organizationId, context.tenantId),
						eq(scrChannelAccounts.brandId, data.brandId),
						eq(scrChannelAccounts.platform, "linkedin_page_dry_run"),
						eq(scrChannelAccounts.providerAccountRef, STAGING_DEMO_ACCOUNT_REF),
					),
				)
				.limit(1);
			if (!account) {
				[account] = await tx
					.insert(scrChannelAccounts)
					.values({
						organizationId: context.tenantId,
						brandId: data.brandId,
						platform: "linkedin_page_dry_run",
						providerAccountRef: STAGING_DEMO_ACCOUNT_REF,
						status: "DRY_RUN",
						allowlisted: false,
						createdBy: context.actorId,
					})
					.returning();
				await appendAudit(tx, {
					context,
					brandId: data.brandId,
					action: "staging.linkedin_dry_run_prepared",
					aggregateType: "channel_account",
					aggregateId: account.id,
					metadata: { platform: account.platform, noPublish: true },
				});
			}

			let [content] = await tx
				.select()
				.from(scrContentItems)
				.where(
					and(
						eq(scrContentItems.organizationId, context.tenantId),
						eq(scrContentItems.brandId, data.brandId),
						eq(scrContentItems.title, STAGING_DEMO_CONTENT_TITLE),
					),
				)
				.limit(1);
			if (!content) {
				[content] = await tx
					.insert(scrContentItems)
					.values({
						organizationId: context.tenantId,
						brandId: data.brandId,
						title: STAGING_DEMO_CONTENT_TITLE,
						createdBy: context.actorId,
					})
					.returning();
				const [version] = await tx
					.insert(scrContentVersions)
					.values({
						organizationId: context.tenantId,
						brandId: data.brandId,
						contentId: content.id,
						version: 1,
						body,
						ctaUrl,
						claims: [],
						evidence,
						disclosure,
						policyVersion,
						contentHash,
						evidenceExpiresAt,
						createdBy: context.actorId,
					})
					.returning();
				await appendAudit(tx, {
					context,
					brandId: data.brandId,
					action: "staging.demo_content_created",
					aggregateType: "content_version",
					aggregateId: version.id,
					metadata: { noPublish: true, contentHash: version.contentHash },
				});
			}

			return { accountId: account.id, contentId: content.id };
		});
	});

export const createControlRoomContentFn = createServerFn({ method: "POST" })
	.validator(
		z.object({
			brandId: z.string().min(1),
			title: z.string().trim().min(3).max(180),
			body: z.string().trim().min(1).max(3000),
			ctaUrl: z.string().url().max(2048),
			policyVersion: policyVersionSchema,
			evidenceExpiresAt: z.coerce.date().optional(),
		}),
	)
	.handler(async ({ data }) => {
		const context = await resolveSessionAuthContext();
		assertWritable(context);
		const evidenceExpiresAt = validFutureDate(data.evidenceExpiresAt);
		const contentHash = contentVersionHash({
			body: data.body,
			ctaUrl: data.ctaUrl,
			claims: [],
			evidence: [],
			disclosure: {},
			policyVersion: data.policyVersion,
		});
		return withControlRoomTransaction(context, data.brandId, async (tx) => {
			const [content] = await tx
				.insert(scrContentItems)
				.values({
					organizationId: context.tenantId,
					brandId: data.brandId,
					title: data.title,
					createdBy: context.actorId,
				})
				.returning();
			const [version] = await tx
				.insert(scrContentVersions)
				.values({
					organizationId: context.tenantId,
					brandId: data.brandId,
					contentId: content.id,
					version: 1,
					body: data.body,
					ctaUrl: data.ctaUrl,
					claims: [],
					evidence: [],
					disclosure: {},
					policyVersion: data.policyVersion,
					contentHash,
					evidenceExpiresAt,
					createdBy: context.actorId,
				})
				.returning();
			await appendAudit(tx, {
				context,
				brandId: data.brandId,
				action: "content.version_created",
				aggregateType: "content_version",
				aggregateId: version.id,
				metadata: { contentId: content.id, version: 1, contentHash },
			});
			return { contentId: content.id, versionId: version.id, contentHash: version.contentHash };
		});
	});

export const createContentVersionFn = createServerFn({ method: "POST" })
	.validator(
		z.object({
			brandId: z.string().min(1),
			contentId: uuidSchema,
			body: z.string().trim().min(1).max(3000),
			ctaUrl: z.string().url().max(2048),
			policyVersion: policyVersionSchema,
			evidenceExpiresAt: z.coerce.date().optional(),
		}),
	)
	.handler(async ({ data }) => {
		const context = await resolveSessionAuthContext();
		assertWritable(context);
		const evidenceExpiresAt = validFutureDate(data.evidenceExpiresAt);
		return withControlRoomTransaction(context, data.brandId, async (tx) => {
			const [content] = await tx
				.select()
				.from(scrContentItems)
				.where(
					and(
						eq(scrContentItems.id, data.contentId),
						eq(scrContentItems.organizationId, context.tenantId),
						eq(scrContentItems.brandId, data.brandId),
					),
				)
				.limit(1);
			if (!content) throw new Error("Content item was not found");
			const [latest] = await tx
				.select({ version: scrContentVersions.version })
				.from(scrContentVersions)
				.where(
					and(eq(scrContentVersions.contentId, content.id), eq(scrContentVersions.organizationId, context.tenantId)),
				)
				.orderBy(desc(scrContentVersions.version))
				.limit(1);
			const nextVersion = (latest?.version ?? 0) + 1;
			const contentHash = contentVersionHash({
				body: data.body,
				ctaUrl: data.ctaUrl,
				claims: [],
				evidence: [],
				disclosure: {},
				policyVersion: data.policyVersion,
			});
			const [version] = await tx
				.insert(scrContentVersions)
				.values({
					organizationId: context.tenantId,
					brandId: data.brandId,
					contentId: content.id,
					version: nextVersion,
					body: data.body,
					ctaUrl: data.ctaUrl,
					claims: [],
					evidence: [],
					disclosure: {},
					policyVersion: data.policyVersion,
					contentHash,
					evidenceExpiresAt,
					createdBy: context.actorId,
				})
				.returning();
			await tx
				.update(scrContentItems)
				.set({ status: "DRAFT", updatedAt: new Date() })
				.where(eq(scrContentItems.id, content.id));
			await appendAudit(tx, {
				context,
				brandId: data.brandId,
				action: "content.version_created",
				aggregateType: "content_version",
				aggregateId: version.id,
				metadata: { contentId: content.id, version: nextVersion, contentHash },
			});
			return { versionId: version.id, contentHash: version.contentHash };
		});
	});

export const approveContentVersionFn = createServerFn({ method: "POST" })
	.validator(
		z.object({
			brandId: z.string().min(1),
			contentVersionId: uuidSchema,
			channelAccountId: uuidSchema,
			expiresAt: z.coerce.date(),
			reason: z.string().trim().max(1000).optional(),
		}),
	)
	.handler(async ({ data }) => {
		const context = await resolveSessionAuthContext();
		assertHumanReviewer(context);
		const now = new Date();
		if (data.expiresAt <= now) throw new Error("Approval expiry must be in the future");
		return withControlRoomTransaction(context, data.brandId, async (tx) => {
			const db = tx;
			const [[version], [account], assets] = await Promise.all([
				db
					.select()
					.from(scrContentVersions)
					.where(
						and(
							eq(scrContentVersions.id, data.contentVersionId),
							eq(scrContentVersions.organizationId, context.tenantId),
							eq(scrContentVersions.brandId, data.brandId),
						),
					)
					.limit(1),
				db
					.select()
					.from(scrChannelAccounts)
					.where(
						and(
							eq(scrChannelAccounts.id, data.channelAccountId),
							eq(scrChannelAccounts.organizationId, context.tenantId),
							eq(scrChannelAccounts.brandId, data.brandId),
						),
					)
					.limit(1),
				db
					.select()
					.from(scrContentAssets)
					.where(
						and(
							eq(scrContentAssets.contentVersionId, data.contentVersionId),
							eq(scrContentAssets.organizationId, context.tenantId),
						),
					),
			]);
			if (!version || !account) throw new Error("Version or target account was not found");
			const [latestVersion] = await db
				.select({ id: scrContentVersions.id })
				.from(scrContentVersions)
				.where(
					and(
						eq(scrContentVersions.contentId, version.contentId),
						eq(scrContentVersions.organizationId, context.tenantId),
						eq(scrContentVersions.brandId, data.brandId),
					),
				)
				.orderBy(desc(scrContentVersions.version))
				.limit(1);
			if (latestVersion?.id !== version.id)
				throw new Error("A newer content version invalidates this approval request");
			if (!isLocalLinkedInDryRunAccount(account) && (!account.allowlisted || account.status !== "ACTIVE"))
				throw new Error("Target account is not allowlisted for release");
			if (assets.length > 1 || (assets.length === 1 && assets[0]?.scanStatus !== "PASSED")) {
				throw new Error("Approval requires every attached asset to have PASSED malware scanning");
			}
			if (!Array.isArray(version.evidence) || version.evidence.length === 0 || !version.evidenceExpiresAt)
				throw new Error("Approval requires verified evidence with an expiry");
			if (version.evidenceExpiresAt <= now) throw new Error("Evidence has expired");
			if (assets.length > 0) {
				if (assets.some((asset) => !asset.rightsExpiresAt)) throw new Error("Approval requires verified asset rights");
				if (assets.some((asset) => asset.rightsExpiresAt && asset.rightsExpiresAt <= now))
					throw new Error("Asset rights have expired");
				if (assets.some((asset) => !asset.consentExpiresAt))
					throw new Error("Approval requires verified asset consent");
				if (assets.some((asset) => asset.consentExpiresAt && asset.consentExpiresAt <= now))
					throw new Error("Asset consent has expired");
			}
			const calculatedContentHash = contentVersionHash({
				body: version.body,
				ctaUrl: version.ctaUrl,
				claims: version.claims,
				evidence: version.evidence,
				disclosure: version.disclosure,
				policyVersion: version.policyVersion,
			});
			if (calculatedContentHash !== version.contentHash)
				throw new Error("Stored content hash does not match immutable content");
			const assetsHash = assetBundleHash(assets);
			const bindingHash = approvalBindingHash({
				brandId: data.brandId,
				channel: account.platform,
				channelAccountId: account.id,
				contentHash: version.contentHash,
				assetBundleHash: assetsHash,
				policyVersion: version.policyVersion,
				disclosure: version.disclosure,
			});
			const [latest] = await tx
				.select()
				.from(scrApprovals)
				.where(and(eq(scrApprovals.contentVersionId, version.id), eq(scrApprovals.channelAccountId, account.id)))
				.orderBy(desc(scrApprovals.createdAt))
				.limit(1);
			if (latest?.decision === "APPROVED" && latest.expiresAt && latest.expiresAt > now) return latest;
			const [approval] = await tx
				.insert(scrApprovals)
				.values({
					organizationId: context.tenantId,
					brandId: data.brandId,
					contentVersionId: version.id,
					channelAccountId: account.id,
					decision: "APPROVED",
					bindingHash,
					contentHash: version.contentHash,
					assetBundleHash: assetsHash,
					policyVersion: version.policyVersion,
					disclosureHash: sha256(version.disclosure),
					approverId: context.actorId,
					reason: data.reason,
					expiresAt: data.expiresAt,
				})
				.returning();
			await tx
				.update(scrContentItems)
				.set({ status: "APPROVED", updatedAt: now })
				.where(eq(scrContentItems.id, version.contentId));
			await appendAudit(tx, {
				context,
				brandId: data.brandId,
				action: "approval.granted",
				aggregateType: "approval",
				aggregateId: approval.id,
				metadata: {
					bindingHash,
					contentVersionId: version.id,
					channelAccountId: account.id,
					expiresAt: data.expiresAt.toISOString(),
				},
			});
			return approval;
		});
	});

export const revokeApprovalFn = createServerFn({ method: "POST" })
	.validator(
		z.object({ brandId: z.string().min(1), approvalId: uuidSchema, reason: z.string().trim().min(3).max(1000) }),
	)
	.handler(async ({ data }) => {
		const context = await resolveSessionAuthContext();
		assertHumanReviewer(context);
		return withControlRoomTransaction(context, data.brandId, async (tx) => {
			const db = tx;
			const [approval] = await db
				.select()
				.from(scrApprovals)
				.where(
					and(
						eq(scrApprovals.id, data.approvalId),
						eq(scrApprovals.organizationId, context.tenantId),
						eq(scrApprovals.brandId, data.brandId),
					),
				)
				.limit(1);
			if (!approval) throw new Error("Approval was not found");
			const [revocation] = await tx
				.insert(scrApprovals)
				.values({
					organizationId: approval.organizationId,
					brandId: approval.brandId,
					contentVersionId: approval.contentVersionId,
					channelAccountId: approval.channelAccountId,
					decision: "REVOKED",
					bindingHash: approval.bindingHash,
					contentHash: approval.contentHash,
					assetBundleHash: approval.assetBundleHash,
					policyVersion: approval.policyVersion,
					disclosureHash: approval.disclosureHash,
					approverId: context.actorId,
					reason: data.reason,
				})
				.returning();
			await appendAudit(tx, {
				context,
				brandId: data.brandId,
				action: "approval.revoked",
				aggregateType: "approval",
				aggregateId: revocation.id,
				metadata: { revokedApprovalId: approval.id, reason: data.reason },
			});
			return revocation;
		});
	});

export const queueReleaseIntentFn = createServerFn({ method: "POST" })
	.validator(z.object({ brandId: z.string().min(1), approvalId: uuidSchema }))
	.handler(async ({ data }) => {
		const context = await resolveSessionAuthContext();
		assertHumanReviewer(context);
		const now = new Date();
		return withControlRoomTransaction(context, data.brandId, async (tx) => {
			const [approval] = await tx
				.select()
				.from(scrApprovals)
				.where(
					and(
						eq(scrApprovals.id, data.approvalId),
						eq(scrApprovals.organizationId, context.tenantId),
						eq(scrApprovals.brandId, data.brandId),
					),
				)
				.limit(1);
			if (approval?.decision !== "APPROVED" || !approval.expiresAt || approval.expiresAt <= now) {
				throw new Error("An active human approval is required to queue a release");
			}

			const [[version], [account], assets, [latestDecision], activeKillSwitches] = await Promise.all([
				tx
					.select()
					.from(scrContentVersions)
					.where(
						and(
							eq(scrContentVersions.id, approval.contentVersionId),
							eq(scrContentVersions.organizationId, context.tenantId),
							eq(scrContentVersions.brandId, data.brandId),
						),
					)
					.limit(1),
				tx
					.select()
					.from(scrChannelAccounts)
					.where(
						and(
							eq(scrChannelAccounts.id, approval.channelAccountId),
							eq(scrChannelAccounts.organizationId, context.tenantId),
							eq(scrChannelAccounts.brandId, data.brandId),
						),
					)
					.limit(1),
				tx
					.select()
					.from(scrContentAssets)
					.where(
						and(
							eq(scrContentAssets.contentVersionId, approval.contentVersionId),
							eq(scrContentAssets.organizationId, context.tenantId),
							eq(scrContentAssets.brandId, data.brandId),
						),
					),
				tx
					.select({ id: scrApprovals.id, decision: scrApprovals.decision })
					.from(scrApprovals)
					.where(
						and(
							eq(scrApprovals.contentVersionId, approval.contentVersionId),
							eq(scrApprovals.channelAccountId, approval.channelAccountId),
						),
					)
					.orderBy(desc(scrApprovals.createdAt))
					.limit(1),
				tx
					.select({
						scope: scrKillSwitches.scope,
						brandId: scrKillSwitches.brandId,
						channelAccountId: scrKillSwitches.channelAccountId,
					})
					.from(scrKillSwitches)
					.where(and(eq(scrKillSwitches.organizationId, context.tenantId), eq(scrKillSwitches.active, true))),
			]);
			if (!version || !account || latestDecision?.id !== approval.id || latestDecision.decision !== "APPROVED") {
				throw new Error("Approval is no longer the current exact release decision");
			}
			const [latestVersion] = await tx
				.select({ id: scrContentVersions.id })
				.from(scrContentVersions)
				.where(
					and(
						eq(scrContentVersions.contentId, version.contentId),
						eq(scrContentVersions.organizationId, context.tenantId),
						eq(scrContentVersions.brandId, data.brandId),
					),
				)
				.orderBy(desc(scrContentVersions.version))
				.limit(1);
			if (latestVersion?.id !== version.id) throw new Error("A newer content version invalidates this release intent");
			if (!isLocalLinkedInDryRunAccount(account) && (!account.allowlisted || account.status !== "ACTIVE"))
				throw new Error("Target account is not allowlisted for release");
			if (
				activeKillSwitches.some(
					(killSwitch) =>
						killSwitch.scope === "GLOBAL" ||
						killSwitch.brandId === data.brandId ||
						killSwitch.channelAccountId === account.id,
				)
			) {
				throw new Error("An active kill switch blocks this release");
			}
			if (
				!Array.isArray(version.evidence) ||
				version.evidence.length === 0 ||
				!version.evidenceExpiresAt ||
				version.evidenceExpiresAt <= now
			) {
				throw new Error("Fresh verified evidence is required to queue a release");
			}
			if (
				assets.length > 1 ||
				(assets.length === 1 &&
					assets.some(
						(asset) =>
							asset.scanStatus !== "PASSED" ||
							!asset.objectVersionId ||
							!asset.scanProviderEventRef ||
							!asset.verifiedAt ||
							!asset.rightsExpiresAt ||
							asset.rightsExpiresAt <= now ||
							!asset.consentExpiresAt ||
							asset.consentExpiresAt <= now,
					))
			) {
				throw new Error("Release requires every attached asset to be verified, scanned, and current");
			}
			const currentContentHash = contentVersionHash({
				body: version.body,
				ctaUrl: version.ctaUrl,
				claims: version.claims,
				evidence: version.evidence,
				disclosure: version.disclosure,
				policyVersion: version.policyVersion,
			});
			const currentAssetBundleHash = assetBundleHash(assets);
			if (
				currentContentHash !== approval.contentHash ||
				currentAssetBundleHash !== approval.assetBundleHash ||
				version.policyVersion !== approval.policyVersion ||
				sha256(version.disclosure) !== approval.disclosureHash
			) {
				throw new Error("The current content binding no longer matches the approval");
			}

			const idempotencyKey = releaseIntentIdempotencyKey({
				approvalId: approval.id,
				bindingHash: approval.bindingHash,
				channelAccountId: account.id,
			});
			const [createdIntent] = await tx
				.insert(scrReleaseIntents)
				.values({
					organizationId: context.tenantId,
					brandId: data.brandId,
					contentVersionId: version.id,
					approvalId: approval.id,
					channelAccountId: account.id,
					platform: account.platform,
					idempotencyKey,
					correlationId: randomUUID(),
					createdBy: context.actorId,
				})
				.onConflictDoNothing()
				.returning();
			if (!createdIntent) {
				const [existingIntent] = await tx
					.select()
					.from(scrReleaseIntents)
					.where(
						and(
							eq(scrReleaseIntents.organizationId, context.tenantId),
							eq(scrReleaseIntents.brandId, data.brandId),
							eq(scrReleaseIntents.channelAccountId, account.id),
							eq(scrReleaseIntents.idempotencyKey, idempotencyKey),
						),
					)
					.limit(1);
				if (!existingIntent) throw new Error("Release intent could not be resolved after an idempotency conflict");
				return { created: false, releaseIntent: existingIntent };
			}
			await tx.insert(scrReleaseOutboxEvents).values({
				organizationId: context.tenantId,
				brandId: data.brandId,
				releaseIntentId: createdIntent.id,
				eventType: "release.intent_queued",
				eventVersion: 1,
				idempotencyKey: sha256({ eventType: "release.intent_queued", releaseIntentKey: idempotencyKey }),
			});
			await appendAudit(tx, {
				context,
				brandId: data.brandId,
				action: "release.intent_queued",
				aggregateType: "release_intent",
				aggregateId: createdIntent.id,
				metadata: { approvalId: approval.id, channelAccountId: account.id, idempotencyKey },
			});
			return { created: true, releaseIntent: createdIntent };
		});
	});

export const setReleaseKillSwitchFn = createServerFn({ method: "POST" })
	.validator(
		z.object({
			brandId: z.string().min(1),
			scope: z.enum(["GLOBAL", "BRAND", "ACCOUNT"]),
			channelAccountId: uuidSchema.optional(),
			enabled: z.boolean(),
			reason: z.string().trim().min(3).max(500),
		}),
	)
	.handler(async ({ data }) => {
		const context = await resolveSessionAuthContext();
		assertHumanReviewer(context);
		return withControlRoomTransaction(context, data.brandId, async (tx) => {
			const db = tx;
			const channelAccountId = data.channelAccountId;
			if (data.scope === "ACCOUNT" && !channelAccountId)
				throw new Error("An account kill switch requires a target account");
			if (data.scope === "ACCOUNT") {
				const accountId = channelAccountId;
				if (!accountId) throw new Error("An account kill switch requires a target account");
				const [account] = await db
					.select({ id: scrChannelAccounts.id })
					.from(scrChannelAccounts)
					.where(
						and(
							eq(scrChannelAccounts.id, accountId),
							eq(scrChannelAccounts.organizationId, context.tenantId),
							eq(scrChannelAccounts.brandId, data.brandId),
						),
					)
					.limit(1);
				if (!account) throw new Error("Target account was not found");
			}
			const accountScopeCondition = channelAccountId
				? and(
						eq(scrKillSwitches.organizationId, context.tenantId),
						eq(scrKillSwitches.scope, "ACCOUNT"),
						eq(scrKillSwitches.channelAccountId, channelAccountId),
					)
				: null;
			const scopeCondition =
				data.scope === "GLOBAL"
					? and(
							eq(scrKillSwitches.organizationId, context.tenantId),
							eq(scrKillSwitches.scope, "GLOBAL"),
							isNull(scrKillSwitches.brandId),
						)
					: data.scope === "BRAND"
						? and(
								eq(scrKillSwitches.organizationId, context.tenantId),
								eq(scrKillSwitches.scope, "BRAND"),
								eq(scrKillSwitches.brandId, data.brandId),
							)
						: accountScopeCondition;
			if (!scopeCondition) throw new Error("An account kill switch requires a target account");
			await tx.update(scrKillSwitches).set({ active: false, updatedAt: new Date() }).where(scopeCondition);
			if (data.enabled) {
				await tx.insert(scrKillSwitches).values({
					organizationId: context.tenantId,
					scope: data.scope,
					brandId: data.scope === "GLOBAL" ? null : data.brandId,
					channelAccountId: data.scope === "ACCOUNT" ? data.channelAccountId : null,
					active: true,
					reason: data.reason,
					changedBy: context.actorId,
				});
			}
			await appendAudit(tx, {
				context,
				brandId: data.scope === "GLOBAL" ? null : data.brandId,
				action: data.enabled ? "release.kill_switch_enabled" : "release.kill_switch_disabled",
				aggregateType: "kill_switch",
				aggregateId: `${data.scope}:${data.channelAccountId ?? data.brandId}`,
				metadata: { scope: data.scope, channelAccountId: data.channelAccountId ?? null, reason: data.reason },
			});
			return { enabled: data.enabled };
		});
	});

import { randomUUID } from "node:crypto";
import {
	type ConfirmProfileVersionInput,
	type CreateProfileVersionInput,
	type CurrentProfile,
	normalizeProfile,
	type ProfileVersionRef,
	profileHash,
	validateDecision,
} from "@workspace/content-workflow/profile";
import { and, desc, eq, max, sql } from "drizzle-orm";
import { selenaWebDb as db } from "./db/db";
import {
	scrAuditEvents,
	scrBrandContentProfileDecisions,
	scrBrandContentProfileVersions,
	scrContentChannels,
} from "./db/schema";
import { sha256 } from "./selena-control-room";

export type ContentAuthContext = {
	actorId: string;
	tenantId: string;
	role: "owner" | "member" | "viewer";
	authType: "session" | "api_key";
};

export type ContentTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ProfileVersionRow = typeof scrBrandContentProfileVersions.$inferSelect;
type ProfileDecisionRow = typeof scrBrandContentProfileDecisions.$inferSelect;

function assertWritable(context: ContentAuthContext): void {
	if (context.authType !== "session" || !["owner", "member"].includes(context.role)) {
		throw new Error("Forbidden: owner or member access required");
	}
}

function assertOwner(context: ContentAuthContext): void {
	if (context.authType !== "session" || context.role !== "owner") {
		throw new Error("Forbidden: an interactive owner session is required");
	}
}

function auditMetadata(input: {
	profileVersionId?: string;
	profileHash?: string;
	decision?: string;
}): Record<string, string> {
	return Object.fromEntries(
		Object.entries(input).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
	);
}

/**
 * Open a transaction that carries the authenticated brand request context.
 * Every Content OS repository goes through here, so the tenant identity a
 * statement runs under is always the session's and never a caller's argument.
 */
export async function withBrandRequestContext<T>(
	database: typeof db,
	context: ContentAuthContext,
	brandId: string,
	operation: (tx: ContentTransaction) => Promise<T>,
	serializeBrandWrites = false,
): Promise<T> {
	return database.transaction(async (tx) => {
		await tx.execute(
			sql`
				SELECT selena_registry.set_request_context(
					${context.actorId}, ${context.tenantId}, ${brandId}, ${context.role},
					${randomUUID()}, ${"web"}, ${context.authType}
				)
			`,
		);
		if (serializeBrandWrites) {
			await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${brandId}, 0))`);
		}
		return operation(tx as ContentTransaction);
	});
}

/**
 * Append one event to the brand's hash-chained audit log. Metadata is limited
 * to identifiers, hashes, versions, status and normalized error codes by the
 * callers; nothing here should ever carry a provider body or a transcript.
 */
export async function appendContentAudit(
	tx: ContentTransaction,
	context: ContentAuthContext,
	brandId: string,
	action: string,
	aggregateType: string,
	aggregateId: string,
	metadata: Record<string, unknown>,
): Promise<void> {
	const [previous] = await tx
		.select({ eventHash: scrAuditEvents.eventHash })
		.from(scrAuditEvents)
		.where(and(eq(scrAuditEvents.organizationId, context.tenantId), eq(scrAuditEvents.brandId, brandId)))
		.orderBy(desc(scrAuditEvents.createdAt), desc(scrAuditEvents.id))
		.limit(1);
	const previousHash = previous?.eventHash ?? null;
	const eventHash = sha256({ action, aggregateId, actorId: context.actorId, brandId, metadata, previousHash });
	await tx.insert(scrAuditEvents).values({
		organizationId: context.tenantId,
		brandId,
		actorId: context.actorId,
		action,
		aggregateType,
		aggregateId,
		previousHash,
		eventHash,
		metadata,
	});
}

export function createContentWorkflowRepositories(database: typeof db = db) {
	function mapVersion(version: ProfileVersionRow) {
		return {
			organizationId: version.organizationId,
			brandId: version.brandId,
			id: version.id,
			version: version.version,
			profileHash: version.profileHash,
			profile: {
				languages: version.languages,
				audience: version.audience as never,
				voice: version.voice as never,
				ctaRules: version.ctaRules as never,
				visualRules: version.visualRules as never,
				claimRules: version.claimRules as never,
				facts: version.facts as never,
				sourceRefs: version.sourceRefs as never,
			},
			createdBy: version.createdBy,
			createdAt: version.createdAt.toISOString(),
			immutable: true as const,
		};
	}

	function mapDecision(decision: ProfileDecisionRow | undefined) {
		if (!decision) return null;
		return {
			organizationId: decision.organizationId,
			brandId: decision.brandId,
			id: decision.id,
			profileVersionId: decision.profileVersionId,
			profileHash: decision.profileHash,
			decision: decision.decision,
			decidedBy: decision.decidedBy,
			reason: decision.reason,
			createdAt: decision.createdAt.toISOString(),
		};
	}

	async function transact<T>(
		context: ContentAuthContext,
		brandId: string,
		operation: (tx: ContentTransaction) => Promise<T>,
		serializeBrandWrites = false,
	): Promise<T> {
		return withBrandRequestContext(database, context, brandId, operation, serializeBrandWrites);
	}

	async function readVersions(
		tx: ContentTransaction,
		context: ContentAuthContext,
		brandId: string,
	): Promise<CurrentProfile[]> {
		const versions = await tx
			.select()
			.from(scrBrandContentProfileVersions)
			.where(
				and(
					eq(scrBrandContentProfileVersions.organizationId, context.tenantId),
					eq(scrBrandContentProfileVersions.brandId, brandId),
				),
			)
			.orderBy(desc(scrBrandContentProfileVersions.version));
		return Promise.all(
			versions.map(async (version) => {
				const [decision] = await tx
					.select()
					.from(scrBrandContentProfileDecisions)
					.where(eq(scrBrandContentProfileDecisions.profileVersionId, version.id))
					.orderBy(desc(scrBrandContentProfileDecisions.createdAt), desc(scrBrandContentProfileDecisions.id))
					.limit(1);
				return { version: mapVersion(version), decision: mapDecision(decision) } as CurrentProfile;
			}),
		);
	}

	async function appendAudit(
		tx: ContentTransaction,
		context: ContentAuthContext,
		brandId: string,
		action: string,
		aggregateId: string,
		metadata: Record<string, unknown>,
	) {
		return appendContentAudit(tx, context, brandId, action, "content_project_profile", aggregateId, metadata);
	}

	return {
		profiles: {
			async getCurrent(context: ContentAuthContext, brandId: string): Promise<CurrentProfile | null> {
				return transact(context, brandId, async (tx) => {
					const versions = await readVersions(tx, context, brandId);
					return versions.find((entry) => entry.decision?.decision === "CONFIRMED") ?? null;
				});
			},
			async listVersions(context: ContentAuthContext, brandId: string): Promise<CurrentProfile[]> {
				return transact(context, brandId, (tx) => readVersions(tx, context, brandId));
			},
			async createVersion(context: ContentAuthContext, input: CreateProfileVersionInput): Promise<ProfileVersionRef> {
				assertWritable(context);
				if (input.organizationId !== context.tenantId)
					throw new Error("Forbidden: organization is controlled by the session");
				const profile = normalizeProfile(input.profile);
				const hash = profileHash(profile);
				return transact(
					context,
					input.brandId,
					async (tx) => {
						const [existing] = await tx
							.select({
								id: scrBrandContentProfileVersions.id,
								version: scrBrandContentProfileVersions.version,
								profileHash: scrBrandContentProfileVersions.profileHash,
							})
							.from(scrBrandContentProfileVersions)
							.where(
								and(
									eq(scrBrandContentProfileVersions.brandId, input.brandId),
									eq(scrBrandContentProfileVersions.profileHash, hash),
								),
							)
							.limit(1);
						if (existing) return existing;
						const [latest] = await tx
							.select({ version: max(scrBrandContentProfileVersions.version) })
							.from(scrBrandContentProfileVersions)
							.where(eq(scrBrandContentProfileVersions.brandId, input.brandId));
						const version = Number(latest?.version ?? 0) + 1;
						const [created] = await tx
							.insert(scrBrandContentProfileVersions)
							.values({
								organizationId: context.tenantId,
								brandId: input.brandId,
								version,
								languages: profile.languages,
								audience: profile.audience,
								voice: profile.voice,
								ctaRules: profile.ctaRules,
								visualRules: profile.visualRules,
								claimRules: profile.claimRules,
								facts: profile.facts,
								sourceRefs: profile.sourceRefs,
								profileHash: hash,
								createdBy: context.actorId,
							})
							.returning({
								id: scrBrandContentProfileVersions.id,
								version: scrBrandContentProfileVersions.version,
								profileHash: scrBrandContentProfileVersions.profileHash,
							});
						if (!created) throw new Error("Profile version could not be created");
						await appendAudit(
							tx,
							context,
							input.brandId,
							"content.profile_version_created",
							created.id,
							auditMetadata({ profileVersionId: created.id, profileHash: hash, decision: "DRAFT" }),
						);
						return created;
					},
					true,
				);
			},
			async decide(
				context: ContentAuthContext,
				input: ConfirmProfileVersionInput,
			): Promise<{ id: string; profileVersionId: string; decision: "CONFIRMED" | "REVOKED" }> {
				assertOwner(context);
				validateDecision(input);
				if (input.organizationId !== context.tenantId)
					throw new Error("Forbidden: organization is controlled by the session");
				return transact(
					context,
					input.brandId,
					async (tx) => {
						const [version] = await tx
							.select()
							.from(scrBrandContentProfileVersions)
							.where(
								and(
									eq(scrBrandContentProfileVersions.id, input.profileVersionId),
									eq(scrBrandContentProfileVersions.organizationId, context.tenantId),
									eq(scrBrandContentProfileVersions.brandId, input.brandId),
								),
							)
							.limit(1);
						if (!version) throw new Error("Profile version is not available for this brand");
						const [created] = await tx
							.insert(scrBrandContentProfileDecisions)
							.values({
								organizationId: context.tenantId,
								brandId: input.brandId,
								profileVersionId: version.id,
								profileHash: version.profileHash,
								decision: input.decision,
								decidedBy: context.actorId,
								reason: input.reason?.trim() || null,
							})
							.returning({
								id: scrBrandContentProfileDecisions.id,
								profileVersionId: scrBrandContentProfileDecisions.profileVersionId,
								decision: scrBrandContentProfileDecisions.decision,
							});
						if (!created) throw new Error("Profile decision could not be recorded");
						await appendAudit(
							tx,
							context,
							input.brandId,
							input.decision === "CONFIRMED" ? "content.profile_confirmed" : "content.profile_revoked",
							created.id,
							auditMetadata({
								profileVersionId: version.id,
								profileHash: version.profileHash,
								decision: input.decision,
							}),
						);
						return created;
					},
					true,
				);
			},
		},
		channels: {
			async ensureDraftYouTube(context: ContentAuthContext, brandId: string) {
				assertWritable(context);
				return transact(
					context,
					brandId,
					async (tx) => {
						const [existing] = await tx
							.select()
							.from(scrContentChannels)
							.where(
								and(
									eq(scrContentChannels.organizationId, context.tenantId),
									eq(scrContentChannels.brandId, brandId),
									eq(scrContentChannels.platform, "youtube"),
								),
							)
							.limit(1);
						if (existing) return existing;
						const [created] = await tx
							.insert(scrContentChannels)
							.values({
								organizationId: context.tenantId,
								brandId,
								platform: "youtube",
								publicationMode: "DRAFT_ONLY",
								displayName: "YouTube",
								createdBy: context.actorId,
							})
							.returning();
						if (!created) throw new Error("YouTube target could not be created");
						await appendAudit(tx, context, brandId, "content.channel_draft_created", created.id, {
							channelId: created.id,
							platform: "youtube",
							publicationMode: "DRAFT_ONLY",
						});
						return created;
					},
					true,
				);
			},
		},
	};
}

export const contentWorkflowRepositories = createContentWorkflowRepositories();

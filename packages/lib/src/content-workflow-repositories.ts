/**
 * Database side of the material projection, written against a `pg` client the
 * caller has already placed in a transaction. Every statement here runs under
 * the registry worker role and the request context it established, so the row
 * level security of the Control Room decides what may be written — this module
 * never carries an identity of its own.
 */
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { ContentDraftInput, ResolvedBinding } from "./selena-aether-projection";
import { sha256 } from "./selena-control-room";

export const REGISTRY_WORKER_ACTOR = "service:registry-worker";

export interface ClaimedDraftEvent {
	eventRowId: string;
	eventId: string;
	schemaVersion: string;
	sourceProjectId: string;
	aggregateId: string;
	version: number;
	occurredAt: string;
	traceId: string;
	payload: unknown;
	payloadSha256: string;
}

/** The worker's own identity, set before any function that checks it. */
export async function setWorkerServiceSettings(client: PoolClient): Promise<void> {
	await client.query("SELECT set_config('app.selena_service_identity', 'registry_worker', true)");
	await client.query("SELECT set_config('app.selena_actor_id', $1, true)", [REGISTRY_WORKER_ACTOR]);
	await client.query("SELECT set_config('app.selena_auth_type', 'service', true)");
}

export async function claimNextDraftEvent(client: PoolClient): Promise<ClaimedDraftEvent | null> {
	const result = await client.query<{
		event_row_id: string;
		event_id: string;
		schema_version: string;
		source_project_id: string;
		aggregate_id: string;
		version: number;
		occurred_at: Date;
		trace_id: string;
		payload: unknown;
		payload_sha256: string;
	}>("SELECT * FROM selena_ingest_raw.claim_next_aether_draft_event()");
	const row = result.rows[0];
	if (!row) return null;
	return {
		eventRowId: row.event_row_id,
		eventId: row.event_id,
		schemaVersion: row.schema_version,
		sourceProjectId: row.source_project_id,
		aggregateId: row.aggregate_id,
		version: row.version,
		occurredAt: row.occurred_at.toISOString(),
		traceId: row.trace_id,
		payload: row.payload,
		payloadSha256: row.payload_sha256,
	};
}

export async function resolveBinding(
	client: PoolClient,
	aetherProjectId: string,
	sourceEnvironment: string,
): Promise<ResolvedBinding | null> {
	const result = await client.query<{
		binding_id: string;
		organization_id: string;
		brand_id: string;
		aether_business_key: string;
	}>("SELECT * FROM selena_registry.resolve_growth_binding($1::uuid, $2)", [aetherProjectId, sourceEnvironment]);
	const row = result.rows[0];
	if (!row) return null;
	return {
		bindingId: row.binding_id,
		organizationId: row.organization_id,
		brandId: row.brand_id,
		aetherBusinessKey: row.aether_business_key,
	};
}

/** The standard brand context; from here on RLS speaks for the brand. */
export async function enterBrandContext(
	client: PoolClient,
	binding: ResolvedBinding,
	correlationId = randomUUID(),
): Promise<void> {
	await client.query("SELECT selena_registry.set_request_context($1, $2, $3, $4, $5, $6, $7, NULL)", [
		REGISTRY_WORKER_ACTOR,
		binding.organizationId,
		binding.brandId,
		"service",
		correlationId,
		"registry_worker",
		"service",
	]);
}

export async function currentPolicyVersion(client: PoolClient, binding: ResolvedBinding): Promise<string | null> {
	const result = await client.query<{ policy_version: string }>(
		`SELECT policy_version FROM selena_registry.content_policies
		 WHERE organization_id = $1 AND brand_id = $2
		 ORDER BY created_at DESC, policy_version DESC LIMIT 1`,
		[binding.organizationId, binding.brandId],
	);
	return result.rows[0]?.policy_version ?? null;
}

export interface DraftVersionRef {
	contentId: string;
	contentVersionId: string;
	created: boolean;
}

/**
 * One material aggregate is one content item; one event version is one content
 * version. Both inserts are idempotent through the unique indexes, so a repeated
 * projection of the same event finds what is already there and adds nothing.
 */
export async function createDraftVersion(client: PoolClient, input: ContentDraftInput): Promise<DraftVersionRef> {
	const item = await client.query<{ id: string }>(
		`INSERT INTO selena_registry.content_items
		   (organization_id, brand_id, title, created_by, kind, external_source, external_ref, brief_ref)
		 VALUES ($1, $2, $3, $4, $5, 'aether', $6::uuid, $7::uuid)
		 ON CONFLICT (brand_id, external_source, external_ref) WHERE external_ref IS NOT NULL
		 DO UPDATE SET title = EXCLUDED.title, updated_at = now()
		 RETURNING id`,
		[input.organizationId, input.brandId, input.title, input.createdBy, input.kind, input.externalRef, input.briefRef],
	);
	const contentId = item.rows[0]?.id;
	if (!contentId) throw new Error("content item was neither created nor found");

	const existing = await client.query<{ id: string }>(
		"SELECT id FROM selena_registry.content_versions WHERE content_id = $1 AND version = $2",
		[contentId, input.version],
	);
	if (existing.rows[0]) return { contentId, contentVersionId: existing.rows[0].id, created: false };

	const version = await client.query<{ id: string }>(
		`INSERT INTO selena_registry.content_versions
		   (organization_id, brand_id, content_id, version, body, cta_url, claims, evidence, disclosure,
		    policy_version, content_hash, created_by)
		 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12)
		 RETURNING id`,
		[
			input.organizationId,
			input.brandId,
			contentId,
			input.version,
			input.body,
			input.ctaUrl,
			JSON.stringify(input.claims),
			JSON.stringify(input.evidence),
			JSON.stringify(input.disclosure),
			input.policyVersion,
			input.contentHash,
			input.createdBy,
		],
	);
	const contentVersionId = version.rows[0]?.id;
	if (!contentVersionId) throw new Error("content version was not created");
	return { contentId, contentVersionId, created: true };
}

/** Same chain as the web's appendAudit: previous hash, then a hash over the event itself. */
export async function appendWorkerAudit(
	client: PoolClient,
	input: {
		organizationId: string;
		brandId: string;
		action: string;
		aggregateType: string;
		aggregateId: string;
		metadata: Record<string, unknown>;
	},
): Promise<void> {
	await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${input.organizationId}:${input.brandId}`]);
	const previous = await client.query<{ event_hash: string }>(
		`SELECT event_hash FROM selena_audit.audit_events
		 WHERE organization_id = $1 AND brand_id = $2 ORDER BY created_at DESC LIMIT 1`,
		[input.organizationId, input.brandId],
	);
	const previousHash = previous.rows[0]?.event_hash ?? null;
	const eventHash = sha256({
		action: input.action,
		aggregateId: input.aggregateId,
		aggregateType: input.aggregateType,
		actorId: REGISTRY_WORKER_ACTOR,
		brandId: input.brandId,
		metadata: input.metadata,
		previousHash,
	});
	await client.query(
		`INSERT INTO selena_audit.audit_events
		   (organization_id, brand_id, actor_id, action, aggregate_type, aggregate_id, previous_hash, event_hash, metadata)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
		[
			input.organizationId,
			input.brandId,
			REGISTRY_WORKER_ACTOR,
			input.action,
			input.aggregateType,
			input.aggregateId,
			previousHash,
			eventHash,
			JSON.stringify(input.metadata),
		],
	);
}

export async function markProjected(
	client: PoolClient,
	eventRowId: string,
	outcome: { contentVersionId: string } | { error: string },
): Promise<void> {
	await client.query("SELECT selena_ingest_raw.mark_aether_event_projected($1::uuid, $2::uuid, $3)", [
		eventRowId,
		"contentVersionId" in outcome ? outcome.contentVersionId : null,
		"error" in outcome ? outcome.error : null,
	]);
}

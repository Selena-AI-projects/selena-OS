import { createServerFn } from "@tanstack/react-start";
import { db } from "@workspace/lib/db/db";
import { svResponseMentions, svRuns, svScenarios } from "@workspace/lib/db/schema";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { resolveSessionAuthContext } from "../lib/selena-auth-context";

export type RunListItem = {
	id: string;
	system: string | null;
	channel: string;
	status: string;
	validity: string | null;
	captureMode: string | null;
	finishedAt: string | null;
};

export type RunDetail = RunListItem & {
	scenarioText: string | null;
	language: string | null;
	/** Null when never stored; a marker object when deleted by retention. */
	answer: { state: "present"; text: string } | { state: "deleted"; deletedAt: string } | { state: "absent" };
	rawResponseReference: string | null;
	mentions: { entityType: string; name: string; ordinalPosition: number | null }[];
	citations: { url: string; domain: string }[];
	/** What the Visitor View surface displayed, when the adapter carried it. */
	sources: { url: string; domain: string; title?: string }[];
};

/**
 * Addendum §7, the customer-facing half: every number on the measurement step
 * must be walkable back to the answers it came from. Reads are tenant-scoped
 * at the SQL level; a foreign run id resolves to "not found", never to data.
 */
export const listSelenaRunsFn = createServerFn({ method: "GET" })
	.validator(z.object({ cycleId: z.string().uuid() }))
	.handler(async ({ data }): Promise<{ runs: RunListItem[] }> => {
		const context = await resolveSessionAuthContext();
		const rows = await db
			.select({
				id: svRuns.id,
				system: svRuns.system,
				systemId: svRuns.systemId,
				channel: svRuns.channel,
				status: svRuns.status,
				validity: svRuns.validity,
				captureMode: svRuns.captureMode,
				finishedAt: svRuns.finishedAt,
			})
			.from(svRuns)
			.where(and(eq(svRuns.cycleId, data.cycleId), eq(svRuns.organizationId, context.tenantId)))
			.orderBy(desc(svRuns.finishedAt))
			.limit(100);
		return {
			runs: rows.map((row) => ({
				id: row.id,
				system: row.system ?? row.systemId,
				channel: row.channel,
				status: row.status,
				validity: row.validity,
				captureMode: row.captureMode,
				finishedAt: row.finishedAt?.toISOString() ?? null,
			})),
		};
	});

function readAnswer(payload: unknown): RunDetail["answer"] {
	if (typeof payload !== "object" || payload === null) return { state: "absent" };
	const answer = (payload as Record<string, unknown>).answer;
	if (typeof answer !== "object" || answer === null) return { state: "absent" };
	const record = answer as Record<string, unknown>;
	if (typeof record.text === "string") return { state: "present", text: record.text };
	if (typeof record.textDeletedAt === "string") return { state: "deleted", deletedAt: record.textDeletedAt };
	return { state: "absent" };
}

function readSources(payload: unknown): RunDetail["sources"] {
	if (typeof payload !== "object" || payload === null) return [];
	const sources = (payload as Record<string, unknown>).sources;
	if (!Array.isArray(sources)) return [];
	return sources.flatMap((item) => {
		if (typeof item !== "object" || item === null) return [];
		const record = item as Record<string, unknown>;
		if (typeof record.url !== "string" || typeof record.domain !== "string") return [];
		return [
			{
				url: record.url,
				domain: record.domain,
				...(typeof record.title === "string" ? { title: record.title } : {}),
			},
		];
	});
}

function readCitations(value: unknown): RunDetail["citations"] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (typeof item !== "object" || item === null) return [];
		const record = item as Record<string, unknown>;
		return typeof record.url === "string" && typeof record.domain === "string"
			? [{ url: record.url, domain: record.domain }]
			: [];
	});
}

export const getSelenaRunDetailFn = createServerFn({ method: "GET" })
	.validator(z.object({ runId: z.string().uuid() }))
	.handler(async ({ data }): Promise<RunDetail> => {
		const context = await resolveSessionAuthContext();
		const [run] = await db
			.select()
			.from(svRuns)
			.where(and(eq(svRuns.id, data.runId), eq(svRuns.organizationId, context.tenantId)))
			.limit(1);
		if (!run) throw new Error("Not found: run is outside AuthContext tenant");
		const [mentions, [scenario]] = await Promise.all([
			db
				.select({
					entityType: svResponseMentions.entityType,
					name: svResponseMentions.name,
					ordinalPosition: svResponseMentions.ordinalPosition,
				})
				.from(svResponseMentions)
				.where(and(eq(svResponseMentions.runId, run.id), eq(svResponseMentions.organizationId, context.tenantId)))
				.orderBy(asc(svResponseMentions.ordinalPosition)),
			db
				.select({ text: svScenarios.text })
				.from(svScenarios)
				.where(and(eq(svScenarios.id, run.scenarioId), eq(svScenarios.organizationId, context.tenantId)))
				.limit(1),
		]);
		return {
			id: run.id,
			system: run.system ?? run.systemId,
			channel: run.channel,
			status: run.status,
			validity: run.validity,
			captureMode: run.captureMode,
			finishedAt: run.finishedAt?.toISOString() ?? null,
			scenarioText: scenario?.text ?? null,
			language: run.language,
			answer: readAnswer(run.canonicalPayload),
			rawResponseReference: run.rawResponseReference,
			mentions,
			citations: readCitations(run.citations),
			sources: readSources(run.canonicalPayload),
		};
	});

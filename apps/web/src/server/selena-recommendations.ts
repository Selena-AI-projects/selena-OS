import { createServerFn } from "@tanstack/react-start";
import { db } from "@workspace/lib/db/db";
import { createRecommendationRepositories } from "@workspace/lib/recommendation-persistence";
import { z } from "zod";
import { resolveSessionAuthContext } from "../lib/selena-auth-context";

const repositories = /* @__PURE__ */ createRecommendationRepositories(db);
const evidenceSchema = z.object({ id: z.string().min(1), tenantId: z.string().min(1), snapshotId: z.string().min(1), kind: z.enum(["AI_RESPONSE", "WEBSITE", "SEARCH", "MAPS", "REVIEW", "SOCIAL", "UPLOADED"]), accessClass: z.enum(["PUBLIC", "CONNECTED", "UPLOADED"]), sourceRef: z.string().min(1), capturedAt: z.string().min(1), subject: z.string().min(1), text: z.string(), metadata: z.record(z.string(), z.unknown()).default({}) });
const runInput = z.object({ projectId: z.string().uuid(), datasetId: z.string().min(1), idempotencyKey: z.string().min(8).max(200), evidence: z.array(evidenceSchema).min(1), rulepackVersion: z.string().min(1).optional() });
const runIdInput = z.object({ runId: z.string().uuid() });
const serialiseRun = (run: Awaited<ReturnType<typeof repositories.status>>) => ({ ...run, createdAt: run.createdAt.toISOString(), completedAt: run.completedAt?.toISOString() ?? null, actionPlan: run.actionPlan ?? null });

export const runSelenaRecommendationFn = createServerFn({ method: "POST" }).validator(runInput).handler(async ({ data }) => serialiseRun(await repositories.create(await resolveSessionAuthContext(), data)));
export const getSelenaRecommendationStatusFn = createServerFn({ method: "GET" }).validator(runIdInput).handler(async ({ data }) => serialiseRun(await repositories.status(await resolveSessionAuthContext(), data.runId)));
export const getSelenaRecommendationFindingsFn = createServerFn({ method: "GET" }).validator(runIdInput).handler(async ({ data }) => repositories.findings(await resolveSessionAuthContext(), data.runId));
export const getSelenaRecommendationsFn = createServerFn({ method: "GET" }).validator(runIdInput).handler(async ({ data }) => repositories.recommendations(await resolveSessionAuthContext(), data.runId));
export const getSelenaActionPlanFn = createServerFn({ method: "GET" }).validator(runIdInput).handler(async ({ data }) => repositories.actionPlan(await resolveSessionAuthContext(), data.runId));

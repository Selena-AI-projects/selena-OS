import { createServerFn } from "@tanstack/react-start";
import { db } from "@workspace/lib/db/db";
import {
	evidenceObjectKey,
	presignEvidenceUrl,
	rawEvidenceStorageFromEnv,
} from "@workspace/lib/selena-raw-evidence-storage";
import { createSelenaRepositories } from "@workspace/lib/selena-visibility-repositories";
import { z } from "zod";
import { resolveSessionAuthContext } from "../lib/selena-auth-context";

const repositories = /* @__PURE__ */ createSelenaRepositories(db);

const SIGNED_URL_TTL_SECONDS = 600;

export type RawEvidenceUrlResult =
	| { available: false; reason: "STORAGE_NOT_CONFIGURED" | "NO_REFERENCE" }
	| { available: true; url: string; expiresAt: string };

/**
 * Addendum §7: the only way to a raw evidence object. Tenant authorization
 * and the audit row both happen inside rawEvidenceFor — this function cannot
 * sign a reference that read did not return. Unconfigured storage answers
 * honestly instead of failing.
 */
export const getSelenaRawEvidenceUrlFn = createServerFn({ method: "POST" })
	.validator(z.object({ runId: z.string().uuid() }))
	.handler(async ({ data }): Promise<RawEvidenceUrlResult> => {
		const context = await resolveSessionAuthContext();
		const run = await repositories.runs.rawEvidenceFor(context, data.runId);
		if (!run.rawResponseReference) return { available: false, reason: "NO_REFERENCE" };
		const config = rawEvidenceStorageFromEnv();
		if (!config) return { available: false, reason: "STORAGE_NOT_CONFIGURED" };
		const signed = presignEvidenceUrl(config, evidenceObjectKey(run.rawResponseReference), {
			now: new Date(),
			expiresInSeconds: SIGNED_URL_TTL_SECONDS,
		});
		return { available: true, url: signed.url, expiresAt: signed.expiresAt.toISOString() };
	});

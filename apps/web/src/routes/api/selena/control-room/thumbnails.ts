import { createFileRoute } from "@tanstack/react-router";
import { MAX_SELENA_ASSET_BYTES, validateSelenaAsset } from "@workspace/lib/selena-private-storage";
import { z } from "zod";
import { isContentOsStage1Enabled } from "../../../../lib/content-os-stage1.server";
import { resolveSessionAuthContext } from "../../../../lib/selena-auth-context.server";
import { uploadSelenaPrivateAsset } from "../../../../lib/selena-scanner-client";
import { describeThumbnailAttachFailure, type ThumbnailAttachFailure } from "../../../../lib/thumbnail-attach.server";
import { assertControlRoomContentVersionWriteAccess } from "../../../../server/selena-control-room-access.server";

/**
 * Attaching a thumbnail to a content version.
 *
 * Separate from the general asset upload because this one owes the caller a
 * normalized code rather than a sentence, and because the caller has to be able
 * to tell `BLOCKED_STORAGE` from everything else.
 *
 * Not under `/api/v1/`: that prefix is the key-authenticated public API, and a
 * session upload from the browser carries no key. This route authenticates by
 * session and refuses outright when Stage 1 is off.
 *
 * Bytes never come back out of here and never reach the database. The scanner
 * writes an opaque storage reference and a SHA-256; this route answers with an
 * id and a scan state.
 */

const metadataSchema = z.object({
	brandId: z.string().trim().min(1).max(120),
	consentExpiresAt: z.coerce.date(),
	contentVersionId: z.string().uuid(),
	origin: z.enum(["UPLOADED", "GENERATED"]),
	rightsExpiresAt: z.coerce.date(),
});

function refuse(result: ThumbnailAttachFailure): Response {
	return Response.json({ error: result.message, code: result.code }, { status: result.status });
}

export const Route = createFileRoute("/api/selena/control-room/thumbnails")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				// Fail-closed and before the body is read: a disabled Stage 1 has no
				// thumbnail path, and 404 keeps that indistinguishable from a route that
				// was never deployed.
				if (!isContentOsStage1Enabled()) return Response.json({ error: "not_found" }, { status: 404 });

				try {
					const form = await request.formData();
					const parsed = metadataSchema.safeParse({
						brandId: form.get("brandId"),
						consentExpiresAt: form.get("consentExpiresAt"),
						contentVersionId: form.get("contentVersionId"),
						origin: form.get("origin"),
						rightsExpiresAt: form.get("rightsExpiresAt"),
					});
					if (!parsed.success) {
						return refuse({ code: "INVALID_INPUT", message: "Invalid thumbnail details", status: 400 });
					}
					if (parsed.data.rightsExpiresAt <= new Date() || parsed.data.consentExpiresAt <= new Date()) {
						return refuse({
							code: "INVALID_INPUT",
							message: "Rights and consent dates must be in the future",
							status: 400,
						});
					}
					const file = form.get("file");
					if (!(file instanceof File) || file.size === 0) {
						return refuse({ code: "INVALID_INPUT", message: "Select an image file", status: 400 });
					}
					if (file.size > MAX_SELENA_ASSET_BYTES) {
						return refuse({ code: "INVALID_INPUT", message: "Images must be 10 MiB or smaller", status: 400 });
					}

					const bytes = new Uint8Array(await file.arrayBuffer());
					// The same check the scanner runs, run here so a mislabelled file is
					// refused before it is stored rather than after.
					const asset = validateSelenaAsset({ bytes, mimeType: file.type });

					const context = await resolveSessionAuthContext();
					await assertControlRoomContentVersionWriteAccess(context, parsed.data.brandId, parsed.data.contentVersionId);
					const uploaded = await uploadSelenaPrivateAsset({
						actorId: context.actorId,
						brandId: parsed.data.brandId,
						bytes: asset.bytes,
						consentExpiresAt: parsed.data.consentExpiresAt.toISOString(),
						contentVersionId: parsed.data.contentVersionId,
						filename: file.name,
						mimeType: asset.mimeType,
						organizationId: context.tenantId,
						origin: parsed.data.origin,
						rightsExpiresAt: parsed.data.rightsExpiresAt.toISOString(),
					});
					return Response.json({ ...uploaded, origin: parsed.data.origin }, { status: 202 });
				} catch (error) {
					return refuse(describeThumbnailAttachFailure(error));
				}
			},
		},
	},
});

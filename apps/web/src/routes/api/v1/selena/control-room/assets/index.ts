import { createFileRoute } from "@tanstack/react-router";
import { MAX_SELENA_ASSET_BYTES } from "@workspace/lib/selena-private-storage";
import { z } from "zod";
import { resolveSessionAuthContext } from "../../../../../../lib/selena-auth-context";
import { uploadSelenaPrivateAsset } from "../../../../../../lib/selena-scanner-client";
import { assertControlRoomContentVersionWriteAccess } from "../../../../../../server/selena-control-room";

const metadataSchema = z.object({
	brandId: z.string().trim().min(1).max(120),
	consentExpiresAt: z.coerce.date(),
	contentVersionId: z.string().uuid(),
	rightsExpiresAt: z.coerce.date(),
});

function failureStatus(message: string): number {
	if (message.startsWith("Unauthorized")) return 401;
	if (message.startsWith("Forbidden") || message.includes("not available for this brand")) return 403;
	if (message.includes("not configured")) return 503;
	return 400;
}

export const Route = createFileRoute("/api/v1/selena/control-room/assets/")({
	server: {
		handlers: {
			POST: async ({ request }) => {
				try {
					const form = await request.formData();
					const parsed = metadataSchema.safeParse({
						brandId: form.get("brandId"),
						consentExpiresAt: form.get("consentExpiresAt"),
						contentVersionId: form.get("contentVersionId"),
						rightsExpiresAt: form.get("rightsExpiresAt"),
					});
					if (!parsed.success) return Response.json({ error: "Invalid asset details" }, { status: 400 });
					if (parsed.data.rightsExpiresAt <= new Date() || parsed.data.consentExpiresAt <= new Date()) {
						return Response.json({ error: "Rights and consent dates must be in the future" }, { status: 400 });
					}
					const file = form.get("file");
					if (!(file instanceof File) || file.size === 0)
						return Response.json({ error: "Select a media file" }, { status: 400 });
					if (file.size > MAX_SELENA_ASSET_BYTES) {
						return Response.json({ error: "Media files must be 10 MiB or smaller" }, { status: 400 });
					}

					const context = await resolveSessionAuthContext();
					await assertControlRoomContentVersionWriteAccess(context, parsed.data.brandId, parsed.data.contentVersionId);
					const uploaded = await uploadSelenaPrivateAsset({
						actorId: context.actorId,
						brandId: parsed.data.brandId,
						bytes: new Uint8Array(await file.arrayBuffer()),
						consentExpiresAt: parsed.data.consentExpiresAt.toISOString(),
						contentVersionId: parsed.data.contentVersionId,
						filename: file.name,
						mimeType: file.type,
						organizationId: context.tenantId,
						rightsExpiresAt: parsed.data.rightsExpiresAt.toISOString(),
					});
					return Response.json(uploaded, { status: 202 });
				} catch (error) {
					const message = error instanceof Error ? error.message : "Asset upload failed";
					return Response.json({ error: message }, { status: failureStatus(message) });
				}
			},
		},
	},
});

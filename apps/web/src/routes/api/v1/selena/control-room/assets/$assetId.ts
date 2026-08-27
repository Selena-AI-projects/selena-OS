import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { resolveSessionAuthContext } from "../../../../../../lib/selena-auth-context";
import { createSelenaPrivateAssetDownloadUrl } from "../../../../../../lib/selena-scanner-client";
import { assertControlRoomAssetReadAccess } from "../../../../../../server/selena-control-room";

const paramsSchema = z.object({ assetId: z.string().uuid() });

export const Route = createFileRoute("/api/v1/selena/control-room/assets/$assetId")({
	server: {
		handlers: {
			GET: async ({ params, request }) => {
				try {
					const { assetId } = paramsSchema.parse(params);
					const brandId = new URL(request.url).searchParams.get("brandId");
					if (!brandId) return Response.json({ error: "brandId is required" }, { status: 400 });
					const context = await resolveSessionAuthContext();
					await assertControlRoomAssetReadAccess(context, brandId, assetId);
					return Response.json(
						await createSelenaPrivateAssetDownloadUrl({
							actorId: context.actorId,
							assetId,
							brandId,
							organizationId: context.tenantId,
						}),
					);
				} catch (error) {
					const message = error instanceof Error ? error.message : "Asset download failed";
					const status = message.startsWith("Unauthorized") ? 401 : message.startsWith("Forbidden") ? 403 : 400;
					return Response.json({ error: message }, { status });
				}
			},
		},
	},
});

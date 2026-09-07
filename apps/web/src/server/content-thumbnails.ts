import { createServerFn } from "@tanstack/react-start";
import { contentReviewRepositories } from "@workspace/lib/content-review-repositories";
import { z } from "zod";
import { isContentOsStage1Enabled } from "@/lib/content-os-stage1.server";
import { resolveSessionAuthContext } from "@/lib/selena-auth-context.server";

/**
 * The Create-side read for thumbnails. Attaching one is a multipart upload and
 * lives at `/api/v1/selena/control-room/thumbnails`; this only says what is
 * already attached and whether it can go in front of a reviewer.
 */

const brandInput = z.object({ brandId: z.string().trim().min(1).max(120) });

export const getContentThumbnailsFn = createServerFn({ method: "GET" })
	.validator(brandInput)
	.handler(async ({ data }) => {
		if (!isContentOsStage1Enabled()) throw new Error("Content OS Stage 1 is disabled");
		const context = await resolveSessionAuthContext();
		return contentReviewRepositories.getThumbnails(context, data.brandId);
	});

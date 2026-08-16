import { createFileRoute } from "@tanstack/react-router";
import { canonicalPublicReadinessResponse } from "../../../../lib/selena-canonical-readiness";

/**
 * Historical clients may still call this route, so it remains as an
 * explicit no-side-effect tombstone. The public site owns the only free
 * readiness collector and scoring engine.
 */
export const Route = createFileRoute("/api/v1/selena/public-scan")({
	server: {
		handlers: {
			POST: () => canonicalPublicReadinessResponse(),
		},
	},
});

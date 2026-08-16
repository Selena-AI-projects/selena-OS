import { createFileRoute } from "@tanstack/react-router";
import { canonicalPublicReadinessResponse } from "../../../../../../../../lib/selena-canonical-readiness";

/**
 * Fix previews belong to the canonical public site result. The old app route
 * is intentionally a no-side-effect tombstone; it must not parse or expose
 * the legacy scorer's persisted result.
 */
export const Route = createFileRoute("/api/v1/selena/readiness/scans/$scanId/fixes/$findingId")({
	server: {
		handlers: {
			GET: () => canonicalPublicReadinessResponse(),
		},
	},
});

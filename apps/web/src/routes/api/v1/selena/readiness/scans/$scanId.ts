import { createFileRoute } from "@tanstack/react-router";
import { canonicalPublicReadinessResponse } from "../../../../../../lib/selena-canonical-readiness";

/**
 * Historical scan reads are retired with the write path. Keeping this route
 * as a tombstone prevents an old scan id from exposing the legacy table or
 * reintroducing a second readiness result contract.
 */
export const Route = createFileRoute("/api/v1/selena/readiness/scans/$scanId")({
	server: {
		handlers: {
			GET: () => canonicalPublicReadinessResponse(),
		},
	},
});

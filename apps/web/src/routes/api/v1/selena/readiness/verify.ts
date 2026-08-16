import { createFileRoute } from "@tanstack/react-router";
import { canonicalPublicReadinessResponse } from "../../../../../lib/selena-canonical-readiness";

/** Verification belongs to the same canonical public pipeline as the baseline. */
export const Route = createFileRoute("/api/v1/selena/readiness/verify")({
	server: {
		handlers: {
			POST: () => canonicalPublicReadinessResponse(),
		},
	},
});

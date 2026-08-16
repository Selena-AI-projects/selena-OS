import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Compatibility alias for the retired learning route. The canonical course
 * boundary is /app/academy; course entitlements are still not activated.
 */
export const Route = createFileRoute("/app/learn")({
	beforeLoad: () => {
		throw redirect({ to: "/app/academy" });
	},
});

import { createFileRoute, redirect } from "@tanstack/react-router";
import { CanonicalReadinessRedirect, SELENA_PUBLIC_READINESS_URL } from "./selena";

export const Route = createFileRoute("/check")({
	beforeLoad: () => {
		throw redirect({ href: SELENA_PUBLIC_READINESS_URL });
	},
	component: CanonicalReadinessRedirect,
});

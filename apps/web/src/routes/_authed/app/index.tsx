import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authed/app/")({
	beforeLoad: () => {
		throw redirect({ to: "/app/selena" });
	},
});

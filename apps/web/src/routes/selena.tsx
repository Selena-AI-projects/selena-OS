import { createFileRoute, redirect } from "@tanstack/react-router";

export const SELENA_PUBLIC_READINESS_URL = "https://www.selenasystems.com/check";

/**
 * Public Readiness has one canonical surface. The authenticated application
 * keeps projects and paid measurement results; it does not run a second free
 * scanner with a different scoring contract.
 */
export const Route = createFileRoute("/selena")({
	beforeLoad: () => {
		throw redirect({ href: SELENA_PUBLIC_READINESS_URL });
	},
	component: CanonicalReadinessRedirect,
});

export function CanonicalReadinessRedirect() {
	return (
		<main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-6 py-16">
			<p className="text-sm font-medium text-muted-foreground">Selena Public Readiness</p>
			<h1 className="text-4xl font-semibold tracking-tight">Continue to the canonical free check</h1>
			<p className="text-muted-foreground">
				The free readiness audit now runs on Selena Systems so every URL receives one versioned result.
			</p>
			<a className="underline underline-offset-4" href={SELENA_PUBLIC_READINESS_URL}>
				Open selenasystems.com/check
			</a>
		</main>
	);
}

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authed/app/academy")({
	component: AcademyBoundary,
});

function AcademyBoundary() {
	return (
		<main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-5 px-6 py-16">
			<p className="text-sm font-medium text-muted-foreground">Selena Lab</p>
			<h1 className="text-4xl font-semibold tracking-tight">Selena Academy</h1>
			<p className="max-w-2xl text-muted-foreground">
				The private learning area is reserved for course enrollments. Course purchases and learner entitlements are not
				active in this release.
			</p>
			<a className="w-fit underline underline-offset-4" href="https://www.selenasystems.com/lab/courses">
				Explore public Lab courses
			</a>
		</main>
	);
}

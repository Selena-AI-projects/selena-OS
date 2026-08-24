/**
 * /auth/forgot-password - Request a password reset email (cloud only)
 *
 * Always renders the same neutral confirmation whether or not the account
 * exists, to avoid account enumeration.
 */

import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { authClient } from "@workspace/lib/auth/client";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { Label } from "@workspace/ui/components/label";
import { useState } from "react";
import FullPageCard from "@/components/full-page-card";

export const Route = createFileRoute("/auth/forgot-password")({
	// A render-time window.location redirect has no window during SSR: the
	// server render throws and the client recovers with a flash of the page.
	beforeLoad: ({ context }) => {
		if (context.clientConfig?.mode !== "cloud") throw redirect({ to: "/auth/login" });
	},
	component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
	const [email, setEmail] = useState("");
	const [loading, setLoading] = useState(false);
	const [submitted, setSubmitted] = useState(false);

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		setLoading(true);
		try {
			await authClient.requestPasswordReset({ email, redirectTo: "/auth/reset-password" });
		} catch {
			// Same neutral confirmation on failure — no account enumeration.
		}
		setSubmitted(true);
		setLoading(false);
	}

	if (submitted) {
		return (
			<FullPageCard
				title="Check your email"
				subtitle={`If an account exists for ${email}, a reset link is on its way.`}
			>
				<p className="text-center text-sm text-muted-foreground w-full">
					<Link to="/auth/login" className="text-primary hover:underline font-medium">
						Back to sign in
					</Link>
				</p>
			</FullPageCard>
		);
	}

	return (
		<FullPageCard title="Reset your password" subtitle="Enter your email and we'll send you a reset link">
			<form onSubmit={handleSubmit} className="space-y-4 w-full">
				<div className="space-y-2">
					<Label htmlFor="email">Email</Label>
					<Input
						id="email"
						type="email"
						placeholder="you@example.com"
						value={email}
						onChange={(e) => setEmail(e.target.value)}
						required
						autoComplete="email"
						autoFocus
					/>
				</div>
				<Button type="submit" className="w-full" disabled={loading}>
					{loading ? "Sending..." : "Send reset link"}
				</Button>
			</form>
			<p className="text-center text-sm text-muted-foreground pt-4">
				<Link to="/auth/login" className="text-primary hover:underline font-medium">
					Back to sign in
				</Link>
			</p>
		</FullPageCard>
	);
}

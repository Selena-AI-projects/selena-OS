import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { useState } from "react";
import { runSelenaPublicScanFn } from "../server/selena-public-scan";

export const Route = createFileRoute("/selena")({ component: PublicSelenaScan });

function PublicSelenaScan() {
	const [website, setWebsite] = useState("");
	const [result, setResult] = useState<{
		id: string;
		result: { suggestedBrandName: string; domain: string; excerpt: string };
	} | null>(null);
	const [error, setError] = useState("");
	const [pending, setPending] = useState(false);
	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		setPending(true);
		setError("");
		try {
			setResult(await runSelenaPublicScanFn({ data: { website } }));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Public scan failed");
		} finally {
			setPending(false);
		}
	};
	return (
		<main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-6 py-16">
			<div>
				<p className="text-sm font-medium text-muted-foreground">Selena AI Visibility</p>
				<h1 className="mt-2 text-4xl font-semibold tracking-tight">See how your brand appears in AI answers</h1>
				<p className="mt-3 text-muted-foreground">
					Run a public preview without connecting Google, Instagram, Search Console, or any client account.
				</p>
			</div>
			<form onSubmit={submit} className="flex gap-3">
				<Input
					type="url"
					required
					placeholder="https://your-brand.com"
					value={website}
					onChange={(event) => setWebsite(event.target.value)}
				/>
				<Button type="submit" disabled={pending}>
					{pending ? "Scanning…" : "Run public scan"}
				</Button>
			</form>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			{result && (
				<section className="rounded-lg border p-5">
					<p className="text-sm text-muted-foreground">Preview for {result.result.domain}</p>
					<h2 className="mt-1 text-2xl font-semibold">{result.result.suggestedBrandName}</h2>
					<p className="mt-4 whitespace-pre-wrap text-sm">
						{result.result.excerpt || "No public excerpt was available."}
					</p>
					<p className="mt-5 text-sm text-muted-foreground">
						Register to save this project and unlock the full report.
					</p>
				</section>
			)}
		</main>
	);
}

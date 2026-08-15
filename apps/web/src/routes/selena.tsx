import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import { Input } from "@workspace/ui/components/input";
import { SELENA_CATALOG, type SelenaPlan } from "@workspace/selena-visibility-contracts";
import { useState } from "react";
import { runSelenaPublicScanFn } from "../server/selena-public-scan";

export const Route = createFileRoute("/selena")({ component: PublicSelenaScan });

function PublicSelenaScan() {
	const [website, setWebsite] = useState("");
	const [result, setResult] = useState<{
		id: string;
		result: { suggestedBrandName: string; domain: string; excerpt: string; readiness?: { score: number; findings: Array<{ severity: string; statement: string; evidence: string }> } };
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
			<section aria-labelledby="selena-plans" className="grid gap-3 sm:grid-cols-2">
				<h2 id="selena-plans" className="sr-only">Selena plans</h2>
				{Object.values(SELENA_CATALOG).map((plan) => <PlanCard key={plan.planId} plan={plan} />)}
			</section>
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
					{result.result.readiness && <div className="mt-5 rounded-md bg-muted/50 p-4">
						<p className="text-sm text-muted-foreground">Website Public Readiness</p>
						<p className="mt-1 text-4xl font-semibold tabular-nums">{result.result.readiness.score}<span className="text-lg text-muted-foreground">/100</span></p>
						<p className="mt-2 text-xs text-muted-foreground">Readiness — это техническая/контентная готовность сайта, а не фактическая видимость или рекомендация в ChatGPT.</p>
						{result.result.readiness.findings.slice(0, 3).map((item) => <div key={`${item.severity}:${item.statement}`} className="mt-3 border-t pt-3 text-sm"><span className="font-medium">{item.severity}</span> {item.statement}<p className="mt-1 text-xs text-muted-foreground">Evidence: {item.evidence}</p></div>)}
					</div>}
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

function PlanCard({ plan }: { plan: SelenaPlan }) {
	const interval = plan.billingInterval === "month" ? "/month" : plan.billingInterval === "one_time" ? "one-time" : "90 days";
	return (
		<article className="rounded-lg border p-4">
			<div className="flex items-start justify-between gap-3">
				<h3 className="font-semibold">{plan.name}</h3>
				<span className="text-lg font-bold tabular-nums">${plan.price.toLocaleString("en-US")} <span className="text-xs font-normal text-muted-foreground">{interval}</span></span>
			</div>
			<p className="mt-2 text-sm text-muted-foreground">{plan.channelScope.join(" + ")} · {plan.systems.length} systems</p>
			<p className="mt-1 text-sm text-muted-foreground">{plan.scenarioLimit === null ? "Custom locked scenarios" : `Up to ${plan.scenarioLimit} language scenarios`} · {plan.repeatCount ?? "locked"} repeat(s)</p>
			<p className="mt-2 text-xs text-muted-foreground">{plan.verificationLevel === "automated" ? "Automated — not expert verified" : plan.verificationLevel === "expert_verified" ? "Expert Verified" : "Awaiting expert review"}</p>
			<p className="mt-2 text-xs text-muted-foreground">{plan.purchaseMode === "manual_approval_contact_sales" ? "Manual approval / contact sales" : "Test checkout available in staging"}</p>
		</article>
	);
}

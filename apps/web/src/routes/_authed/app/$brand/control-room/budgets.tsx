import { IconCoins, IconLock, IconShieldCheck } from "@tabler/icons-react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { Input } from "@workspace/ui/components/input";
import { Label } from "@workspace/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@workspace/ui/components/select";
import { useState, useTransition } from "react";
import { CONTENT_PRODUCT_NAME } from "@/lib/content-product";
import { getContentBudgetsFn, setContentBudgetFn } from "@/server/content-budgets";

export const Route = createFileRoute("/_authed/app/$brand/control-room/budgets")({
	loader: ({ params }) => getContentBudgetsFn({ data: { brandId: params.brand } }),
	head: () => ({ meta: [{ title: `Provider budgets · ${CONTENT_PRODUCT_NAME}` }] }),
	component: ProviderBudgetsPage,
});

const PROVIDER_LABELS: Record<string, string> = {
	gemini: "Gemini (ideas, scripts)",
	"video-radar": "Video Radar (YouTube research)",
};

function dollars(micros: number): string {
	return `$${(micros / 1_000_000).toFixed(2)}`;
}

function ProviderBudgetsPage() {
	const { brand: brandId } = Route.useParams();
	const { canSet, budgets } = Route.useLoaderData();
	const router = useRouter();
	const [pending, startTransition] = useTransition();
	const [providerId, setProviderId] = useState<"gemini" | "video-radar">("video-radar");
	const [windowKind, setWindowKind] = useState<"DAY" | "MONTH">("DAY");
	const [ceilingCalls, setCeilingCalls] = useState("50");
	const [ceilingDollars, setCeilingDollars] = useState("1.00");
	const [notice, setNotice] = useState<{ kind: "success" | "error"; message: string } | null>(null);

	function saveBudget() {
		const calls = Number.parseInt(ceilingCalls, 10);
		const cost = Math.round(Number.parseFloat(ceilingDollars) * 1_000_000);
		if (!Number.isFinite(calls) || calls <= 0 || !Number.isFinite(cost) || cost < 0) {
			setNotice({ kind: "error", message: "A budget needs a positive call ceiling and a cost ceiling." });
			return;
		}
		startTransition(async () => {
			try {
				await setContentBudgetFn({
					data: { brandId, providerId, windowKind, ceilingCalls: calls, ceilingCostMicros: cost },
				});
				await router.invalidate();
				setNotice({ kind: "success", message: "Budget recorded. Earlier versions stay on file — history is append-only." });
			} catch (error) {
				setNotice({
					kind: "error",
					message: error instanceof Error ? error.message : "The request could not be completed",
				});
			}
		});
	}

	return (
		<div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
			<div>
				<h1 className="text-2xl font-semibold tracking-normal">Provider budgets</h1>
				<p className="mt-1 max-w-2xl text-sm text-muted-foreground">
					The spending fuse. A live provider call must reserve against a budget you set here before it can happen;
					no budget, no estimate, or an exhausted window refuses the call. Reservations count as spent until they
					expire.
				</p>
			</div>

			{notice && (
				<p
					aria-live="polite"
					className={
						notice.kind === "error"
							? "rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
							: "rounded-md border bg-muted px-3 py-2 text-sm text-foreground"
					}
					role={notice.kind === "error" ? "alert" : "status"}
				>
					{notice.message}
				</p>
			)}

			<Card className="rounded-md shadow-none">
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						<IconCoins aria-hidden="true" className="size-5" /> Current budgets
					</CardTitle>
					<CardDescription>What the current window has already committed, provider by provider.</CardDescription>
				</CardHeader>
				<CardContent className="space-y-3">
					{budgets.length === 0 && (
						<p className="text-sm text-muted-foreground">
							No budgets yet — every live provider call is refused until the owner sets one. Fixture runs need no
							budget and spend nothing.
						</p>
					)}
					{budgets.map((budget) => (
						<div className="rounded-md border p-3" key={budget.id}>
							<div className="flex flex-wrap items-center gap-2">
								<span className="text-sm font-medium">{PROVIDER_LABELS[budget.providerId] ?? budget.providerId}</span>
								<Badge variant="outline">{budget.windowKind === "DAY" ? "per day" : "per month"}</Badge>
							</div>
							<p className="mt-2 text-sm text-muted-foreground">
								Calls: {budget.spentCalls} of {budget.ceilingCalls} committed · Cost:{" "}
								{dollars(budget.spentCostMicros)} of {dollars(budget.ceilingCostMicros)}
							</p>
						</div>
					))}
				</CardContent>
			</Card>

			<Card className="rounded-md shadow-none">
				<CardHeader>
					<CardTitle>Set a budget</CardTitle>
					<CardDescription>
						Owner-only, append-only: a new budget supersedes the previous one, and the record of every earlier
						ceiling is kept.
					</CardDescription>
				</CardHeader>
				<CardContent className="grid gap-5 md:grid-cols-2">
					<div className="space-y-2">
						<Label htmlFor="budget-provider">Provider</Label>
						<Select value={providerId} onValueChange={(value: "gemini" | "video-radar") => setProviderId(value)}>
							<SelectTrigger className="min-h-11 w-full" id="budget-provider">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem className="min-h-11" value="video-radar">
									{PROVIDER_LABELS["video-radar"]}
								</SelectItem>
								<SelectItem className="min-h-11" value="gemini">
									{PROVIDER_LABELS.gemini}
								</SelectItem>
							</SelectContent>
						</Select>
					</div>
					<div className="space-y-2">
						<Label htmlFor="budget-window">Window</Label>
						<Select value={windowKind} onValueChange={(value: "DAY" | "MONTH") => setWindowKind(value)}>
							<SelectTrigger className="min-h-11 w-full" id="budget-window">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem className="min-h-11" value="DAY">
									Per day
								</SelectItem>
								<SelectItem className="min-h-11" value="MONTH">
									Per month
								</SelectItem>
							</SelectContent>
						</Select>
					</div>
					<div className="space-y-2">
						<Label htmlFor="budget-calls">Call ceiling</Label>
						<Input
							className="min-h-11"
							id="budget-calls"
							inputMode="numeric"
							onChange={(event) => setCeilingCalls(event.target.value)}
							value={ceilingCalls}
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="budget-cost">Cost ceiling (USD)</Label>
						<Input
							className="min-h-11"
							id="budget-cost"
							inputMode="decimal"
							onChange={(event) => setCeilingDollars(event.target.value)}
							value={ceilingDollars}
						/>
					</div>
					<div className="md:col-span-2">
						{canSet ? (
							<Button className="min-h-11" disabled={pending} onClick={saveBudget} type="button">
								<IconShieldCheck aria-hidden="true" />
								{pending ? "Saving…" : "Record budget as owner"}
							</Button>
						) : (
							<p className="text-xs text-muted-foreground">
								<IconLock aria-hidden="true" className="mr-1 inline size-3" />
								Setting a budget requires an interactive owner session.
							</p>
						)}
					</div>
				</CardContent>
			</Card>

			<p className="text-xs text-muted-foreground">
				Live providers stay off until their own switches are turned on; a budget alone starts nothing. Publishing is
				unavailable in Stage 1.
			</p>
		</div>
	);
}

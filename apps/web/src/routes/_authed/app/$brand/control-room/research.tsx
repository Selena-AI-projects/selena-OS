import { IconDownload, IconFileText, IconSearch, IconShieldCheck, IconX } from "@tabler/icons-react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { Input } from "@workspace/ui/components/input";
import { Label } from "@workspace/ui/components/label";
import { useRef, useState, useTransition } from "react";
import { CONTENT_PRODUCT_NAME } from "@/lib/content-product";
import { decideContentOpportunityFn, getContentResearchFn, runContentResearchFn } from "@/server/content-research";

export const Route = createFileRoute("/_authed/app/$brand/control-room/research")({
	loader: ({ params }) => getContentResearchFn({ data: { brandId: params.brand } }),
	head: () => ({ meta: [{ title: `Research · ${CONTENT_PRODUCT_NAME}` }] }),
	component: ResearchPage,
});

const RUN_STATUS_LABELS: Record<string, string> = {
	COMPLETED: "Completed",
	PARTIAL: "Completed with gaps",
	FAILED: "Did not run",
};

const OUTLIER_BAND_LABELS: Record<string, string> = {
	UNAVAILABLE: "No usable baseline",
	NORMAL: "Within normal range",
	INTERESTING: "Interesting",
	STRONG: "Strong",
	MAJOR: "Major",
	EXCEPTIONAL: "Exceptional",
};

const CONFIDENCE_LABELS: Record<string, string> = {
	HIGH: "High",
	MEDIUM: "Medium",
	LOW: "Low",
	UNAVAILABLE: "Unavailable",
};

const OPPORTUNITY_STATE_LABELS: Record<string, string> = {
	NEW: "Not decided",
	SAVED: "Saved",
	REJECTED: "Rejected",
	SENT_TO_CREATION: "Sent to creation",
};

function formatMoment(value: string): string {
	return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function formatPercent(value: number): string {
	return `${Math.round(value * 100)}%`;
}

function ResearchPage() {
	const { brand: brandId } = Route.useParams();
	const { confirmedProfile, run, sources, opportunities, canDecide } = Route.useLoaderData();
	const router = useRouter();
	const [pending, startTransition] = useTransition();
	const [notice, setNotice] = useState<{ kind: "success" | "error"; message: string } | null>(null);
	const [rejectionReasons, setRejectionReasons] = useState<Record<string, string>>({});
	// Held across renders so a double-submitted import returns the run that
	// already exists instead of forking a second one.
	const importKey = useRef(crypto.randomUUID());
	const liveKey = useRef(crypto.randomUUID());

	function act(action: () => Promise<unknown>, success: string, onDone?: () => void) {
		startTransition(async () => {
			try {
				await action();
				await router.invalidate();
				onDone?.();
				setNotice({ kind: "success", message: success });
			} catch (error) {
				setNotice({
					kind: "error",
					message: error instanceof Error ? error.message : "The request could not be completed",
				});
			}
		});
	}

	function importFixture() {
		act(
			() => runContentResearchFn({ data: { brandId, idempotencyKey: importKey.current } }),
			"Fixture research imported",
			() => {
				importKey.current = crypto.randomUUID();
			},
		);
	}

	function runLive() {
		act(
			async () => {
				const run = await runContentResearchFn({ data: { brandId, idempotencyKey: liveKey.current, live: true } });
				if (run.status === "FAILED") {
					throw new Error("Live run was refused — the run record below names which fuse said no.");
				}
				return run;
			},
			"Live YouTube research completed",
			() => {
				liveKey.current = crypto.randomUUID();
			},
		);
	}

	function decide(opportunityId: string, decision: "SAVED" | "REJECTED" | "SENT_TO_CREATION") {
		const reason = rejectionReasons[opportunityId]?.trim();
		if (decision === "REJECTED" && !reason) {
			setNotice({ kind: "error", message: "Add a reason before rejecting an opportunity." });
			return;
		}
		act(
			() => decideContentOpportunityFn({ data: { brandId, opportunityId, decision, reason } }),
			decision === "REJECTED" ? "Opportunity rejected" : "Opportunity decision recorded",
		);
	}

	return (
		<div className="flex flex-col gap-6 p-4 md:p-6">
			<header className="flex flex-col gap-2">
				<h1 className="font-serif text-2xl">Research</h1>
				<p className="max-w-2xl text-muted-foreground text-sm">
					Import deterministic research for this project and decide which opportunities are worth creating. Research is
					scored against the confirmed project profile, and every opportunity carries the evidence that justified it.
				</p>
			</header>

			{notice && (
				<p
					role="status"
					className={`rounded-md border px-3 py-2 text-sm ${
						notice.kind === "success"
							? "border-emerald-200 bg-emerald-50 text-emerald-900"
							: "border-red-200 bg-red-50 text-red-900"
					}`}
				>
					{notice.message}
				</p>
			)}

			{!confirmedProfile ? (
				<Card>
					<CardHeader>
						<CardTitle>Confirm a project profile first</CardTitle>
						<CardDescription>
							Research is scored against a confirmed profile, so it cannot start without one. Nothing is fetched or
							spent until a profile is confirmed.
						</CardDescription>
					</CardHeader>
					<CardContent>
						<Button asChild className="min-h-11" variant="outline">
							<a href={`/app/${brandId}/control-room/profile`}>Go to Set up</a>
						</Button>
					</CardContent>
				</Card>
			) : (
				<Card>
					<CardHeader>
						<CardTitle>Import research</CardTitle>
						<CardDescription>
							Fixture import spends nothing. A live YouTube run must pass every fuse — the live switches, the
							credential, and the budget you set on the Budgets screen — and every request it makes is written to the
							ledger.
						</CardDescription>
					</CardHeader>
					<CardContent className="flex flex-col gap-3">
						<p className="text-muted-foreground text-sm">
							Scored against confirmed profile version {confirmedProfile.version} (
							<span className="font-mono">{confirmedProfile.profileHash.slice(0, 12)}…</span>)
						</p>
						{canDecide ? (
							<div className="flex flex-wrap gap-2">
								<Button className="min-h-11" type="button" disabled={pending} onClick={importFixture}>
									<IconDownload aria-hidden="true" /> Import fixture research
								</Button>
								<Button className="min-h-11" type="button" disabled={pending} onClick={runLive} variant="outline">
									<IconDownload aria-hidden="true" /> Run live YouTube research
								</Button>
							</div>
						) : (
							// A viewer's import would always be refused server-side, so the
							// control says why instead of offering an action that cannot work.
							<p className="text-muted-foreground text-sm">Importing research needs edit access to this project.</p>
						)}
					</CardContent>
				</Card>
			)}

			{run && (
				<Card>
					<CardHeader>
						<CardTitle>Latest run</CardTitle>
						<CardDescription>
							{RUN_STATUS_LABELS[run.status] ?? run.status} · started {formatMoment(run.startedAt)}
						</CardDescription>
					</CardHeader>
					<CardContent className="flex flex-col gap-2 text-sm">
						<div className="flex flex-wrap items-center gap-2">
							<Badge variant="outline">{RUN_STATUS_LABELS[run.status] ?? run.status}</Badge>
							<Badge variant="outline">{run.adapterId === "fixture" ? "Fixture import" : "Live provider"}</Badge>
							<Badge variant="outline">No provider calls: {run.externalProviderCalls}</Badge>
						</div>
						<p className="text-muted-foreground">
							Profile version {run.profileVersion ?? "unknown"} ·{" "}
							<span className="font-mono">{run.profileHash.slice(0, 12)}…</span>
							{run.profileStillConfirmed ? "" : " · this profile version is no longer the confirmed one"}
						</p>
						<p className="text-muted-foreground">
							Scoring {run.scoringVersion} · baseline {run.baselineVersion}
						</p>
					</CardContent>
				</Card>
			)}

			{sources.length > 0 && (
				<Card>
					<CardHeader>
						<CardTitle>Sources</CardTitle>
						<CardDescription>
							Each source keeps its capture time and the reasons it did or did not clear the quality gate.
						</CardDescription>
					</CardHeader>
					<CardContent className="flex flex-col gap-4">
						{sources.map((source) => (
							<div key={source.id} className="flex flex-col gap-2 rounded-md border p-3">
								<div className="flex flex-wrap items-center gap-2">
									<span className="font-medium">{source.title}</span>
									{source.shortlisted ? <Badge>Shortlisted</Badge> : <Badge variant="outline">Not shortlisted</Badge>}
								</div>
								<p className="text-muted-foreground text-sm">
									{source.channelName} · published {formatMoment(source.publishedAt)} · captured{" "}
									{formatMoment(source.capturedAt)}
								</p>
								<div className="flex flex-wrap gap-2 text-sm">
									<Badge variant="outline">
										{OUTLIER_BAND_LABELS[source.outlierBand] ?? source.outlierBand}
										{typeof source.outlierRatio === "number" ? ` · ${source.outlierRatio.toFixed(1)}x` : ""}
									</Badge>
									<Badge variant="outline">
										Baseline {CONFIDENCE_LABELS[source.baselineConfidence] ?? source.baselineConfidence} ·{" "}
										{source.baselineSampleSize} comparable
									</Badge>
									<Badge variant="outline">Relevance {formatPercent(source.relevanceScore)}</Badge>
									<Badge variant="outline">
										Score {formatPercent(source.candidateScore)} · {formatPercent(source.weightCoverage)} of signals
										available
									</Badge>
									<Badge variant="outline">
										{source.transcriptStatus === "AVAILABLE" ? "Transcript available" : "Transcript unavailable"}
									</Badge>
								</div>
								{source.gateReasons.length > 0 && (
									<ul className="list-disc pl-5 text-muted-foreground text-sm">
										{source.gateReasons.map((reason) => (
											<li key={reason}>{reason}</li>
										))}
									</ul>
								)}
								<a
									className="w-fit text-sm underline underline-offset-4"
									href={source.sourceUrl}
									rel="noreferrer noopener"
									target="_blank"
								>
									Open source ↗
								</a>
							</div>
						))}
					</CardContent>
				</Card>
			)}

			{opportunities.length > 0 && (
				<Card>
					<CardHeader>
						<CardTitle>Opportunities</CardTitle>
						<CardDescription>
							Saving an opportunity records a decision; it never edits or replaces an earlier one.
						</CardDescription>
					</CardHeader>
					<CardContent className="flex flex-col gap-4">
						{opportunities.map((opportunity) => (
							<div key={opportunity.id} className="flex flex-col gap-3 rounded-md border p-3">
								<div className="flex flex-wrap items-center gap-2">
									<span className="font-medium">{opportunity.proposedHook}</span>
									<Badge variant="outline">{OPPORTUNITY_STATE_LABELS[opportunity.state] ?? opportunity.state}</Badge>
									<Badge variant="outline">
										Confidence {CONFIDENCE_LABELS[opportunity.confidence] ?? opportunity.confidence}
									</Badge>
								</div>
								<p className="text-sm">{opportunity.proposedAngle}</p>
								<p className="flex items-start gap-2 text-muted-foreground text-sm">
									<IconShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
									{opportunity.evidenceSummary}
								</p>
								{opportunity.factRequirements.length > 0 && (
									<div className="flex flex-col gap-1 text-sm">
										<span className="flex items-center gap-2 text-muted-foreground">
											<IconFileText className="size-4 shrink-0" aria-hidden="true" /> Needs confirmed facts before this
											becomes a claim
										</span>
										<ul className="list-disc pl-5 text-muted-foreground">
											{opportunity.factRequirements.map((requirement) => (
												<li key={requirement}>{requirement}</li>
											))}
										</ul>
									</div>
								)}
								{canDecide && (
									<div className="flex flex-col gap-2">
										<Label className="text-sm" htmlFor={`reason-${opportunity.id}`}>
											Reason (required to reject)
										</Label>
										<Input
											className="min-h-11"
											id={`reason-${opportunity.id}`}
											placeholder="Why this does not fit"
											value={rejectionReasons[opportunity.id] ?? ""}
											onChange={(event) =>
												setRejectionReasons((current) => ({ ...current, [opportunity.id]: event.target.value }))
											}
										/>
										<div className="flex flex-wrap gap-2">
											<Button
												className="min-h-11"
												type="button"
												disabled={pending}
												onClick={() => decide(opportunity.id, "SAVED")}
											>
												<IconSearch aria-hidden="true" /> Save
											</Button>
											<Button
												className="min-h-11"
												type="button"
												variant="outline"
												disabled={pending}
												onClick={() => decide(opportunity.id, "SENT_TO_CREATION")}
											>
												Send to creation
											</Button>
											<Button
												className="min-h-11"
												type="button"
												variant="outline"
												disabled={pending}
												onClick={() => decide(opportunity.id, "REJECTED")}
											>
												<IconX aria-hidden="true" /> Reject
											</Button>
										</div>
									</div>
								)}
							</div>
						))}
					</CardContent>
				</Card>
			)}

			<Card className="rounded-md border-dashed shadow-none">
				<CardContent className="flex items-start gap-3 pt-6 text-muted-foreground text-sm">
					<IconShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
					<p>
						Research runs from fixtures only. No external provider is contacted, nothing is charged, and an unavailable
						transcript is recorded as unavailable rather than replaced with text.
					</p>
				</CardContent>
			</Card>
		</div>
	);
}

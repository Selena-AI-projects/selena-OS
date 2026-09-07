import { IconBulb, IconCheck, IconSparkles } from "@tabler/icons-react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { useState, useTransition } from "react";
import { useIdempotencyKeys } from "@/hooks/use-idempotency-keys";
import { CONTENT_PRODUCT_NAME } from "@/lib/content-product";
import { generateContentIdeasFn, getContentCreationFn, selectContentIdeaFn } from "@/server/content-creation";
import { getContentResearchFn } from "@/server/content-research";

export const Route = createFileRoute("/_authed/app/$brand/control-room/ideas")({
	loader: async ({ params }) => {
		const [creation, research] = await Promise.all([
			getContentCreationFn({ data: { brandId: params.brand } }),
			getContentResearchFn({ data: { brandId: params.brand } }),
		]);
		return { creation, research };
	},
	head: () => ({ meta: [{ title: `Ideas · ${CONTENT_PRODUCT_NAME}` }] }),
	component: IdeasPage,
});

const EVIDENCE_CLASS_LABELS: Record<string, string> = {
	OBSERVED: "Observed in the research",
	INFERRED: "Inferred",
	REQUIRES_STUDIO: "Still to be verified",
};

const FORMAT_LABELS: Record<string, string> = {
	SHORT: "Short",
	LONG_FORM: "Long-form",
	TUTORIAL: "Tutorial",
	REVIEW: "Review",
	VLOG: "Vlog",
};

const RUN_STATUS_LABELS: Record<string, string> = {
	COMPLETED: "Completed",
	FAILED: "Did not run",
};

function IdeasPage() {
	const { brand: brandId } = Route.useParams();
	const { creation, research } = Route.useLoaderData();
	const router = useRouter();
	const [pending, startTransition] = useTransition();
	const [notice, setNotice] = useState<{ kind: "success" | "error"; message: string } | null>(null);
	const generationKeys = useIdempotencyKeys();

	const savedOpportunities = research.opportunities.filter(
		(opportunity) => opportunity.state === "SAVED" || opportunity.state === "SENT_TO_CREATION",
	);
	// Keyed by the run and the position within it, which is what a selection
	// actually records. Two ideas may carry the same title, and a draft's title is
	// editable afterwards.
	const selectedIdeas = new Set(
		creation.items
			.filter((item) => item.ideaGenerationRunId !== null && item.selectedIdeaIndex !== null)
			.map((item) => `${item.ideaGenerationRunId}:${item.selectedIdeaIndex}`),
	);

	/**
	 * A refused generation resolves with a FAILED result rather than throwing, so
	 * that its record survives the transaction. Treating "it resolved" as success
	 * would report six ideas that were never written. Selecting an idea has no
	 * such result — it reports failure by throwing — so the status is read only
	 * where there is one.
	 */
	function act(action: () => Promise<object>, success: string, onDone?: () => void) {
		startTransition(async () => {
			try {
				const result = await action();
				await router.invalidate();
				onDone?.();
				if ("status" in result && result.status === "FAILED") {
					const code = "errorCode" in result ? result.errorCode : null;
					setNotice({ kind: "error", message: `Generation did not produce ideas (${code ?? "unknown reason"})` });
					return;
				}
				setNotice({ kind: "success", message: success });
			} catch (error) {
				setNotice({
					kind: "error",
					message: error instanceof Error ? error.message : "The request could not be completed",
				});
			}
		});
	}

	return (
		<div className="flex flex-col gap-6 p-4 md:p-6">
			<header className="flex flex-col gap-2">
				<h1 className="font-serif text-2xl">Ideas</h1>
				<p className="max-w-2xl text-muted-foreground text-sm">
					Six ideas from one saved opportunity, each carrying the research evidence behind it. Selecting one creates a
					draft; the other five stay on the run, so the choice remains reviewable. Nothing is fetched or charged.
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

			{!creation.confirmedProfile ? (
				<Card>
					<CardHeader>
						<CardTitle>Confirm a project profile first</CardTitle>
						<CardDescription>
							Ideas are generated against a confirmed profile, so they cannot start without one.
						</CardDescription>
					</CardHeader>
					<CardContent>
						<Button asChild className="min-h-11" variant="outline">
							<a href={`/app/${brandId}/control-room/profile`}>Go to Set up</a>
						</Button>
					</CardContent>
				</Card>
			) : savedOpportunities.length === 0 ? (
				<Card>
					<CardHeader>
						<CardTitle>Save an opportunity first</CardTitle>
						<CardDescription>
							Creation starts from an opportunity you decided to keep, not from every one the research proposed.
						</CardDescription>
					</CardHeader>
					<CardContent>
						<Button asChild className="min-h-11" variant="outline">
							<a href={`/app/${brandId}/control-room/research`}>Go to Research</a>
						</Button>
					</CardContent>
				</Card>
			) : (
				<Card>
					<CardHeader>
						<CardTitle>Generate ideas</CardTitle>
						<CardDescription>
							Fixture generation only. No external provider is contacted and nothing is charged.
						</CardDescription>
					</CardHeader>
					<CardContent className="flex flex-col gap-3">
						{savedOpportunities.map((opportunity) => (
							<div
								key={opportunity.id}
								className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
							>
								<div className="min-w-0">
									<p className="font-medium text-sm">{opportunity.proposedAngle}</p>
									<p className="break-words text-muted-foreground text-sm">{opportunity.evidenceSummary}</p>
								</div>
								{creation.canDecide ? (
									<Button
										className="min-h-11 shrink-0"
										type="button"
										disabled={pending}
										onClick={() =>
											act(
												() =>
													generateContentIdeasFn({
														data: {
															brandId,
															opportunityId: opportunity.id,
															idempotencyKey: generationKeys.keyFor(opportunity.id),
														},
													}),
												"Ideas generated",
												() => {
													generationKeys.rotate(opportunity.id);
												},
											)
										}
									>
										<IconSparkles aria-hidden="true" /> Generate six ideas
									</Button>
								) : (
									// A viewer's generation would always be refused server-side, so
									// the control says why instead of offering an action that
									// cannot work.
									<p className="text-muted-foreground text-sm">Generating ideas needs edit access.</p>
								)}
							</div>
						))}
					</CardContent>
				</Card>
			)}

			{creation.ideaRun && (
				<Card>
					<CardHeader>
						<CardTitle>Latest idea run</CardTitle>
						<CardDescription>
							{RUN_STATUS_LABELS[creation.ideaRun.status] ?? creation.ideaRun.status} ·{" "}
							{creation.ideaRun.adapterId === "fixture" ? "Fixture generation" : "Live provider"}
						</CardDescription>
					</CardHeader>
					<CardContent className="flex flex-wrap items-center gap-2 text-sm">
						<Badge variant="outline">Provider calls: {creation.ideaRun.actualCallCount}</Badge>
						<Badge variant="outline">Schema {creation.ideaRun.schemaVersion}</Badge>
						{creation.ideaRun.errorCode && <Badge variant="destructive">{creation.ideaRun.errorCode}</Badge>}
					</CardContent>
				</Card>
			)}

			{creation.ideas.length > 0 && (
				<section className="flex flex-col gap-3">
					<h2 className="font-serif text-xl">The six ideas</h2>
					{creation.ideas.map((idea, index) => {
						const alreadySelected = selectedIdeas.has(`${creation.ideaRun?.id}:${index}`);
						return (
							// biome-ignore lint/suspicious/noArrayIndexKey: the position in the run is the idea's identity — it is what a selection records and what the server resolves evidence by — and a run is stored immutable output that is never reordered or filtered.
							<Card key={`${creation.ideaRun?.id}-${index}`}>
								<CardHeader>
									<CardTitle className="flex flex-wrap items-center gap-2 text-base">
										<IconBulb aria-hidden="true" className="size-4 shrink-0" />
										<span className="break-words">{idea.title}</span>
									</CardTitle>
									<CardDescription className="break-words">{idea.description}</CardDescription>
								</CardHeader>
								<CardContent className="flex flex-col gap-3 text-sm">
									<div className="flex flex-wrap gap-2">
										<Badge variant="outline">{FORMAT_LABELS[idea.format] ?? idea.format}</Badge>
										<Badge variant="outline">{idea.difficulty}</Badge>
									</div>
									<p className="break-words text-muted-foreground">{idea.honestPromise}</p>
									<div className="flex flex-col gap-1">
										<p className="font-medium">Evidence</p>
										{idea.evidenceClaims.map((claim) => (
											<p key={claim.id} className="break-words text-muted-foreground">
												{claim.claim}{" "}
												<span className="whitespace-nowrap">
													({EVIDENCE_CLASS_LABELS[claim.evidenceClass] ?? claim.evidenceClass})
												</span>
											</p>
										))}
									</div>
									{alreadySelected ? (
										<p className="flex items-center gap-2 text-muted-foreground">
											<IconCheck aria-hidden="true" className="size-4" /> Already selected
										</p>
									) : (
										creation.canDecide &&
										creation.ideaRun?.status === "COMPLETED" && (
											<div>
												<Button
													className="min-h-11"
													type="button"
													variant="outline"
													disabled={pending}
													onClick={() =>
														act(
															() =>
																selectContentIdeaFn({
																	data: {
																		brandId,
																		generationRunId: creation.ideaRun?.id ?? "",
																		ideaIndex: index,
																	},
																}),
															"Draft created from this idea",
														)
													}
												>
													Select this idea
												</Button>
											</div>
										)
									)}
								</CardContent>
							</Card>
						);
					})}
				</section>
			)}
		</div>
	);
}

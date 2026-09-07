import { IconAlertTriangle, IconArrowBackUp, IconLock, IconSend, IconShieldCheck } from "@tabler/icons-react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { Textarea } from "@workspace/ui/components/textarea";
import { useState, useTransition } from "react";
import { CONTENT_PRODUCT_NAME } from "@/lib/content-product";
import {
	decideContentReviewFn,
	getContentReviewFn,
	revokeContentApprovalFn,
	submitContentForReviewFn,
} from "@/server/content-review";

export const Route = createFileRoute("/_authed/app/$brand/control-room/review")({
	loader: ({ params }) => getContentReviewFn({ data: { brandId: params.brand } }),
	head: () => ({ meta: [{ title: `Editorial review · ${CONTENT_PRODUCT_NAME}` }] }),
	component: ReviewPage,
});

const BLOCKER_LABELS: Record<string, string> = {
	NO_PROFILE_LINEAGE: "This version does not name the profile it was written against",
	EVIDENCE_REQUIRED: "The brand's policy requires evidence and this version carries none",
	ASSET_NOT_CLEAN: "An image on this version has not been scanned clean",
	ASSET_OUT_OF_VERSION: "An image belongs to a different version",
	ASSET_RIGHTS_EXPIRED: "The rights recorded for an image have run out",
	ASSET_CONSENT_EXPIRED: "The consent recorded for an image has run out",
};

const DECISION_LABELS: Record<string, string> = {
	APPROVED: "Approved",
	CHANGES_REQUESTED: "Changes requested",
	REJECTED: "Rejected",
	REVOKED: "Approval taken back",
};

function formatMoment(value: string): string {
	return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function ReviewPage() {
	const { brand: brandId } = Route.useParams();
	const { versions, canDecide, releases } = Route.useLoaderData();
	const router = useRouter();
	const [pending, startTransition] = useTransition();
	const [notice, setNotice] = useState<{ kind: "success" | "error"; message: string } | null>(null);
	const [reasons, setReasons] = useState<Record<string, string>>({});

	function act(action: () => Promise<unknown>, success: string) {
		startTransition(async () => {
			try {
				await action();
				await router.invalidate();
				setNotice({ kind: "success", message: success });
			} catch (error) {
				setNotice({
					kind: "error",
					message: error instanceof Error ? error.message : "The decision could not be recorded",
				});
			}
		});
	}

	return (
		<div className="flex flex-col gap-6 p-4 md:p-6">
			<header className="flex flex-col gap-2">
				<h1 className="font-serif text-2xl">Editorial review</h1>
				<p className="max-w-2xl text-muted-foreground text-sm">
					A decision is bound to the exact content, profile, evidence and image bundle a reviewer was shown. If any of
					them changes afterwards, the approval stops describing the version and this page says so.
				</p>
			</header>

			{/* Editorial readiness is not release readiness, and the page states the
			    difference rather than leaving the two adjacent and unexplained. */}
			<Card className="border-dashed">
				<CardHeader>
					<CardTitle className="flex items-center gap-2 text-base">
						<IconLock aria-hidden="true" className="size-4" /> Releases
					</CardTitle>
					<CardDescription>{releases.reason}</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-wrap gap-2 text-sm">
					<Badge variant="outline">Read-only</Badge>
					<Badge variant="outline">YouTube release unavailable</Badge>
				</CardContent>
			</Card>

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

			{versions.length === 0 ? (
				<Card>
					<CardHeader>
						<CardTitle>Nothing to review yet</CardTitle>
						<CardDescription>A version reaches review once a script has been written for a draft.</CardDescription>
					</CardHeader>
					<CardContent>
						<Button asChild className="min-h-11" variant="outline">
							<a href={`/app/${brandId}/control-room/scripts`}>Go to Scripts</a>
						</Button>
					</CardContent>
				</Card>
			) : (
				versions.map((entry) => {
					const reason = reasons[entry.versionId] ?? "";
					const decidable = entry.blockers.length === 0;
					return (
						<Card key={entry.versionId}>
							<CardHeader>
								<CardTitle className="flex flex-wrap items-center gap-2 text-base">
									<IconShieldCheck aria-hidden="true" className="size-4 shrink-0" />
									<span className="break-words">{entry.title}</span>
								</CardTitle>
								<CardDescription className="flex flex-wrap items-center gap-2">
									<Badge variant="outline">v{entry.version}</Badge>
									{entry.standingDecision && (
										<Badge variant={entry.standingDecision === "APPROVED" ? "default" : "outline"}>
											{DECISION_LABELS[entry.standingDecision] ?? entry.standingDecision}
										</Badge>
									)}
									{entry.approvalStale && <Badge variant="destructive">Approval is stale</Badge>}
									{entry.submittedAt && <span className="text-xs">submitted {formatMoment(entry.submittedAt)}</span>}
								</CardDescription>
							</CardHeader>
							<CardContent className="flex flex-col gap-4 text-sm">
								{entry.approvalStale && (
									<p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-900">
										This version changed after it was approved. The approval still stands as a record of what was read,
										but it no longer describes what is stored now.
									</p>
								)}

								{entry.blockers.length > 0 && (
									<div className="flex flex-col gap-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
										<p className="flex items-center gap-2 font-medium">
											<IconAlertTriangle aria-hidden="true" className="size-4" /> Cannot be approved yet
										</p>
										{entry.blockers.map((blocker) => (
											<p key={blocker}>{BLOCKER_LABELS[blocker] ?? blocker}</p>
										))}
									</div>
								)}

								<div className="flex flex-col gap-1">
									<p className="font-medium">What a decision would be bound to</p>
									<dl className="grid gap-1 text-muted-foreground text-xs">
										<div className="flex flex-wrap gap-2">
											<dt className="w-28">Content</dt>
											<dd className="break-all font-mono">{entry.binding.contentHash}</dd>
										</div>
										<div className="flex flex-wrap gap-2">
											<dt className="w-28">Profile</dt>
											<dd className="break-all font-mono">{entry.binding.profileHash || "none recorded"}</dd>
										</div>
										<div className="flex flex-wrap gap-2">
											<dt className="w-28">Evidence</dt>
											<dd className="break-all font-mono">{entry.binding.evidenceHash}</dd>
										</div>
										<div className="flex flex-wrap gap-2">
											<dt className="w-28">Image bundle</dt>
											<dd className="break-all font-mono">{entry.binding.assetBundleHash}</dd>
										</div>
									</dl>
									<p className="text-muted-foreground text-xs">
										{entry.evidenceClaimCount === 1 ? "1 evidence claim" : `${entry.evidenceClaimCount} evidence claims`}
										{entry.requireEvidence ? " · evidence required by this brand's policy" : ""} ·{" "}
										{entry.bundleMembers.length === 1
											? "1 scanned-clean image"
											: `${entry.bundleMembers.length} scanned-clean images`}
									</p>
								</div>

								<div className="flex flex-col gap-2">
									<label className="font-medium" htmlFor={`reason-${entry.versionId}`}>
										Reason
									</label>
									<Textarea
										id={`reason-${entry.versionId}`}
										value={reason}
										placeholder="Required for anything other than an approval, and for taking one back."
										onChange={(event) => setReasons((current) => ({ ...current, [entry.versionId]: event.target.value }))}
									/>
								</div>

								<div className="flex flex-wrap gap-2">
									<Button
										className="min-h-11"
										type="button"
										variant="outline"
										disabled={pending || !decidable}
										onClick={() =>
											act(
												() =>
													submitContentForReviewFn({
														data: { brandId, contentVersionId: entry.versionId },
													}),
												"Handed to a reviewer",
											)
										}
									>
										<IconSend aria-hidden="true" /> Submit for review
									</Button>

									{canDecide && (
										<>
											<Button
												className="min-h-11"
												type="button"
												disabled={pending || !decidable || entry.standingDecision === "APPROVED"}
												onClick={() =>
													act(
														() =>
															decideContentReviewFn({
																data: {
																	brandId,
																	contentVersionId: entry.versionId,
																	decision: "APPROVED",
																	reason: reason.trim() || null,
																	binding: entry.binding,
																},
															}),
														"Approved, bound to the hashes shown here",
													)
												}
											>
												<IconShieldCheck aria-hidden="true" /> Approve
											</Button>
											<Button
												className="min-h-11"
												type="button"
												variant="outline"
												disabled={pending || !reason.trim()}
												onClick={() =>
													act(
														() =>
															decideContentReviewFn({
																data: {
																	brandId,
																	contentVersionId: entry.versionId,
																	decision: "CHANGES_REQUESTED",
																	reason: reason.trim(),
																	binding: entry.binding,
																},
															}),
														"Changes requested",
													)
												}
											>
												Request changes
											</Button>
											<Button
												className="min-h-11"
												type="button"
												variant="outline"
												disabled={pending || !reason.trim() || entry.standingDecision !== "APPROVED"}
												onClick={() =>
													act(
														() =>
															revokeContentApprovalFn({
																data: { brandId, contentVersionId: entry.versionId, reason: reason.trim() },
															}),
														"Approval taken back; the record of it stays",
													)
												}
											>
												<IconArrowBackUp aria-hidden="true" /> Take the approval back
											</Button>
										</>
									)}
								</div>

								{entry.decisions.length > 0 && (
									<div className="flex flex-col gap-2">
										<p className="font-medium">Decision history</p>
										{entry.decisions.map((decision) => (
											<div
												key={decision.id}
												className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs"
											>
												<Badge variant="outline">{DECISION_LABELS[decision.decision] ?? decision.decision}</Badge>
												<span className="font-mono">{decision.contentHash.slice(0, 12)}…</span>
												<span>{formatMoment(decision.createdAt)}</span>
												{decision.reason && <span className="break-words">{decision.reason}</span>}
											</div>
										))}
									</div>
								)}
							</CardContent>
						</Card>
					);
				})
			)}
		</div>
	);
}

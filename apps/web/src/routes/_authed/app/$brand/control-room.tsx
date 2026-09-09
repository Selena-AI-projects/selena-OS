import { IconAlertTriangle, IconFileText, IconLockCheck, IconPlus, IconRefresh } from "@tabler/icons-react";
import { createFileRoute, Outlet, useChildMatches, useLocation, useRouter } from "@tanstack/react-router";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { Input } from "@workspace/ui/components/input";
import { Label } from "@workspace/ui/components/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workspace/ui/components/table";
import { Textarea } from "@workspace/ui/components/textarea";
import { type FormEvent, useEffect, useState, useTransition } from "react";
import { CONTENT_PRODUCT_DESCRIPTION, CONTENT_PRODUCT_NAME } from "@/lib/content-product";
import { buildTitle, getAppName, getBrandName } from "@/lib/route-head";
import { resolveBoundEnvironment } from "@/lib/selena-channel-binding";
import { revokeContentPolicyFn, setContentPolicyFn } from "@/server/selena-content-policy";
import {
	addReviewEvidenceFn,
	approveContentVersionFn,
	cancelReleaseIntentFn,
	confirmChannelBindingFn,
	createContentVersionFn,
	createControlRoomContentFn,
	getControlRoomWorkspaceFn,
	getReleaseProviderStatusFn,
	queueReleaseIntentFn,
	revokeApprovalFn,
	revokeChannelBindingFn,
	setReleaseKillSwitchFn,
} from "@/server/selena-control-room";
import {
	confirmGrowthBindingFn,
	GROWTH_SOURCE_ENVIRONMENTS,
	revokeGrowthBindingFn,
} from "@/server/selena-growth-bindings";

export const Route = createFileRoute("/_authed/app/$brand/control-room")({
	loader: ({ params }) => getControlRoomWorkspaceFn({ data: { brandId: params.brand } }),
	head: ({ matches, match }) => {
		const appName = getAppName(match);
		const brandName = getBrandName(matches);
		return {
			meta: [
				{ title: buildTitle(CONTENT_PRODUCT_NAME, { appName, brandName }) },
				{ name: "description", content: CONTENT_PRODUCT_DESCRIPTION },
			],
		};
	},
	errorComponent: ({ error, reset }) => <ControlRoomLoadError error={error} reset={reset} />,
	component: ControlRoomPage,
});

const CONTROL_ROOM_SECTIONS = [
	"inbox",
	"content",
	"review",
	"releases",
	"publications",
	"performance",
	"incidents",
	"audit",
	"sources",
] as const;

type ControlRoomSection = (typeof CONTROL_ROOM_SECTIONS)[number];

type ReleaseProviderStatus = Awaited<ReturnType<typeof getReleaseProviderStatusFn>>;

function isControlRoomSection(value: string): value is ControlRoomSection {
	return CONTROL_ROOM_SECTIONS.some((section) => section === value);
}

function sectionFromHash(hash: string): ControlRoomSection {
	const section = hash.replace(/^#/, "");
	return isControlRoomSection(section) ? section : "inbox";
}

function ControlRoomLoadError({ error, reset }: { error: unknown; reset: () => void }) {
	const message = error instanceof Error ? error.message : "";
	const correlationId = message.match(/Reference:\s*([0-9a-f-]{36})/i)?.[1] ?? "unavailable";

	return (
		<div className="mx-auto flex min-h-[40vh] w-full max-w-xl items-center">
			<Card className="w-full rounded-md shadow-none">
				<CardHeader>
					<div className="flex items-center gap-2 text-destructive">
						<IconAlertTriangle aria-hidden="true" />
						<CardTitle className="text-base">{CONTENT_PRODUCT_NAME} is temporarily unavailable</CardTitle>
					</div>
				</CardHeader>
				<CardContent className="space-y-4 text-sm text-muted-foreground">
					<p>
						No content was changed or released. Retry the request; if it continues, provide this reference to support.
					</p>
					<p className="font-mono text-xs text-foreground">Reference: {correlationId}</p>
					<Button onClick={reset} type="button">
						<IconRefresh />
						Retry
					</Button>
				</CardContent>
			</Card>
		</div>
	);
}

function formatDate(value: Date | string | null | undefined): string {
	if (!value) return "-";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "-";
	return date.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
}

function localDateTimeValue(date: Date): string {
	const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
	return local.toISOString().slice(0, 16);
}

function StatusBadge({ value }: { value: string | null }) {
	if (!value) return <Badge variant="outline">Pending</Badge>;
	const label =
		(
			{
				APPROVED: "Approved",
				ACCEPTED: "Scheduled",
				AMBIGUOUS: "Needs confirmation",
				BLOCKED: "Stopped",
				CANCELLED: "Cancelled",
				CANCEL_REQUESTED: "Cancellation requested",
				COMPLETE: "Complete",
				CLEAN: "Ready to use",
				CONFIRMED: "Confirmed",
				DEAD_LETTER: "Needs attention",
				DEFINITIVE_FAILURE: "Not sent",
				DRY_RUN: "Test only",
				FAILED: "Needs attention",
				LEASED: "Working",
				MANUAL_REVIEW: "Needs review",
				OPEN: "Open",
				PENDING: "Waiting safely",
				QUARANTINED: "Needs attention",
				QUEUED: "Queued",
				READY: "Ready",
				RECONCILE_REQUIRED: "Needs review",
				RECONCILIATION_REQUIRED: "Needs confirmation",
				REJECTED: "Not approved",
				RESERVED: "Preparing",
				REVOKED: "Revoked",
				SCANNING: "Safety check in progress",
				SUCCEEDED: "Scheduled",
				UNKNOWN: "Needs confirmation",
			} as Record<string, string>
		)[value] ?? value.replaceAll("_", " ");
	const tone =
		value === "APPROVED" ||
		value === "READY" ||
		value === "CONFIRMED" ||
		value === "COMPLETE" ||
		value === "CLEAN" ||
		value === "ACCEPTED" ||
		value === "SUCCEEDED"
			? "border-emerald-300 bg-emerald-50 text-emerald-800"
			: value === "REJECTED" ||
					value === "REVOKED" ||
					value === "FAILED" ||
					value === "BLOCKED" ||
					value === "CANCELLED"
				? "border-rose-300 bg-rose-50 text-rose-800"
				: value === "QUARANTINED" ||
						value === "RECONCILE_REQUIRED" ||
						value === "RECONCILIATION_REQUIRED" ||
						value === "AMBIGUOUS" ||
						value === "MANUAL_REVIEW" ||
						value === "CANCEL_REQUESTED" ||
						value === "OPEN"
					? "border-amber-300 bg-amber-50 text-amber-800"
					: "border-border bg-muted text-muted-foreground";
	return (
		<Badge variant="outline" className={tone}>
			{label}
		</Badge>
	);
}

function displayChannel(account: { platform: string; providerAccountRef: string }): string {
	if (account.platform === "linkedin_page_dry_run") return "LinkedIn test — nothing will be published";
	if (account.platform === "linkedin_page") return account.providerAccountRef || "LinkedIn Page";
	return account.providerAccountRef || account.platform.replaceAll("_", " ");
}

function displayAuditAction(action: string): string {
	const labels: Record<string, string> = {
		"approval.granted": "Material approved",
		"approval.revoked": "Approval revoked",
		"staging.demo_content_created": "Test material created",
		"staging.linkedin_dry_run_prepared": "LinkedIn test prepared",
		"content.version_created": "Material updated",
		"content.editorial_approved": "Editorially approved",
		"content.editorial_changes_requested": "Editorial changes requested",
		"content.editorial_rejected": "Editorially rejected",
		"release.intent_queued": "Release queued",
		"release.kill_switch_enabled": "Publishing stopped",
	};
	return labels[action] ?? "Control Room activity";
}

function claimsToText(claims: unknown): string {
	if (!Array.isArray(claims)) return "";
	return claims.filter((claim): claim is string => typeof claim === "string").join("\n");
}

function parseClaims(value: string): string[] {
	return value
		.split("\n")
		.map((claim) => claim.trim())
		.filter(Boolean);
}

function EmptyRows({ columns, label }: { columns: number; label: string }) {
	return (
		<TableRow>
			<TableCell colSpan={columns} className="h-28 text-center text-muted-foreground">
				{label}
			</TableCell>
		</TableRow>
	);
}

function displayMaterialKind(kind: string): string {
	return (
		(
			{
				ARTICLE: "Article",
				SOCIAL_ADAPTATION: "Social adaptation",
				BRIEF: "Brief",
				PAGE_UPDATE: "Page update",
				VIDEO_SCRIPT: "Video script",
			} as Record<string, string>
		)[kind] ?? kind
	);
}

function ControlRoomPage() {
	const { brand: brandId } = Route.useParams();
	const data = Route.useLoaderData();
	const { clientConfig } = Route.useRouteContext();
	const router = useRouter();
	const { hash } = useLocation();
	const activeSection = sectionFromHash(hash);
	// Content OS grows through child routes, so this screen steps aside for any
	// of them rather than naming each one.
	const hasChildRoute = useChildMatches().length > 0;
	const [pending, startTransition] = useTransition();
	const [notice, setNotice] = useState<string | null>(null);
	const [contentTitle, setContentTitle] = useState("");
	const [contentBody, setContentBody] = useState("");
	const [contentCta, setContentCta] = useState("");
	const [contentClaims, setContentClaims] = useState("");
	const contentPolicy = "selena-brand-pack/v1";
	const [approvalVersionId, setApprovalVersionId] = useState("");
	const [approvalAccountId, setApprovalAccountId] = useState("");
	const [approvalExpiry, setApprovalExpiry] = useState("");
	const [reviewEvidenceVersionId, setReviewEvidenceVersionId] = useState("");
	const [reviewEvidenceSource, setReviewEvidenceSource] = useState("");
	const [reviewEvidenceExpiry, setReviewEvidenceExpiry] = useState("");
	const [releaseApprovalId, setReleaseApprovalId] = useState("");
	const [releaseNotBefore, setReleaseNotBefore] = useState("");
	const [releaseTimezone, setReleaseTimezone] = useState("");
	const [revisionContentId, setRevisionContentId] = useState("");
	const [revisionBody, setRevisionBody] = useState("");
	const [revisionCta, setRevisionCta] = useState("");
	const [revisionClaims, setRevisionClaims] = useState("");
	const [mediaVersionId, setMediaVersionId] = useState("");
	const [mediaRightsExpiry, setMediaRightsExpiry] = useState("");
	const [mediaConsentExpiry, setMediaConsentExpiry] = useState("");
	const revisionPolicy = "selena-brand-pack/v1";
	const [bindingProjectId, setBindingProjectId] = useState("");
	const [bindingBusinessKey, setBindingBusinessKey] = useState("");
	const [bindingEnvironment, setBindingEnvironment] = useState<(typeof GROWTH_SOURCE_ENVIRONMENTS)[number]>("local");
	const [bindingRevokeReason, setBindingRevokeReason] = useState("");
	const [providerStatus, setProviderStatus] = useState<ReleaseProviderStatus | null>(null);
	const [channelAccountRef, setChannelAccountRef] = useState("");
	const [channelProviderAccountId, setChannelProviderAccountId] = useState("");
	const [policyVersion, setPolicyVersion] = useState("");
	const [policyRequireEvidence, setPolicyRequireEvidence] = useState(true);
	const [policyRevokeReason, setPolicyRevokeReason] = useState("");
	const contentById = new Map(data.content.map((item) => [item.id, item]));
	const versionById = new Map(data.versions.map((item) => [item.id, item]));
	const accountById = new Map(data.accounts.map((item) => [item.id, item]));
	const linkedInPageAccount = data.accounts.find((account) => account.platform === "linkedin_page");
	// The only contour a binding may honestly name: the one the runtime's own
	// publishing key already guards with. Nothing here can distinguish a
	// deliberate choice of environment from a mistaken one, so there is no
	// choice — an unchecked or unconfigured connection means no contour is
	// known yet, not a default one to fall back on.
	const boundEnvironment = resolveBoundEnvironment(providerStatus);
	const manifestById = new Map(data.manifests.map((item) => [item.id, item]));
	const brandStopActive = data.killSwitches.some(
		(killSwitch) => killSwitch.scope === "GLOBAL" || (killSwitch.scope === "BRAND" && killSwitch.brandId === brandId),
	);
	const materialName = (versionId: string) =>
		contentById.get(versionById.get(versionId)?.contentId ?? "")?.title ?? "Material";
	const channelName = (accountId: string) => {
		const account = accountById.get(accountId);
		return account ? displayChannel(account) : "Channel unavailable";
	};

	useEffect(() => {
		setApprovalVersionId((value) => value || data.versions[0]?.id || "");
		setReviewEvidenceVersionId((value) => value || data.versions[0]?.id || "");
		setRevisionContentId((value) => value || data.content[0]?.id || "");
		setMediaVersionId((value) => value || data.versions[0]?.id || "");
		setApprovalAccountId((value) => value || data.accounts[0]?.id || "");
		setReleaseApprovalId(
			(value) => value || data.approvals.find((approval) => approval.decision === "APPROVED")?.id || "",
		);
	}, [data.accounts, data.approvals, data.content, data.versions]);

	useEffect(() => {
		setReleaseNotBefore((value) => value || localDateTimeValue(new Date(Date.now() + 5 * 60_000)));
		setReleaseTimezone((value) => value || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
	}, []);

	useEffect(() => {
		const latestVersion = data.versions
			.filter((version) => version.contentId === revisionContentId)
			.sort((left, right) => right.version - left.version)[0];
		if (!latestVersion) return;
		setRevisionBody(latestVersion.body);
		setRevisionCta(latestVersion.ctaUrl);
		setRevisionClaims(claimsToText(latestVersion.claims));
	}, [data.versions, revisionContentId]);

	function run(action: () => Promise<unknown>, successMessage: string) {
		startTransition(async () => {
			try {
				await action();
				await router.invalidate();
				setNotice(successMessage);
			} catch {
				setNotice("The request could not be completed. Retry the action; no content was released.");
			}
		});
	}

	function checkProviderConnection() {
		startTransition(async () => {
			try {
				setProviderStatus(await getReleaseProviderStatusFn({ data: { brandId } }));
			} catch {
				setNotice("The channel connection could not be checked. Nothing was published.");
			}
		});
	}

	function submitChannelBinding(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!boundEnvironment) return;
		runShowingReason(
			() =>
				confirmChannelBindingFn({
					data: {
						accountRef: channelAccountRef.trim(),
						brandId,
						environment: boundEnvironment,
						provider: "blotato",
						providerAccountId: channelProviderAccountId.trim(),
					},
				}),
			`Channel bound: an approved release for this brand may now be carried to its provider on ${boundEnvironment}`,
		);
	}

	function revokeChannelBinding(bindingId: string) {
		runShowingReason(
			() => revokeChannelBindingFn({ data: { bindingId, brandId } }),
			"Channel binding revoked: a release can no longer be carried to that contour",
		);
	}

	function runShowingReason(action: () => Promise<unknown>, successMessage: string) {
		startTransition(async () => {
			try {
				await action();
				await router.invalidate();
				setNotice(successMessage);
			} catch (error) {
				// Unlike the release actions, these fail for reasons the owner can fix —
				// a version that already exists, a missing reason — so the reason is shown.
				const reason = error instanceof Error && error.message ? error.message : "The request could not be completed.";
				setNotice(reason);
			}
		});
	}

	function submitPolicy(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		runShowingReason(
			() =>
				setContentPolicyFn({
					data: { brandId, policyVersion: policyVersion.trim(), requireEvidence: policyRequireEvidence },
				}),
			"Content policy set: drafts for this brand are reviewed against it",
		);
	}

	function submitBinding(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		run(
			() =>
				confirmGrowthBindingFn({
					data: {
						brandId,
						aetherProjectId: bindingProjectId.trim(),
						aetherBusinessKey: bindingBusinessKey.trim(),
						sourceEnvironment: bindingEnvironment,
					},
				}),
			"Source confirmed: drafts from this Aether project will appear in the Inbox",
		);
	}

	function submitContent(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		run(
			() =>
				createControlRoomContentFn({
					data: {
						brandId,
						title: contentTitle,
						body: contentBody,
						ctaUrl: contentCta,
						claims: parseClaims(contentClaims),
						policyVersion: contentPolicy,
					},
				}),
			"Material created",
		);
	}

	function submitRevision(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		run(
			() =>
				createContentVersionFn({
					data: {
						brandId,
						contentId: revisionContentId,
						body: revisionBody,
						ctaUrl: revisionCta,
						claims: parseClaims(revisionClaims),
						policyVersion: revisionPolicy,
					},
				}),
			"New material version saved",
		);
	}

	function submitReviewEvidence(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		run(
			() =>
				addReviewEvidenceFn({
					data: {
						brandId,
						contentVersionId: reviewEvidenceVersionId,
						source: reviewEvidenceSource,
						evidenceExpiresAt: new Date(reviewEvidenceExpiry).toISOString(),
					},
				}),
			"Review source added as a new material version",
		);
	}

	function submitApproval(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		run(
			() =>
				approveContentVersionFn({
					data: {
						brandId,
						contentVersionId: approvalVersionId,
						channelAccountId: approvalAccountId,
						expiresAt: new Date(approvalExpiry).toISOString(),
					},
				}),
			"Human approval recorded",
		);
	}

	function submitReleaseIntent(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		run(
			() =>
				queueReleaseIntentFn({
					data: {
						approvalId: releaseApprovalId,
						brandId,
						notBefore: new Date(releaseNotBefore).toISOString(),
						scheduleTimezone: releaseTimezone,
					},
				}),
			"LinkedIn test is ready. Nothing will be published.",
		);
	}

	function cancelReleaseIntent(releaseIntentId: string) {
		if (
			!window.confirm(
				"Cancel this release? A provider-accepted schedule will be held for reconciliation before it is treated as cancelled.",
			)
		)
			return;
		const reason = window.prompt("Why should this release be cancelled?");
		if (!reason?.trim()) return;
		run(() => cancelReleaseIntentFn({ data: { brandId, reason, releaseIntentId } }), "Release cancellation recorded");
	}

	function changeBrandPublishing(enabled: boolean) {
		const message = enabled
			? "Stop this brand? Queued releases will be blocked immediately. A release already accepted by a provider will require reconciliation before it can be confirmed as cancelled."
			: "Resume this brand? New releases will still require a current human approval and every safety check.";
		if (!window.confirm(message)) return;
		const reason = window.prompt(enabled ? "Why are you stopping this brand?" : "Why is this brand safe to resume?");
		if (!reason?.trim()) return;
		run(
			() =>
				setReleaseKillSwitchFn({
					data: { brandId, enabled, reason, scope: "BRAND" },
				}),
			enabled ? "Brand publishing stopped" : "Brand publishing resumed",
		);
	}

	function submitMedia(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const form = new FormData(event.currentTarget);
		form.set("brandId", brandId);
		form.set("contentVersionId", mediaVersionId);
		form.set("rightsExpiresAt", new Date(mediaRightsExpiry).toISOString());
		form.set("consentExpiresAt", new Date(mediaConsentExpiry).toISOString());
		startTransition(async () => {
			try {
				const response = await fetch("/api/v1/selena/control-room/assets", { method: "POST", body: form });
				if (!response.ok) throw new Error("Media upload was not accepted");
				await router.invalidate();
				setNotice("Media uploaded. Its safety check has started.");
			} catch {
				setNotice("The media could not be uploaded. No material was released.");
			}
		});
	}

	function openAsset(assetId: string) {
		startTransition(async () => {
			try {
				const response = await fetch(
					`/api/v1/selena/control-room/assets/${assetId}?brandId=${encodeURIComponent(brandId)}`,
				);
				if (!response.ok) throw new Error("Media is not available");
				const payload = (await response.json()) as { signedUrl?: unknown };
				if (typeof payload.signedUrl !== "string") throw new Error("Media link is invalid");
				window.open(payload.signedUrl, "_blank", "noopener,noreferrer");
			} catch {
				setNotice("This media is not available to open yet.");
			}
		});
	}

	if (hasChildRoute) return <Outlet />;

	return (
		<div className="mx-auto flex w-full max-w-[1440px] flex-col gap-5">
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div>
					<p className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">Portfolio workspace</p>
					<h1 className="mt-1 text-2xl font-semibold tracking-normal">{CONTENT_PRODUCT_NAME}</h1>
				</div>
				<div className="flex items-center gap-2">
					{data.killSwitches.length > 0 && <StatusBadge value="BLOCKED" />}
					<Badge variant="outline">{data.role}</Badge>
					<Button
						variant="outline"
						size="icon"
						title={`Refresh ${CONTENT_PRODUCT_NAME}`}
						onClick={() => run(() => router.invalidate(), `${CONTENT_PRODUCT_NAME} refreshed`)}
					>
						<IconRefresh />
					</Button>
				</div>
			</div>

			{notice && <p className="border-l-2 border-primary bg-muted/40 px-3 py-2 text-sm">{notice}</p>}

			{clientConfig.contentOsStage1Enabled && (
				<div className="border-l-2 border-primary bg-muted/40 px-3 py-2 text-sm" role="status">
					<p className="font-medium">Stage 1 foundations enabled</p>
					<p className="text-muted-foreground">
						The neutral shell is active. Research, creation, OAuth and external publishing remain disabled.
					</p>
				</div>
			)}

			<div className="space-y-5">
				{activeSection === "inbox" && (
					<Card className="rounded-md shadow-none">
						<CardHeader>
							<CardTitle className="text-base">Review queue</CardTitle>
						</CardHeader>
						<CardContent>
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Content</TableHead>
										<TableHead>Source</TableHead>
										<TableHead>Version</TableHead>
										<TableHead>Asset</TableHead>
										<TableHead>Decision</TableHead>
										<TableHead>Created</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{data.reviewQueue.length === 0 ? (
										<EmptyRows columns={6} label="No content versions" />
									) : (
										data.reviewQueue.map((item) => (
											<TableRow key={item.id} data-testid="review-queue-row" data-kind={item.kind ?? "MATERIAL"}>
												<TableCell className="font-medium">
													<div className="flex flex-wrap items-center gap-2">
														<span>{item.title}</span>
														{item.kind && <Badge variant="outline">{displayMaterialKind(item.kind)}</Badge>}
													</div>
												</TableCell>
												<TableCell>
													<div className="flex flex-wrap items-center gap-2">
														<span data-testid="review-queue-source">{item.source}</span>
														{item.synthetic && <Badge variant="secondary">Synthetic</Badge>}
														{item.qaFailed && <Badge variant="destructive">QA failed</Badge>}
														{!item.qaFailed && item.needsVerification && (
															<Badge variant="outline">Needs verification</Badge>
														)}
													</div>
												</TableCell>
												<TableCell>v{item.version}</TableCell>
												<TableCell>{item.assetCount}</TableCell>
												<TableCell>
													<StatusBadge value={item.latestDecision} />
												</TableCell>
												<TableCell>{formatDate(item.createdAt)}</TableCell>
											</TableRow>
										))
									)}
								</TableBody>
							</Table>
						</CardContent>
					</Card>
				)}

				{activeSection === "content" && (
					<div className="space-y-5">
						<div className="grid gap-5 xl:grid-cols-2">
							<Card className="rounded-md shadow-none">
								<CardHeader>
									<CardTitle className="text-base">New content</CardTitle>
								</CardHeader>
								<CardContent>
									<form className="grid gap-3" onSubmit={submitContent}>
										<Label className="grid gap-2">
											Material name
											<Input
												required
												placeholder="For example, September company update"
												value={contentTitle}
												onChange={(event) => setContentTitle(event.target.value)}
											/>
										</Label>
										<Label className="grid gap-2">
											Post copy
											<Textarea
												required
												placeholder="Write the material for LinkedIn"
												value={contentBody}
												onChange={(event) => setContentBody(event.target.value)}
											/>
										</Label>
										<Label className="grid gap-2">
											Link people will open
											<Input
												required
												type="url"
												placeholder="https://example.com"
												value={contentCta}
												onChange={(event) => setContentCta(event.target.value)}
											/>
										</Label>
										<Label className="grid gap-2">
											Key points to verify
											<Textarea
												placeholder="One point per line"
												value={contentClaims}
												onChange={(event) => setContentClaims(event.target.value)}
											/>
										</Label>
										<Button disabled={pending} type="submit">
											<IconPlus />
											Create material
										</Button>
									</form>
								</CardContent>
							</Card>
							<Card className="rounded-md shadow-none">
								<CardHeader>
									<CardTitle className="text-base">New revision</CardTitle>
								</CardHeader>
								<CardContent>
									<form className="grid gap-3" onSubmit={submitRevision}>
										<Label className="grid gap-2">
											Material
											<select
												required
												className="border-input h-9 rounded-md border bg-transparent px-3 text-sm"
												value={revisionContentId}
												onChange={(event) => setRevisionContentId(event.target.value)}
											>
												<option value="" disabled>
													Select content
												</option>
												{data.content.map((item) => (
													<option value={item.id} key={item.id}>
														{item.title}
													</option>
												))}
											</select>
										</Label>
										<Label className="grid gap-2">
											Updated post copy
											<Textarea
												required
												placeholder="Write the revised material for LinkedIn"
												value={revisionBody}
												onChange={(event) => setRevisionBody(event.target.value)}
											/>
										</Label>
										<Label className="grid gap-2">
											Link people will open
											<Input
												required
												type="url"
												placeholder="https://example.com"
												value={revisionCta}
												onChange={(event) => setRevisionCta(event.target.value)}
											/>
										</Label>
										<Label className="grid gap-2">
											Key points to verify
											<Textarea
												placeholder="One point per line"
												value={revisionClaims}
												onChange={(event) => setRevisionClaims(event.target.value)}
											/>
										</Label>
										<Button disabled={pending} variant="outline" type="submit">
											<IconFileText />
											Save new version
										</Button>
									</form>
								</CardContent>
							</Card>
						</div>
						<div className="grid gap-5 xl:grid-cols-2">
							<Card className="rounded-md shadow-none">
								<CardHeader>
									<CardTitle className="text-base">LinkedIn Page connection</CardTitle>
								</CardHeader>
								<CardContent>
									<div className="flex flex-wrap items-center gap-2">
										<StatusBadge
											value={
												linkedInPageAccount?.status === "ACTIVE" && linkedInPageAccount.allowlisted
													? "READY"
													: "PENDING"
											}
										/>
										<Badge variant="outline">Nothing will be published from this screen</Badge>
									</div>
									<p className="mt-3 text-sm text-muted-foreground">
										{linkedInPageAccount
											? `${displayChannel(linkedInPageAccount)} is ready for a controlled release after approval.`
											: "Connect the configured LinkedIn Page through the controlled Postiz setup. Connection setup does not create a post."}
									</p>
								</CardContent>
							</Card>
							<Card className="rounded-md shadow-none">
								<CardHeader>
									<CardTitle className="text-base">Media</CardTitle>
								</CardHeader>
								<CardContent className="space-y-4">
									<form className="grid gap-3" onSubmit={submitMedia}>
										<Label className="grid gap-2">
											Material version
											<select
												className="h-9 rounded-md border border-input bg-background px-3 text-sm"
												required
												value={mediaVersionId}
												onChange={(event) => setMediaVersionId(event.target.value)}
											>
												<option value="" disabled>
													Select a material version
												</option>
												{data.versions.map((version) => (
													<option value={version.id} key={version.id}>
														{materialName(version.id)} — version {version.version}
													</option>
												))}
											</select>
										</Label>
										<Label className="grid gap-2">
											Image file
											<Input required name="file" type="file" accept="image/jpeg,image/png,image/webp" />
										</Label>
										<div className="grid gap-3 sm:grid-cols-2">
											<Label className="grid gap-2">
												Rights valid until
												<Input
													required
													type="datetime-local"
													value={mediaRightsExpiry}
													onChange={(event) => setMediaRightsExpiry(event.target.value)}
												/>
											</Label>
											<Label className="grid gap-2">
												Consent valid until
												<Input
													required
													type="datetime-local"
													value={mediaConsentExpiry}
													onChange={(event) => setMediaConsentExpiry(event.target.value)}
												/>
											</Label>
										</div>
										<Button disabled={pending || !mediaVersionId} type="submit">
											<IconPlus />
											Upload media for safety check
										</Button>
									</form>
									{data.assets.length > 0 && (
										<Table>
											<TableHeader>
												<TableRow>
													<TableHead>File</TableHead>
													<TableHead>Material</TableHead>
													<TableHead>Safety</TableHead>
													<TableHead>Access</TableHead>
												</TableRow>
											</TableHeader>
											<TableBody>
												{data.assets.map((asset) => (
													<TableRow key={asset.id}>
														<TableCell className="font-medium">{asset.originalFilename}</TableCell>
														<TableCell>{materialName(asset.contentVersionId)}</TableCell>
														<TableCell>
															<StatusBadge value={asset.scanStatus} />
														</TableCell>
														<TableCell>
															<Button
																disabled={asset.scanStatus !== "CLEAN"}
																onClick={() => openAsset(asset.id)}
																size="sm"
																type="button"
																variant="outline"
															>
																Open
															</Button>
														</TableCell>
													</TableRow>
												))}
											</TableBody>
										</Table>
									)}
								</CardContent>
							</Card>
						</div>
						<Card className="rounded-md shadow-none">
							<CardHeader>
								<CardTitle className="text-base">Material history</CardTitle>
							</CardHeader>
							<CardContent>
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>Material</TableHead>
											<TableHead>Version</TableHead>
											<TableHead>Review status</TableHead>
											<TableHead>Created</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{data.versions.length === 0 ? (
											<EmptyRows columns={4} label="No material versions" />
										) : (
											data.versions.map((item) => (
												<TableRow key={item.id}>
													<TableCell className="font-medium">{materialName(item.id)}</TableCell>
													<TableCell>Version {item.version}</TableCell>
													<TableCell>
														<StatusBadge value={item.evidenceExpiresAt ? "READY" : "PENDING"} />
													</TableCell>
													<TableCell>{formatDate(item.createdAt)}</TableCell>
												</TableRow>
											))
										)}
									</TableBody>
								</Table>
							</CardContent>
						</Card>
					</div>
				)}

				{activeSection === "review" && (
					<div className="space-y-5">
						<Card className="rounded-md shadow-none">
							<CardHeader>
								<CardTitle className="text-base">Review source</CardTitle>
							</CardHeader>
							<CardContent className="space-y-3">
								<p className="text-sm text-muted-foreground">
									Add a verified source only when this material is ready for approval. This creates a new version so the
									reviewed material cannot change afterward.
								</p>
								<form className="grid gap-3 md:grid-cols-[1fr_1fr_1fr_auto]" onSubmit={submitReviewEvidence}>
									<select
										required
										className="border-input h-9 rounded-md border bg-transparent px-3 text-sm"
										value={reviewEvidenceVersionId}
										onChange={(event) => setReviewEvidenceVersionId(event.target.value)}
									>
										<option value="" disabled>
											Material version
										</option>
										{data.versions.map((item) => (
											<option value={item.id} key={item.id}>
												{materialName(item.id)} · Version {item.version}
											</option>
										))}
									</select>
									<Input
										required
										type="url"
										placeholder="Verified source link"
										value={reviewEvidenceSource}
										onChange={(event) => setReviewEvidenceSource(event.target.value)}
									/>
									<Input
										required
										type="datetime-local"
										value={reviewEvidenceExpiry}
										onChange={(event) => setReviewEvidenceExpiry(event.target.value)}
									/>
									<Button disabled={pending || !reviewEvidenceVersionId} type="submit">
										<IconFileText />
										Create review version
									</Button>
								</form>
							</CardContent>
						</Card>
						<Card className="rounded-md shadow-none">
							<CardHeader>
								<CardTitle className="text-base">Human approval</CardTitle>
							</CardHeader>
							<CardContent>
								<form className="grid gap-3 md:grid-cols-[1fr_1fr_1fr_auto]" onSubmit={submitApproval}>
									<select
										required
										className="border-input h-9 rounded-md border bg-transparent px-3 text-sm"
										value={approvalVersionId}
										onChange={(event) => setApprovalVersionId(event.target.value)}
									>
										<option value="" disabled>
											Content version
										</option>
										{data.versions.map((item) => (
											<option value={item.id} key={item.id}>
												{materialName(item.id)} · Version {item.version}
											</option>
										))}
									</select>
									<select
										required
										className="border-input h-9 rounded-md border bg-transparent px-3 text-sm"
										value={approvalAccountId}
										onChange={(event) => setApprovalAccountId(event.target.value)}
									>
										<option value="" disabled>
											LinkedIn account
										</option>
										{data.accounts.map((item) => (
											<option value={item.id} key={item.id}>
												{displayChannel(item)}
											</option>
										))}
									</select>
									<Input
										required
										type="datetime-local"
										value={approvalExpiry}
										onChange={(event) => setApprovalExpiry(event.target.value)}
									/>
									<Button disabled={pending} type="submit">
										<IconLockCheck />
										Approve
									</Button>
								</form>
							</CardContent>
						</Card>
						<Card className="rounded-md shadow-none">
							<CardHeader>
								<CardTitle className="text-base">Approval records</CardTitle>
							</CardHeader>
							<CardContent>
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>Material</TableHead>
											<TableHead>Channel</TableHead>
											<TableHead>Valid until</TableHead>
											<TableHead>Status</TableHead>
											<TableHead>Action</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{data.approvals.length === 0 ? (
											<EmptyRows columns={5} label="No approvals yet" />
										) : (
											data.approvals.map((item) => (
												<TableRow key={item.id}>
													<TableCell className="font-medium">{materialName(item.contentVersionId)}</TableCell>
													<TableCell>{channelName(item.channelAccountId)}</TableCell>
													<TableCell>{formatDate(item.expiresAt)}</TableCell>
													<TableCell>
														<StatusBadge value={item.decision} />
													</TableCell>
													<TableCell>
														{item.decision === "APPROVED" ? (
															<Button
																size="sm"
																variant="outline"
																disabled={pending}
																onClick={() =>
																	run(
																		() =>
																			revokeApprovalFn({
																				data: { brandId, approvalId: item.id, reason: "Revoked from Control Room" },
																			}),
																		"Approval revoked",
																	)
																}
															>
																Revoke
															</Button>
														) : (
															"-"
														)}
													</TableCell>
												</TableRow>
											))
										)}
									</TableBody>
								</Table>
							</CardContent>
						</Card>
					</div>
				)}

				{activeSection === "releases" && (
					<div className="space-y-5">
						<div className="grid gap-5 xl:grid-cols-2">
							<Card className="rounded-md shadow-none">
								<CardHeader>
									<CardTitle className="text-base">Release queue</CardTitle>
								</CardHeader>
								<CardContent>
									<form className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" onSubmit={submitReleaseIntent}>
										<select
											required
											className="border-input h-9 min-w-0 flex-1 rounded-md border bg-transparent px-3 text-sm"
											value={releaseApprovalId}
											onChange={(event) => setReleaseApprovalId(event.target.value)}
										>
											<option value="" disabled>
												Approved version
											</option>
											{data.approvals
												.filter((approval) => approval.decision === "APPROVED")
												.map((approval) => (
													<option value={approval.id} key={approval.id}>
														{materialName(approval.contentVersionId)} - {channelName(approval.channelAccountId)}
													</option>
												))}
										</select>
										<Label className="grid gap-2">
											Scheduled time
											<Input
												required
												type="datetime-local"
												value={releaseNotBefore}
												onChange={(event) => setReleaseNotBefore(event.target.value)}
											/>
										</Label>
										<Label className="grid gap-2">
											Time zone
											<Input
												required
												placeholder="Asia/Makassar"
												value={releaseTimezone}
												onChange={(event) => setReleaseTimezone(event.target.value)}
											/>
										</Label>
										<Button
											className="self-end"
											disabled={pending || !releaseApprovalId || !releaseNotBefore || !releaseTimezone}
											type="submit"
										>
											{data.stagingMvp ? "Prepare LinkedIn test" : "Prepare release"}
										</Button>
									</form>
								</CardContent>
							</Card>
							<Card className="rounded-md shadow-none">
								<CardHeader>
									<CardTitle className="text-base">Publishing safety</CardTitle>
								</CardHeader>
								<CardContent className="space-y-3">
									<p className="text-sm text-muted-foreground">
										{data.stagingMvp
											? "This test stops after a queued internal record. It cannot send or publish anything."
											: "Publishing stays unavailable until the separate safety service is deployed."}
									</p>
									<div className="flex flex-wrap items-center gap-2">
										<StatusBadge value={brandStopActive ? "BLOCKED" : "READY"} />
										<Button
											disabled={pending}
											onClick={() => changeBrandPublishing(!brandStopActive)}
											type="button"
											variant={brandStopActive ? "outline" : "destructive"}
										>
											<IconAlertTriangle />
											{brandStopActive ? "Resume brand" : "Stop brand"}
										</Button>
									</div>
								</CardContent>
							</Card>
						</div>
						<Card className="rounded-md shadow-none">
							<CardHeader>
								<CardTitle className="text-base">Planned releases</CardTitle>
							</CardHeader>
							<CardContent>
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>Material</TableHead>
											<TableHead>Channel</TableHead>
											<TableHead>Scheduled</TableHead>
											<TableHead>Status</TableHead>
											<TableHead>Action</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{data.releaseIntents.length === 0 ? (
											<EmptyRows columns={5} label="No releases are planned" />
										) : (
											data.releaseIntents.map((intent) => {
												const outbox = data.outboxEvents.find((event) => event.releaseIntentId === intent.id);
												return (
													<TableRow key={intent.id}>
														<TableCell className="font-medium">{materialName(intent.contentVersionId)}</TableCell>
														<TableCell>{channelName(intent.channelAccountId)}</TableCell>
														<TableCell>
															{formatDate(intent.notBefore)} {intent.scheduleTimezone}
														</TableCell>
														<TableCell className="space-x-2">
															<StatusBadge value={intent.status} />
															{outbox && <StatusBadge value={outbox.status} />}
														</TableCell>
														<TableCell>
															{["QUEUED", "DISPATCHING", "SUCCEEDED", "UNKNOWN"].includes(intent.status) ? (
																<Button
																	disabled={pending}
																	onClick={() => cancelReleaseIntent(intent.id)}
																	size="sm"
																	type="button"
																	variant="outline"
																>
																	Cancel
																</Button>
															) : (
																"-"
															)}
														</TableCell>
													</TableRow>
												);
											})
										)}
									</TableBody>
								</Table>
							</CardContent>
						</Card>
						<Card className="rounded-md shadow-none">
							<CardHeader>
								<CardTitle className="text-base">Sending checks</CardTitle>
							</CardHeader>
							<CardContent>
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>Material</TableHead>
											<TableHead>Channel</TableHead>
											<TableHead>Valid until</TableHead>
											<TableHead>Status</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{data.manifests.length === 0 ? (
											<EmptyRows columns={4} label="No sending checks yet" />
										) : (
											data.manifests.map((item) => (
												<TableRow key={item.id}>
													<TableCell className="font-medium">{materialName(item.contentVersionId)}</TableCell>
													<TableCell>{channelName(item.channelAccountId)}</TableCell>
													<TableCell>{formatDate(item.expiresAt)}</TableCell>
													<TableCell>
														<StatusBadge value={item.status} />
													</TableCell>
												</TableRow>
											))
										)}
									</TableBody>
								</Table>
							</CardContent>
						</Card>
					</div>
				)}

				{activeSection === "publications" && (
					<div className="space-y-4">
						{data.role === "owner" && (
							<Card className="rounded-md shadow-none">
								<CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
									<CardTitle className="text-base">Channel connection</CardTitle>
									<Button disabled={pending} onClick={checkProviderConnection} size="sm" variant="outline">
										<IconRefresh className="size-4" />
										Check connection
									</Button>
								</CardHeader>
								<CardContent className="space-y-2 text-sm">
									{providerStatus === null ? (
										<p className="text-muted-foreground">
											Check which account this workspace's publishing key can see. The check only reads the account; it
											cannot publish.
										</p>
									) : providerStatus.state === "NOT_CONFIGURED" ? (
										<p className="text-muted-foreground">
											No publishing key is configured here, so nothing can be sent. Missing:{" "}
											{providerStatus.missing.join(", ")}.
										</p>
									) : (
										<>
											<div className="flex flex-wrap items-center gap-2">
												<StatusBadge value={providerStatus.state} />
												<span className="text-muted-foreground">
													{providerStatus.providerId} · {providerStatus.environment}
												</span>
											</div>
											{providerStatus.account && (
												<p className="font-medium">
													{providerStatus.account.accountRef} ({providerStatus.account.platform})
												</p>
											)}
											{providerStatus.reason && <p className="text-muted-foreground">{providerStatus.reason}</p>}
										</>
									)}
								</CardContent>
							</Card>
						)}
						{data.role === "owner" && (
							<Card className="rounded-md shadow-none">
								<CardHeader>
									<CardTitle className="text-base">Bind a channel</CardTitle>
								</CardHeader>
								<CardContent>
									<form className="grid gap-3" onSubmit={submitChannelBinding}>
										<Label className="grid gap-2">
											Channel name
											<Input
												required
												placeholder="Selena LinkedIn Page"
												value={channelAccountRef}
												onChange={(event) => setChannelAccountRef(event.target.value)}
											/>
										</Label>
										<Label className="grid gap-2">
											Account id at the provider
											<Input
												required
												placeholder="the LinkedIn account as Blotato numbers it"
												value={channelProviderAccountId}
												onChange={(event) => setChannelProviderAccountId(event.target.value)}
											/>
										</Label>
										<div className="grid gap-2 text-sm">
											<span className="font-medium">Contour this binding will target</span>
											{boundEnvironment ? (
												<div className="flex items-center gap-2">
													<StatusBadge value={boundEnvironment} />
													<span className="text-xs text-muted-foreground">
														what this workspace's publishing key already reports itself as
													</span>
												</div>
											) : (
												<p className="text-xs text-muted-foreground">
													Unknown until the connection above is checked. A binding can only ever name the contour the
													runtime already is — there is nothing here to choose.
												</p>
											)}
										</div>
										<p className="text-xs text-muted-foreground">
											Binding a channel says where an approved release may land, not that it will be sent: only a
											contour matching this line can reach the provider at all, and the release policy still has to
											agree. Only an owner can bind, and the act is recorded in the audit log.
										</p>
										<Button disabled={pending || !boundEnvironment} type="submit">
											<IconLockCheck className="size-4" />
											Bind channel
										</Button>
									</form>
								</CardContent>
							</Card>
						)}
						{data.role === "owner" && (
							<Card className="rounded-md shadow-none">
								<CardHeader>
									<CardTitle className="text-base">Channel bindings</CardTitle>
								</CardHeader>
								<CardContent>
									<Table>
										<TableHeader>
											<TableRow>
												<TableHead>Channel</TableHead>
												<TableHead>Provider</TableHead>
												<TableHead>Contour</TableHead>
												<TableHead>Status</TableHead>
												<TableHead>Bound</TableHead>
												<TableHead />
											</TableRow>
										</TableHeader>
										<TableBody>
											{data.channelBindings.length === 0 ? (
												<EmptyRows columns={6} label="No channel has been bound yet" />
											) : (
												data.channelBindings.map((binding) => (
													<TableRow key={binding.id}>
														<TableCell className="font-medium">{channelName(binding.channelAccountId)}</TableCell>
														<TableCell>{binding.provider}</TableCell>
														<TableCell>
															<StatusBadge value={binding.environment} />
														</TableCell>
														<TableCell>
															<StatusBadge value={binding.active ? "ACTIVE" : "REVOKED"} />
														</TableCell>
														<TableCell>{formatDate(binding.createdAt)}</TableCell>
														<TableCell>
															{binding.active && (
																<Button
																	disabled={pending}
																	onClick={() => revokeChannelBinding(binding.id)}
																	size="sm"
																	variant="outline"
																>
																	Revoke
																</Button>
															)}
														</TableCell>
													</TableRow>
												))
											)}
										</TableBody>
									</Table>
								</CardContent>
							</Card>
						)}
						<Card className="rounded-md shadow-none">
							<CardHeader>
								<CardTitle className="text-base">Publishing activity</CardTitle>
							</CardHeader>
							<CardContent>
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>Material</TableHead>
											<TableHead>Channel</TableHead>
											<TableHead>Latest update</TableHead>
											<TableHead>Status</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{data.publications.length === 0 ? (
											<EmptyRows columns={4} label="Nothing has been published" />
										) : (
											data.publications.map((item) => (
												<TableRow key={item.id}>
													<TableCell className="font-medium">
														{materialName(manifestById.get(item.releaseManifestId)?.contentVersionId ?? "")}
													</TableCell>
													<TableCell>{channelName(item.channelAccountId)}</TableCell>
													<TableCell>{formatDate(item.updatedAt)}</TableCell>
													<TableCell>
														<StatusBadge value={item.status} />
													</TableCell>
												</TableRow>
											))
										)}
									</TableBody>
								</Table>
							</CardContent>
						</Card>
					</div>
				)}

				{activeSection === "performance" && (
					<Card className="rounded-md shadow-none">
						<CardHeader>
							<CardTitle className="text-base">Performance data</CardTitle>
						</CardHeader>
						<CardContent>
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Data quality</TableHead>
										<TableHead>Observed</TableHead>
										<TableHead>Data through</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{data.metrics.length === 0 ? (
										<EmptyRows columns={3} label="No performance data yet" />
									) : (
										data.metrics.map((item) => (
											<TableRow key={item.id}>
												<TableCell>
													<StatusBadge value={item.quality} />
												</TableCell>
												<TableCell>{formatDate(item.observedAt)}</TableCell>
												<TableCell>{formatDate(item.dataCutoffAt)}</TableCell>
											</TableRow>
										))
									)}
								</TableBody>
							</Table>
						</CardContent>
					</Card>
				)}

				{activeSection === "incidents" && (
					<Card className="rounded-md shadow-none">
						<CardHeader>
							<CardTitle className="text-base">Incidents</CardTitle>
						</CardHeader>
						<CardContent>
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Severity</TableHead>
										<TableHead>What happened</TableHead>
										<TableHead>Status</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{data.incidents.length === 0 ? (
										<EmptyRows columns={3} label="No incidents" />
									) : (
										data.incidents.map((item) => (
											<TableRow key={item.id}>
												<TableCell>{item.severity}</TableCell>
												<TableCell>{item.summary}</TableCell>
												<TableCell>
													<StatusBadge value={item.status} />
												</TableCell>
											</TableRow>
										))
									)}
								</TableBody>
							</Table>
						</CardContent>
					</Card>
				)}

				{activeSection === "audit" && (
					<Card className="rounded-md shadow-none">
						<CardHeader>
							<CardTitle className="text-base">Activity log</CardTitle>
						</CardHeader>
						<CardContent>
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>What happened</TableHead>
										<TableHead>Time</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{data.audits.length === 0 ? (
										<EmptyRows columns={2} label="No activity yet" />
									) : (
										data.audits.map((item) => (
											<TableRow key={item.id}>
												<TableCell>{displayAuditAction(item.action)}</TableCell>
												<TableCell>{formatDate(item.createdAt)}</TableCell>
											</TableRow>
										))
									)}
								</TableBody>
							</Table>
						</CardContent>
					</Card>
				)}

				{activeSection === "sources" && (
					<div className="grid gap-5 xl:grid-cols-2">
						<Card className="rounded-md shadow-none">
							<CardHeader>
								<CardTitle className="text-base">Content policy</CardTitle>
							</CardHeader>
							<CardContent className="space-y-3 text-sm">
								<p className="text-muted-foreground">
									The policy is what drafts for this brand are reviewed against. One version is in force at a time;
									setting a new one withdraws the previous version and keeps it, so an approval made earlier still names
									the policy it was made under. A policy is not an approval and releases nothing by itself.
								</p>
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>Version</TableHead>
											<TableHead>Evidence required</TableHead>
											<TableHead>Status</TableHead>
											<TableHead>In force since</TableHead>
											<TableHead />
										</TableRow>
									</TableHeader>
									<TableBody>
										{data.contentPolicies.length === 0 ? (
											<EmptyRows columns={5} label="No policy has been set" />
										) : (
											data.contentPolicies.map((policy) => (
												<TableRow key={policy.id} data-testid="content-policy-row">
													<TableCell className="font-mono text-xs">{policy.policyVersion}</TableCell>
													<TableCell>{policy.requireEvidence ? "Yes" : "No"}</TableCell>
													<TableCell>
														<StatusBadge value={policy.status === "active" ? "IN FORCE" : "WITHDRAWN"} />
													</TableCell>
													<TableCell>{formatDate(policy.activatedAt)}</TableCell>
													<TableCell>
														{policy.status === "active" && data.role === "owner" && (
															<Button
																variant="outline"
																size="sm"
																disabled={pending || policyRevokeReason.trim().length === 0}
																title={policyRevokeReason.trim() ? "Withdraw this policy" : "Write a reason first"}
																onClick={() =>
																	runShowingReason(
																		() =>
																			revokeContentPolicyFn({
																				data: { brandId, policyId: policy.id, reason: policyRevokeReason.trim() },
																			}),
																		"Policy withdrawn: this brand has no policy in force",
																	)
																}
															>
																Withdraw
															</Button>
														)}
													</TableCell>
												</TableRow>
											))
										)}
									</TableBody>
								</Table>
								{data.role === "owner" && data.activeContentPolicy && (
									<Label className="grid gap-2">
										Reason for withdrawing
										<Input
											placeholder="Why this policy should stop applying"
											value={policyRevokeReason}
											onChange={(event) => setPolicyRevokeReason(event.target.value)}
										/>
									</Label>
								)}
								{data.role === "owner" && (
									<form className="grid gap-3 border-t pt-3" onSubmit={submitPolicy}>
										<Label className="grid gap-2">
											New policy version
											<Input
												required
												placeholder="2026-09-a"
												value={policyVersion}
												onChange={(event) => setPolicyVersion(event.target.value)}
											/>
										</Label>
										<Label className="flex items-center gap-2">
											<input
												type="checkbox"
												className="size-4"
												checked={policyRequireEvidence}
												onChange={(event) => setPolicyRequireEvidence(event.target.checked)}
											/>
											Require evidence for every claim
										</Label>
										<p className="text-xs text-muted-foreground">
											A version name is a label you choose, not a document: it identifies which rules were in force.
											Repeating the version already in force changes nothing. A withdrawn version is never reinstated —
											use a new name.
										</p>
										<Button disabled={pending} type="submit">
											<IconLockCheck />
											Set policy
										</Button>
									</form>
								)}
							</CardContent>
						</Card>
						<Card className="rounded-md shadow-none">
							<CardHeader>
								<CardTitle className="text-base">Aether sources</CardTitle>
							</CardHeader>
							<CardContent className="space-y-3 text-sm">
								{!clientConfig.growthEngineStage1Enabled && (
									<p className="text-muted-foreground">
										Growth sources are switched off in this deployment. Nothing is delivered from Aether.
									</p>
								)}
								<p className="text-muted-foreground">
									A source is one Aether project, from one environment, whose drafts may appear in this brand's Inbox as
									materials to review. Confirming a source never approves or releases anything; every draft still goes
									through review here.
								</p>
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>Aether project</TableHead>
											<TableHead>Business key</TableHead>
											<TableHead>Environment</TableHead>
											<TableHead>Status</TableHead>
											<TableHead>Confirmed</TableHead>
											<TableHead />
										</TableRow>
									</TableHeader>
									<TableBody>
										{data.growthBindings.length === 0 ? (
											<EmptyRows columns={6} label="No sources confirmed" />
										) : (
											data.growthBindings.map((binding) => (
												<TableRow key={binding.id} data-testid="growth-binding-row">
													<TableCell className="font-mono text-xs">{binding.aetherProjectId}</TableCell>
													<TableCell>{binding.aetherBusinessKey}</TableCell>
													<TableCell>{binding.sourceEnvironment}</TableCell>
													<TableCell>
														<StatusBadge value={binding.revokedAt ? "REVOKED" : "CONFIRMED"} />
													</TableCell>
													<TableCell>{formatDate(binding.confirmedAt)}</TableCell>
													<TableCell>
														{!binding.revokedAt && data.role === "owner" && (
															<Button
																variant="outline"
																size="sm"
																disabled={pending || bindingRevokeReason.trim().length === 0}
																title={bindingRevokeReason.trim() ? "Revoke this source" : "Write a reason first"}
																onClick={() =>
																	run(
																		() =>
																			revokeGrowthBindingFn({
																				data: { brandId, bindingId: binding.id, reason: bindingRevokeReason.trim() },
																			}),
																		"Source revoked: new drafts from this project are refused",
																	)
																}
															>
																Revoke
															</Button>
														)}
													</TableCell>
												</TableRow>
											))
										)}
									</TableBody>
								</Table>
								{data.role === "owner" && data.growthBindings.some((binding) => !binding.revokedAt) && (
									<Label className="grid gap-2">
										Reason for revoking
										<Input
											placeholder="Why this source should stop delivering"
											value={bindingRevokeReason}
											onChange={(event) => setBindingRevokeReason(event.target.value)}
										/>
									</Label>
								)}
							</CardContent>
						</Card>
						{data.role === "owner" && clientConfig.growthEngineStage1Enabled && (
							<Card className="rounded-md shadow-none">
								<CardHeader>
									<CardTitle className="text-base">Confirm a source</CardTitle>
								</CardHeader>
								<CardContent>
									<form className="grid gap-3" onSubmit={submitBinding}>
										<Label className="grid gap-2">
											Aether project id
											<Input
												required
												placeholder="00000000-0000-0000-0000-000000000000"
												value={bindingProjectId}
												onChange={(event) => setBindingProjectId(event.target.value)}
											/>
										</Label>
										<Label className="grid gap-2">
											Business key the project reports
											<Input
												required
												placeholder="selena"
												value={bindingBusinessKey}
												onChange={(event) => setBindingBusinessKey(event.target.value)}
											/>
										</Label>
										<Label className="grid gap-2">
											Environment the drafts come from
											<select
												className="h-9 rounded-md border border-input bg-background px-3 text-sm"
												value={bindingEnvironment}
												onChange={(event) =>
													setBindingEnvironment(event.target.value as (typeof GROWTH_SOURCE_ENVIRONMENTS)[number])
												}
											>
												{GROWTH_SOURCE_ENVIRONMENTS.map((environment) => (
													<option key={environment} value={environment}>
														{environment}
													</option>
												))}
											</select>
										</Label>
										<p className="text-xs text-muted-foreground">
											The business key is only checked against what the project reports; it does not choose the brand.
											Only an owner can confirm, and the confirmation is recorded in the audit log.
										</p>
										<Button disabled={pending} type="submit">
											<IconLockCheck />
											Confirm source
										</Button>
									</form>
								</CardContent>
							</Card>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
